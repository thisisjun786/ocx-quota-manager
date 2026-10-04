package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"

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
	Included   int      `json:"includedRequests"`
	Pending    int      `json:"pendingRequests"`
	Proxy      int      `json:"proxyRequests"`
	Conflicts  int      `json:"conflictRequests"`
	PendingUSD *float64 `json:"pendingApiUsd"`
	Unpriced   int      `json:"unpricedRequests"`
}

type NativeView struct {
	Rows    []Usage
	Summary map[string]NativeSummary
}

func (h *History) NativeCursors(client string) (map[string]nativeusage.Cursor, error) {
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
func mergeNative(old, next nativeusage.Event) nativeusage.Event {
	if old.Route == nativeusage.Conflict {
		return old
	}
	if old.Provider != next.Provider || old.PriceProvider != next.PriceProvider || old.Model != next.Model || nativeTier(old.Tier) != nativeTier(next.Tier) ||
		(old.Route != nativeusage.Unknown && next.Route != nativeusage.Unknown && old.Route != next.Route) {
		old.Route = nativeusage.Conflict
		old.Evidence = "conflicting-source"
		return old
	}
	a := []int64{old.Input, old.Output, old.CacheRead, old.CacheWrite, old.CacheWrite1h}
	b := []int64{next.Input, next.Output, next.CacheRead, next.CacheWrite, next.CacheWrite1h}
	greater, less := false, false
	for i := range a {
		greater = greater || b[i] > a[i]
		less = less || b[i] < a[i]
	}
	if greater && less {
		old.Route = nativeusage.Conflict
		old.Evidence = "conflicting-counters"
		return old
	}
	if next.At < old.At {
		old.At = next.At
	}
	if old.Route == nativeusage.Unknown && next.Route != nativeusage.Unknown {
		old.Route = next.Route
		old.Evidence = next.Evidence
	}
	if greater {
		next.At = old.At
		next.Route = old.Route
		next.Evidence = old.Evidence
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
// and reference amounts of unresolved candidates. No raw IDs leave this seam.
func (h *History) NativeUsage() (NativeView, error) {
	h.cacheMu.Lock()
	defer h.cacheMu.Unlock()
	if h.native != nil {
		return *h.native, nil
	}
	rows, err := h.db.Query(`SELECT id,client,at,route,event,usd,basis FROM native_usage ORDER BY at`)
	if err != nil {
		return NativeView{}, err
	}
	defer rows.Close()
	v := NativeView{Rows: []Usage{}, Summary: map[string]NativeSummary{}}
	for rows.Next() {
		var id, client, route, raw, basis string
		var at int64
		var usd *float64
		if err = rows.Scan(&id, &client, &at, &route, &raw, &usd, &basis); err != nil {
			return v, err
		}
		s := v.Summary[client]
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
		case nativeusage.Conflict:
			s.Conflicts++
		default:
			s.Pending++
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
