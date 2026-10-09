package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
)

const nativeSchema = `
CREATE TABLE IF NOT EXISTS native_usage (
 id TEXT PRIMARY KEY, client TEXT NOT NULL, at INTEGER NOT NULL,
 route TEXT NOT NULL, event TEXT NOT NULL, usd REAL, basis TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS native_usage_time ON native_usage(at);
CREATE TABLE IF NOT EXISTS native_cursors (
 client TEXT NOT NULL, pathHash TEXT NOT NULL, cursor TEXT NOT NULL,
 PRIMARY KEY(client,pathHash));`

type NativeSummary struct {
	Included         int            `json:"includedRequests"`
	Pending          int            `json:"pendingRequests"`
	Proxy            int            `json:"proxyRequests"`
	Conflicts        int            `json:"conflictRequests"`
	PendingUSD       *float64       `json:"pendingApiUsd"`
	Unpriced         int            `json:"unpricedRequests"`
	ProxyByEvidence  map[string]int `json:"proxyByEvidence"`
	PendingByReason  map[string]int `json:"pendingByReason"`
	ConflictByReason map[string]int `json:"conflictByReason"`
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
			q := quoteNative(e, evidence, catalog)
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

// NativeUsage returns only proven direct rows for cost analysis, plus counts
// and reference amounts of unresolved candidates. Codex is owned by OCX;
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
	rows, err := h.db.Query(`SELECT id,client,at,route,event,usd,basis,COALESCE(json_extract(event,'$.Evidence'),'') FROM native_usage WHERE client IN ('claude','antigravity') ORDER BY at`)
	if err != nil {
		return NativeView{}, err
	}
	defer rows.Close()
	v := NativeView{Rows: []Usage{}, Summary: map[string]NativeSummary{}, ClaudePolicy: policy}
	for rows.Next() {
		var id, client, route, raw, basis, evidence string
		var at int64
		var usd *float64
		if err = rows.Scan(&id, &client, &at, &route, &raw, &usd, &basis, &evidence); err != nil {
			return v, err
		}
		s := v.Summary[client].Complete()
		if nativeusage.Route(route) == nativeusage.Unknown && policy.covers(client, evidence, at) {
			route, evidence = string(nativeusage.Proxy), "configured-ocx-cutover"
		}
		switch nativeusage.Route(route) {
		case nativeusage.Direct:
			var e nativeusage.Event
			if err = json.Unmarshal([]byte(raw), &e); err != nil {
				return v, err
			}
			in, out, read, tokens := float64(e.Input), float64(e.Output), float64(e.CacheRead), float64(e.Input+e.Output)
			v.Rows = append(v.Rows, Usage{ID: id, At: at, Provider: e.Provider, Model: &e.Model, Input: &in, Output: &out, Cached: &read, Tokens: &tokens, USD: usd, Basis: &basis})
			s.Included++
		case nativeusage.Proxy:
			s.Proxy++
			s.ProxyByEvidence[evidence]++
		case nativeusage.Conflict:
			s.Conflicts++
			s.ConflictByReason[evidence]++
		default:
			s.Pending++
			s.PendingByReason[evidence]++
			if usd != nil {
				total := *usd
				if s.PendingUSD != nil {
					total += *s.PendingUSD
				}
				s.PendingUSD = &total
			}
		}
		if usd == nil {
			s.Unpriced++
		}
		v.Summary[client] = s
	}
	if err = rows.Err(); err != nil {
		return v, err
	}
	h.native = &v
	return v, nil
}
