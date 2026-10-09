package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

const nativeSchema = `
CREATE TABLE IF NOT EXISTS native_usage (
 id TEXT PRIMARY KEY, client TEXT NOT NULL, at INTEGER NOT NULL,
 route TEXT NOT NULL, event TEXT NOT NULL, usd REAL, basis TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS native_usage_time ON native_usage(at);
CREATE TABLE IF NOT EXISTS native_cursors (
 client TEXT NOT NULL, pathHash TEXT NOT NULL, cursor TEXT NOT NULL,
 PRIMARY KEY(client,pathHash));`

// nativeSettledSchema is created by the settlement transaction itself, so a
// history too full for it is left unchanged.
const nativeSettledSchema = `CREATE TABLE IF NOT EXISTS native_settled (
 id TEXT PRIMARY KEY, client TEXT NOT NULL, at INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
 input INTEGER NOT NULL, output INTEGER NOT NULL, cacheRead INTEGER NOT NULL, usd REAL, basis TEXT NOT NULL) WITHOUT ROWID;`

// NativeSettledKey records when Claude Code transcripts stopped adding to costs.
// OCX's usage log is the cost record from then on. The transcript rows counted
// until then were copied once into native_settled, keeping only what costs read
// (time, provider, model, tokens, stored amount and basis), so past periods keep
// the totals they showed: a transcript row that changes, arrives late or is
// read again afterwards never reaches the totals.
const NativeSettledKey = "nativeCostsSettledAt"

// NativeNotValued is the basis of a Claude Code transcript row collected after
// the settlement: collection keeps its tokens and route, and computes no price.
const NativeNotValued = "not-valued"

type NativeSummary struct {
	// Included counts the rows in costs; for Claude Code, the settled rows.
	Included         int            `json:"includedRequests"`
	Pending          int            `json:"pendingRequests"`
	Proxy            int            `json:"proxyRequests"`
	Conflicts        int            `json:"conflictRequests"`
	PendingUSD       *float64       `json:"pendingApiUsd"`
	Unpriced         int            `json:"unpricedRequests"`
	ProxyByEvidence  map[string]int `json:"proxyByEvidence"`
	PendingByReason  map[string]int `json:"pendingByReason"`
	ConflictByReason map[string]int `json:"conflictByReason"`
	// Claude Code only. SettledAt is when its transcript costs were settled.
	// Unsettled direct rows carry an Anthropic request ID (req_) but were not
	// settled: they are reported, never added to costs. Past ones are dated
	// before SettledAt (read late), new ones at or after it. Each row counts
	// once by its stable ID however often it is read.
	SettledAt                     *string `json:"costsSettledAt,omitempty"`
	UnsettledDirectPast           int     `json:"unsettledDirectPastRequests"`
	UnsettledDirectNew            int     `json:"unsettledDirectNewRequests"`
	UnsettledDirectFirst          *string `json:"unsettledDirectFirstAt,omitempty"`
	UnsettledDirectLast           *string `json:"unsettledDirectLastAt,omitempty"`
	unsettledFirst, unsettledLast int64
}

// Complete returns s with every breakdown present, so none encodes as null.
func (s NativeSummary) Complete() NativeSummary {
	for _, m := range []*map[string]int{&s.ProxyByEvidence, &s.PendingByReason, &s.ConflictByReason} {
		if *m == nil {
			*m = map[string]int{}
		}
	}
	return s
}

type NativeView struct {
	Rows         []Usage
	Summary      map[string]NativeSummary
	ClaudePolicy *ClaudeRoutePolicy
	// Excluded lists the pending and conflicting candidates of a client whose
	// transcripts still add to costs (Antigravity), so a cost period can say how
	// many it left out. Claude Code transcripts no longer add to costs.
	Excluded []NativeExcluded
}

type NativeExcluded struct {
	Client string
	At     int64
}

// ClaudeRoutePolicy is the operator's statement that, from From until Until
// (exclusive, nil = open), every direct Claude Code call carried a req_ request
// ID, so a record without any request ID was answered by OCX.
type ClaudeRoutePolicy struct {
	From  int64
	Until *int64
}

const ClaudeRoutePolicyKey = "claudeRoutePolicy"

func (h *History) claudeRoutePolicy() *ClaudeRoutePolicy {
	v, _ := h.Meta(ClaudeRoutePolicyKey)
	m, ok := v.(map[string]any)
	if !ok || m["route"] != "ocx" || m["basis"] != "operator-cutover" {
		return nil
	}
	from, ok := m["from"].(float64)
	if !ok {
		return nil
	}
	p := &ClaudeRoutePolicy{From: int64(from)}
	if until, ok := m["until"].(float64); ok {
		u := int64(until)
		if u <= p.From {
			return nil
		}
		p.Until = &u
	} else if m["until"] != nil {
		return nil
	}
	return p
}

func (p *ClaudeRoutePolicy) covers(client, evidence string, at int64) bool {
	return p != nil && client == "claude" && evidence == "request-id-absent" && at >= p.From && (p.Until == nil || at < *p.Until)
}

func (h *History) NativeCursors(client string) (map[string]nativeusage.Cursor, error) {
	if client == "claude" {
		if err := h.rereadUnverifiedClaude(); err != nil {
			return nil, err
		}
	}
	rows, err := h.db.Query(`SELECT pathHash,cursor FROM native_cursors WHERE client=?`, client)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]nativeusage.Cursor{}
	for rows.Next() {
		var key, raw string
		if err = rows.Scan(&key, &raw); err != nil {
			return nil, err
		}
		var c nativeusage.Cursor
		if err = json.Unmarshal([]byte(raw), &c); err != nil {
			return nil, err
		}
		out[key] = c
	}
	return out, rows.Err()
}

const claudeEvidenceKey = "nativeEvidenceV2:claude"

// Parser revision 1 stored "route-unverified" for both an absent and an
// unrecognized Claude request ID, and did not recognize OCX model aliases.
// Only the source lines can tell them apart. Instead of a parser revision
// (which rereads every transcript), files last seen changing within an hour
// before the earliest such row are reread once through the normal cursor path.
// Older files cannot contain those records.
func (h *History) rereadUnverifiedClaude() error {
	if _, ok := h.Meta(claudeEvidenceKey); ok {
		return nil
	}
	return h.transact(func(tx *sql.Tx) error {
		var threshold sql.NullInt64
		err := tx.QueryRow(`SELECT MIN(at) FROM native_usage WHERE client='claude' AND route='unknown' AND json_extract(event,'$.Evidence')='route-unverified'`).Scan(&threshold)
		if err != nil {
			return err
		}
		reset := 0
		if threshold.Valid {
			rows, err := tx.Query(`SELECT pathHash,cursor FROM native_cursors WHERE client='claude'`)
			if err != nil {
				return err
			}
			updates := map[string]string{}
			for rows.Next() {
				var key, raw string
				if err = rows.Scan(&key, &raw); err != nil {
					rows.Close()
					return err
				}
				var c nativeusage.Cursor
				if err = json.Unmarshal([]byte(raw), &c); err != nil {
					rows.Close()
					return err
				}
				if c.MTime < (threshold.Int64-3600000)*1e6 {
					continue
				}
				c.Revision = 0
				encoded, err := json.Marshal(c)
				if err != nil {
					rows.Close()
					return err
				}
				updates[key] = string(encoded)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
			for key, raw := range updates {
				if _, err = tx.Exec(`UPDATE native_cursors SET cursor=? WHERE client='claude' AND pathHash=?`, raw, key); err != nil {
					return err
				}
			}
			reset = len(updates)
		}
		encoded, err := contract.MarshalCanonical(map[string]any{"resetCursors": reset})
		if err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT OR REPLACE INTO meta VALUES(?,?)`, claudeEvidenceKey, string(encoded))
		return err
	})
}

func (h *History) NativeCutoff(now int64) int64 {
	cutoff := now - int64(h.retentionDays)*86400000
	for _, key := range []string{"historyResetAt", "usageExcludedBefore"} {
		if v, ok := h.Meta(key); ok {
			if n, ok := v.(float64); ok && int64(n) > cutoff {
				cutoff = int64(n)
			}
		}
	}
	return cutoff
}

// settleNativeCosts copies, once, the Claude Code transcript rows that costs
// counted (direct route, valued by an earlier release) into native_settled and
// records when, in one transaction. A history too full for the copy is left
// unchanged and the error says how to make room, so opening fails rather than
// running without the settled totals.
func (h *History) settleNativeCosts(now int64) error {
	err := h.transact(func(tx *sql.Tx) error {
		var prior string
		err := tx.QueryRow("SELECT value FROM meta WHERE key=?", NativeSettledKey).Scan(&prior)
		if err != sql.ErrNoRows {
			return err
		}
		if _, err := tx.Exec(nativeSettledSchema); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO native_settled SELECT id,client,at,
		 COALESCE(json_extract(event,'$.Provider'),''),COALESCE(json_extract(event,'$.Model'),''),
		 COALESCE(json_extract(event,'$.Input'),0),COALESCE(json_extract(event,'$.Output'),0),COALESCE(json_extract(event,'$.CacheRead'),0),usd,basis
		 FROM native_usage WHERE client='claude' AND route=? AND basis<>?`, string(nativeusage.Direct), NativeNotValued); err != nil {
			return err
		}
		_, err = tx.Exec("INSERT INTO meta VALUES (?,?)", NativeSettledKey, strconv.FormatInt(now, 10))
		return err
	})
	var e *sqlite.Error
	if errors.As(err, &e) && e.Code()&0xff == sqlite3.SQLITE_FULL {
		return fmt.Errorf("settling Claude Code transcript costs needs more room than the history size limit allows; raise QUOTA_DB_MAX_MIB or archive history, then start again (nothing was changed): %w", err)
	}
	return err
}

// CommitNative atomically persists parser progress and normalized candidates.
// The legacy OCX usage table is never written by this path. A source failure
// therefore cannot change OCX accounting or calibration, including on rollback.
func (h *History) CommitNative(client string, b nativeusage.Batch, now int64) error {
	catalog, _ := h.catalogForIngest()
	cutoff := h.NativeCutoff(now)
	changed := false
	err := h.transact(func(tx *sql.Tx) error {
		evidence, err := listEvidence(tx)
		if err != nil {
			return err
		}
		for _, incoming := range b.Events {
			if incoming.Client != client || !incoming.Valid() {
				return fmt.Errorf("invalid native usage")
			}
			if incoming.At < cutoff || incoming.At > now+60000 {
				continue
			}
			var raw string
			var priorUSD *float64
			var priorBasis string
			err := tx.QueryRow(`SELECT event,usd,basis FROM native_usage WHERE id=?`, incoming.ID).Scan(&raw, &priorUSD, &priorBasis)
			if err != nil && err != sql.ErrNoRows {
				return err
			}
			stored := err == nil
			e := incoming
			if err == nil {
				var old nativeusage.Event
				if err = json.Unmarshal([]byte(raw), &old); err != nil {
					return err
				}
				e = mergeNative(old, incoming)
				if reflect.DeepEqual(old, e) && priorUSD != nil {
					continue
				}
			}
			var q ingestQuote
			switch {
			case client != "claude":
				q = quoteNative(e, evidence, catalog)
			case stored:
				// Claude Code transcripts are no longer valued: a row read again
				// keeps the amount stored for it, deleting nothing.
				q = ingestQuote{usd: priorUSD, basis: priorBasis}
			default:
				q = ingestQuote{basis: NativeNotValued}
			}
			encoded, err := json.Marshal(e)
			if err != nil {
				return err
			}
			if string(encoded) == raw && equalFloat(priorUSD, q.usd) && priorBasis == q.basis {
				continue
			}
			_, err = tx.Exec(`INSERT INTO native_usage(id,client,at,route,event,usd,basis) VALUES(?,?,?,?,?,?,?)
			 ON CONFLICT(id) DO UPDATE SET at=excluded.at,route=excluded.route,event=excluded.event,usd=excluded.usd,basis=excluded.basis`, e.ID, e.Client, e.At, string(e.Route), string(encoded), q.usd, q.basis)
			if err != nil {
				return err
			}
			changed = true
		}
		for key, c := range b.Cursors {
			encoded, err := json.Marshal(c)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(`INSERT INTO native_cursors VALUES(?,?,?) ON CONFLICT(client,pathHash) DO UPDATE SET cursor=excluded.cursor`, client, key, string(encoded)); err != nil {
				return err
			}
		}
		// Revisit a bounded page of unknown prices independently of file
		// cursors: a later catalog must not require rereading gigabytes of logs.
		// Claude Code transcripts are not valued any more.
		if client == "claude" {
			return nil
		}
		repriced, err := repriceNativePage(tx, client, now, evidence, catalog)
		if err != nil {
			return err
		}
		changed = changed || repriced
		return nil
	})
	if err == nil && changed {
		h.cacheMu.Lock()
		h.native = nil
		h.cacheMu.Unlock()
	}
	return err
}

func equalFloat(a, b *float64) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }

// Conflicting proof is sticky. Replaying an old fork cannot restore a demoted
// row or reduce a completed streaming response to an earlier partial vector.
// A contradictory source is final in any order.
func mergeNative(old, next nativeusage.Event) nativeusage.Event {
	same := old.Provider == next.Provider && old.PriceProvider == next.PriceProvider && old.Model == next.Model && nativeTier(old.Tier) == nativeTier(next.Tier)
	if same && old.Client == "claude" && next.Client == "claude" && strings.HasPrefix(old.Model, "ocx-") {
		// A Claude Code ocx- model is an OCX picker alias that Anthropic cannot
		// serve: it proves the route whatever request ID a record carried,
		// including rows stored before the parser knew aliases, and those
		// demoted only for their counters. A conflicting source stays a conflict.
		next.Route, next.Evidence = nativeusage.Proxy, "ocx-model-alias"
		if old.Route != nativeusage.Conflict || old.Evidence == "conflicting-counters" {
			old.Route, old.Evidence, old.Unproven = next.Route, next.Evidence, false
		}
	}
	if old.Route == nativeusage.Conflict {
		switch {
		case old.Evidence == "conflicting-counters" && !same:
			old.Evidence, old.Unproven = "conflicting-source", false
			return old
		case !old.Unproven:
			return old
		case next.Route == nativeusage.Unknown:
			return laterSnapshot(old, next)
		case next.Route == nativeusage.Direct:
			old.Unproven = false // A direct call whose snapshots disagree.
			return old
		}
		// An OCX proof settles counters that only unproven snapshots disputed.
		old.Route, old.Evidence, old.Unproven = next.Route, next.Evidence, false
	}
	if !same || old.Route != nativeusage.Unknown && next.Route != nativeusage.Unknown && old.Route != next.Route {
		old.Route = nativeusage.Conflict
		old.Evidence = "conflicting-source"
		return old
	}
	if old.Client == "antigravity" && next.Client == "antigravity" {
		if old.ParserRevision >= nativeusage.AntigravityRevision && next.ParserRevision < nativeusage.AntigravityRevision {
			return old // A legacy replay must not restore the model enum as tokens.
		}
		if old.ParserRevision < nativeusage.AntigravityRevision && next.ParserRevision == nativeusage.AntigravityRevision {
			// Revision 1 added the model enum once to input. Only a source
			// observation reproducing the entire legacy vector proves which
			// enum belongs to it. A partial clone cannot authorize subtraction.
			if old.Evidence != "antigravity-generation" || next.Evidence != old.Evidence || old.Route != nativeusage.Direct || next.Route != old.Route ||
				next.ModelEnum < 0 {
				old.Route, old.Evidence = nativeusage.Conflict, "conflicting-parser-revision"
				return old
			}
			if old.Input != next.Input+next.ModelEnum || old.Output != next.Output || old.CacheRead != next.CacheRead || old.CacheWrite != next.CacheWrite || old.CacheWrite1h != next.CacheWrite1h {
				return old
			}
			old.Input -= next.ModelEnum
			old.ParserRevision, old.ModelEnum = next.ParserRevision, next.ModelEnum
		}
	}
	// One proven route covers every snapshot of the message, before counters
	// are compared.
	if old.Route == nativeusage.Unknown && next.Route != nativeusage.Unknown {
		old.Route, old.Evidence = next.Route, next.Evidence
	} else if old.Route == nativeusage.Unknown {
		old.Evidence = unknownEvidence(old.Evidence, next.Evidence)
	}
	a := []int64{old.Input, old.Output, old.CacheRead, old.CacheWrite, old.CacheWrite1h}
	b := []int64{next.Input, next.Output, next.CacheRead, next.CacheWrite, next.CacheWrite1h}
	greater, less := false, false
	for i := range a {
		greater = greater || b[i] > a[i]
		less = less || b[i] < a[i]
	}
	if greater && less {
		switch old.Route {
		case nativeusage.Proxy:
			// OCX's own row carries a proxied call's cost. A converted stream
			// opens with OCX's prompt estimate and ends with the upstream's
			// count, cached input split out, so its vectors need not grow
			// together.
			return laterSnapshot(old, next)
		case nativeusage.Unknown:
			// Snapshots that prove no route disagree: a conflict that a direct
			// proof keeps and an OCX proof settles.
			out := laterSnapshot(old, next)
			out.Route, out.Evidence, out.Unproven = nativeusage.Conflict, "conflicting-counters", true
			return out
		}
		old.Route = nativeusage.Conflict
		old.Evidence = "conflicting-counters"
		return old
	}
	if next.At < old.At {
		old.At = next.At
	}
	if greater {
		next.At = old.At
		next.Route = old.Route
		next.Evidence = old.Evidence
		return next
	}
	return old
}

// laterSnapshot keeps the snapshot ordered later by output, then cache read,
// cache writes and input, with old's route and the earliest time, so any merge
// order settles on the same vector.
func laterSnapshot(old, next nativeusage.Event) nativeusage.Event {
	a := [...]int64{old.Output, old.CacheRead, old.CacheWrite, old.CacheWrite1h, old.Input}
	b := [...]int64{next.Output, next.CacheRead, next.CacheWrite, next.CacheWrite1h, next.Input}
	out := old
	for i := range a {
		if a[i] != b[i] {
			if b[i] > a[i] {
				out = next
				out.Route, out.Evidence, out.Unproven = old.Route, old.Evidence, old.Unproven
			}
			break
		}
	}
	out.At = min(old.At, next.At)
	return out
}

// A specific reason replaces the legacy one; an unrecognized request ID
// outweighs a missing one because it is the stronger sign of an unknown route.
func unknownEvidence(old, next string) string {
	switch {
	case old == "route-unverified":
		return next
	case old == "request-id-absent" && next == "request-id-unrecognized":
		return next
	}
	return old
}

func nativeTier(s string) string {
	if s == "" || s == "standard" || s == "auto" {
		return "default"
	}
	return s
}

func repriceNativePage(tx *sql.Tx, client string, now int64, evidence []Evidence, catalog *Catalog) (bool, error) {
	key := "nativePriceAfter:" + client
	var raw, after string
	err := tx.QueryRow(`SELECT value FROM meta WHERE key=?`, key).Scan(&raw)
	if err != nil && err != sql.ErrNoRows {
		return false, err
	}
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &after)
	}
	rows, err := tx.Query(`SELECT event FROM native_usage WHERE client=? AND usd IS NULL AND id>? ORDER BY id LIMIT 128`, client, after)
	if err != nil {
		return false, err
	}
	var events []nativeusage.Event
	for rows.Next() {
		var data string
		if err = rows.Scan(&data); err != nil {
			rows.Close()
			return false, err
		}
		var e nativeusage.Event
		if err = json.Unmarshal([]byte(data), &e); err != nil {
			rows.Close()
			return false, err
		}
		events = append(events, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	changed := false
	after = ""
	for _, e := range events {
		after = e.ID
		q := quoteNative(e, evidence, catalog)
		if q.usd == nil {
			continue
		}
		if _, err = tx.Exec(`UPDATE native_usage SET usd=?,basis=? WHERE id=? AND usd IS NULL`, q.usd, q.basis, e.ID); err != nil {
			return false, err
		}
		changed = true
	}
	b, _ := json.Marshal(after)
	_, err = tx.Exec(`INSERT OR REPLACE INTO meta VALUES(?,?)`, key, string(b))
	return changed, err
}

func quoteNative(e nativeusage.Event, evidence []Evidence, catalog *Catalog) ingestQuote {
	u := map[string]any{"inputTokens": float64(e.Input), "outputTokens": float64(e.Output), "cacheReadInputTokens": float64(e.CacheRead), "cacheCreationInputTokens": float64(e.CacheWrite)}
	row := map[string]any{"usage": u, "responseServiceTier": e.Tier}
	q := quoteIngest(e.PriceProvider, e.Model, e.At, row, evidence, catalog)
	if e.CacheWrite1h > 0 {
		if q.usd == nil || q.hour == nil || e.CacheWrite == 0 {
			return ingestQuote{basis: UnknownInputBasis}
		}
		v := *q.usd + (*q.hour-*q.usd)*float64(e.CacheWrite1h)/float64(e.CacheWrite)
		q.usd = &v
	}
	return q
}

// NativeUsage returns the transcript rows that add to costs, plus counts and
// reference amounts of the rest. Claude Code adds only its settled rows (see
// NativeSettledKey); its other rows are counted for diagnosis and never priced
// into costs. Antigravity adds its proven direct rows. Codex is owned by OCX;
// retained candidates from earlier collectors are not counted a second time.
// The Claude route policy is applied here only; stored rows never change, so
// removing the policy returns its rows to pending. No raw IDs leave this seam.
func (h *History) NativeUsage() (NativeView, error) {
	h.cacheMu.Lock()
	defer h.cacheMu.Unlock()
	if h.native != nil {
		return *h.native, nil
	}
	policy := h.claudeRoutePolicy()
	settledAt := int64(-1)
	if v, ok := h.Meta(NativeSettledKey); ok {
		if n, ok := v.(float64); ok {
			settledAt = int64(n)
		}
	}
	v := NativeView{Rows: []Usage{}, Summary: map[string]NativeSummary{}, ClaudePolicy: policy}
	row := func(id string, at int64, raw string, usd *float64, basis string) error {
		var e nativeusage.Event
		if err := json.Unmarshal([]byte(raw), &e); err != nil {
			return err
		}
		in, out, read, tokens := float64(e.Input), float64(e.Output), float64(e.CacheRead), float64(e.Input+e.Output)
		v.Rows = append(v.Rows, Usage{ID: id, At: at, Provider: e.Provider, Model: &e.Model, Input: &in, Output: &out, Cached: &read, Tokens: &tokens, USD: usd, Basis: &basis})
		return nil
	}
	settled, err := h.db.Query(`SELECT id,at,provider,model,input,output,cacheRead,usd,basis FROM native_settled WHERE client='claude' ORDER BY at`)
	if err != nil {
		return NativeView{}, err
	}
	claude := v.Summary["claude"].Complete()
	for settled.Next() {
		var id, provider, model, basis string
		var at, in, out, read int64
		var usd *float64
		if err = settled.Scan(&id, &at, &provider, &model, &in, &out, &read, &usd, &basis); err != nil {
			settled.Close()
			return NativeView{}, err
		}
		input, output, cached, tokens := float64(in), float64(out), float64(read), float64(in+out)
		v.Rows = append(v.Rows, Usage{ID: id, At: at, Provider: provider, Model: &model, Input: &input, Output: &output, Cached: &cached, Tokens: &tokens, USD: usd, Basis: &basis})
		claude.Included++
		if usd == nil {
			claude.Unpriced++
		}
	}
	settled.Close()
	if err = settled.Err(); err != nil {
		return NativeView{}, err
	}
	if settledAt >= 0 {
		at := time.UnixMilli(settledAt).UTC().Format(time.RFC3339Nano)
		claude.SettledAt = &at
	}
	v.Summary["claude"] = claude
	rows, err := h.db.Query(`SELECT n.id,n.client,n.at,n.route,n.event,n.usd,n.basis,COALESCE(json_extract(n.event,'$.Evidence'),''),s.id IS NOT NULL
	 FROM native_usage n LEFT JOIN native_settled s ON s.id=n.id WHERE n.client IN ('claude','antigravity') ORDER BY n.at`)
	if err != nil {
		return NativeView{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, client, route, raw, basis, evidence string
		var at int64
		var usd *float64
		var isSettled bool
		if err = rows.Scan(&id, &client, &at, &route, &raw, &usd, &basis, &evidence, &isSettled); err != nil {
			return v, err
		}
		transcriptCosts := client != "claude"
		if !transcriptCosts && isSettled && nativeusage.Route(route) == nativeusage.Direct {
			continue // counted from its settled copy; a later route still shows below
		}
		s := v.Summary[client].Complete()
		if nativeusage.Route(route) == nativeusage.Unknown && policy.covers(client, evidence, at) {
			route, evidence = string(nativeusage.Proxy), "configured-ocx-cutover"
		}
		switch nativeusage.Route(route) {
		case nativeusage.Direct:
			if transcriptCosts {
				if err = row(id, at, raw, usd, basis); err != nil {
					return v, err
				}
				s.Included++
				break
			}
			if at < settledAt {
				s.UnsettledDirectPast++
			} else {
				s.UnsettledDirectNew++
			}
			if s.unsettledFirst == 0 || at < s.unsettledFirst {
				s.unsettledFirst = at
			}
			if at > s.unsettledLast {
				s.unsettledLast = at
			}
		case nativeusage.Proxy:
			s.Proxy++
			s.ProxyByEvidence[evidence]++
		case nativeusage.Conflict:
			s.Conflicts++
			s.ConflictByReason[evidence]++
			if transcriptCosts {
				v.Excluded = append(v.Excluded, NativeExcluded{Client: client, At: at})
			}
		default:
			s.Pending++
			s.PendingByReason[evidence]++
			if transcriptCosts {
				v.Excluded = append(v.Excluded, NativeExcluded{Client: client, At: at})
			}
			// A reference amount only where transcripts are still valued.
			if usd != nil && transcriptCosts {
				total := *usd
				if s.PendingUSD != nil {
					total += *s.PendingUSD
				}
				s.PendingUSD = &total
			}
		}
		// A settled row's missing amount was counted from its settled copy.
		if usd == nil && !(isSettled && !transcriptCosts) {
			s.Unpriced++
		}
		v.Summary[client] = s
	}
	if err = rows.Err(); err != nil {
		return v, err
	}
	if s, ok := v.Summary["claude"]; ok && s.unsettledLast > 0 {
		first := time.UnixMilli(s.unsettledFirst).UTC().Format(time.RFC3339Nano)
		last := time.UnixMilli(s.unsettledLast).UTC().Format(time.RFC3339Nano)
		s.UnsettledDirectFirst, s.UnsettledDirectLast = &first, &last
		v.Summary["claude"] = s
	}
	h.native = &v
	return v, nil
}
