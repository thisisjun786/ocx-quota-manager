package store

import (
	"sort"
	"strings"
	"time"
)

// The runtime reads every usage row and quota observation on each 10-second
// cycle. Re-reading ~250k rows through SQLite cost more than the analysis
// itself, so History keeps an in-memory copy and refreshes it incrementally:
// new rows arrive by rowid, rows the ingest touched are fetched again by id,
// and anything this process cannot track (retention, raw DB access, generic
// transactions, valuation meta) forces a full reload. A full reload also runs
// every cacheMaxAge so a writer outside this process cannot drift the copy
// for long.
const cacheMaxAge = 15 * time.Minute

// Past this many touched ids one full reload is cheaper than an IN() refetch.
const cacheRefetchLimit = 2000

type usageCache struct {
	valid    bool
	loadedAt time.Time
	rows     []Usage
	index    map[string]int
	maxRowID int64
	dirty    map[string]bool
}

type observationCache struct {
	valid    bool
	loadedAt time.Time
	rows     []Observation
	maxSeq   int64
}

func (h *History) invalidateAll() {
	h.cacheMu.Lock()
	h.usage.valid = false
	h.obs.valid = false
	h.cacheMu.Unlock()
}

func (h *History) invalidateUsage() {
	h.cacheMu.Lock()
	h.usage.valid = false
	h.cacheMu.Unlock()
}

func (h *History) markUsageDirty(ids []string) {
	if len(ids) == 0 {
		return
	}
	h.cacheMu.Lock()
	defer h.cacheMu.Unlock()
	if !h.usage.valid {
		return
	}
	if len(h.usage.dirty)+len(ids) > cacheRefetchLimit {
		h.usage.valid = false
		return
	}
	if h.usage.dirty == nil {
		h.usage.dirty = map[string]bool{}
	}
	for _, id := range ids {
		h.usage.dirty[id] = true
	}
}

const usageColumns = `id,at,provider,account,model,input,output,cached,tokens,usd,basis,cacheEstimated,estimatedCachedTokens,noCacheUsd,rid`

func (h *History) queryUsage(where string, args ...any) ([]Usage, int64, error) {
	rows, err := h.db.Query(`SELECT `+usageColumns+` FROM usage_valued `+where, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Usage
	var maxRowID int64
	for rows.Next() {
		var u Usage
		var cacheEstimated, rid int64
		if err := rows.Scan(&u.ID, &u.At, &u.Provider, &u.Account, &u.Model, &u.Input, &u.Output, &u.Cached, &u.Tokens, &u.USD, &u.Basis,
			&cacheEstimated, &u.EstimatedCachedTokens, &u.NoCacheUSD, &rid); err != nil {
			return nil, 0, err
		}
		u.CacheEstimated = cacheEstimated != 0
		if rid > maxRowID {
			maxRowID = rid
		}
		out = append(out, u)
	}
	return out, maxRowID, rows.Err()
}

// ListUsage returns every stored usage row ordered by time. The slice is
// shared with the cache: callers must treat it as read-only.
func (h *History) ListUsage() ([]Usage, error) {
	h.cacheMu.Lock()
	defer h.cacheMu.Unlock()
	c := &h.usage
	if !c.valid || time.Since(c.loadedAt) > cacheMaxAge {
		rows, maxRowID, err := h.queryUsage(`ORDER BY at ASC`)
		if err != nil {
			c.valid = false
			return nil, err
		}
		*c = usageCache{valid: true, loadedAt: time.Now(), rows: rows, maxRowID: maxRowID}
		c.reindex()
		return clip(c.rows), nil
	}
	added, maxRowID, err := h.queryUsage(`WHERE rid > ? ORDER BY at ASC`, c.maxRowID)
	if err != nil {
		c.valid = false
		return nil, err
	}
	var refetched []Usage
	if len(c.dirty) > 0 {
		ids := make([]any, 0, len(c.dirty))
		for id := range c.dirty {
			ids = append(ids, id)
		}
		refetched, _, err = h.queryUsage(`WHERE id IN (?`+strings.Repeat(",?", len(ids)-1)+`)`, ids...)
		if err != nil {
			c.valid = false
			return nil, err
		}
		c.dirty = nil
	}
	if len(added) == 0 && len(refetched) == 0 {
		return clip(c.rows), nil
	}
	// Copy on write: a slice handed out earlier keeps its own values.
	next := make([]Usage, len(c.rows), len(c.rows)+len(added))
	copy(next, c.rows)
	ordered := true
	for _, u := range refetched {
		if i, ok := c.index[u.ID]; ok {
			if next[i].At != u.At {
				ordered = false
			}
			next[i] = u
		}
	}
	for _, u := range added {
		if i, ok := c.index[u.ID]; ok {
			next[i] = u
			continue
		}
		if n := len(next); n > 0 && next[n-1].At > u.At {
			ordered = false
		}
		c.index[u.ID] = len(next)
		next = append(next, u)
	}
	if maxRowID > c.maxRowID {
		c.maxRowID = maxRowID
	}
	c.rows = next
	if !ordered {
		sort.SliceStable(c.rows, func(i, j int) bool { return c.rows[i].At < c.rows[j].At })
		c.reindex()
	}
	return clip(c.rows), nil
}

func (c *usageCache) reindex() {
	c.index = make(map[string]int, len(c.rows))
	for i, u := range c.rows {
		c.index[u.ID] = i
	}
}

const observationColumns = `seq,provider,account,window,at,epoch,basis,reportedPercent,calculatedPercent,observedPercent,
		used,limitValue,limitState,unit,method,windowSemantics,scopeKey,cycleKey,reset,source,sourceVersion,
		precisionEvidence,resolutionPp,reconciliation,usedAccumulation,pairsSample`

func (h *History) queryObservations(afterSeq int64) ([]Observation, int64, error) {
	rows, err := h.db.Query(`SELECT `+observationColumns+` FROM quota_observations WHERE seq > ? ORDER BY seq ASC`, afterSeq)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Observation
	maxSeq := afterSeq
	for rows.Next() {
		var o Observation
		var seq int64
		if err := rows.Scan(&seq, &o.Provider, &o.Account, &o.Window, &o.At, &o.Epoch, &o.Basis, &o.ReportedPercent, &o.CalculatedPercent, &o.ObservedPercent,
			&o.Used, &o.LimitValue, &o.LimitState, &o.Unit, &o.Method, &o.WindowSemantics, &o.ScopeKey, &o.CycleKey, &o.Reset, &o.Source, &o.SourceVersion,
			&o.PrecisionEvidence, &o.ResolutionPp, &o.Reconciliation, &o.UsedAccumulation, &o.PairsSample); err != nil {
			return nil, 0, err
		}
		maxSeq = seq
		out = append(out, o)
	}
	return out, maxSeq, rows.Err()
}

// ListObservations returns every quota observation in insertion order. The
// table is append-only outside retention, so new rows are read by seq. The
// slice is shared with the cache: callers must treat it as read-only.
func (h *History) ListObservations() ([]Observation, error) {
	h.cacheMu.Lock()
	defer h.cacheMu.Unlock()
	c := &h.obs
	if !c.valid || time.Since(c.loadedAt) > cacheMaxAge {
		rows, maxSeq, err := h.queryObservations(0)
		if err != nil {
			c.valid = false
			return nil, err
		}
		*c = observationCache{valid: true, loadedAt: time.Now(), rows: rows, maxSeq: maxSeq}
		return clip(c.rows), nil
	}
	added, maxSeq, err := h.queryObservations(c.maxSeq)
	if err != nil {
		c.valid = false
		return nil, err
	}
	if len(added) > 0 {
		c.rows = append(clip(c.rows), added...)
		c.maxSeq = maxSeq
	}
	return clip(c.rows), nil
}

// clip caps capacity so a caller's append can never write into the cache.
func clip[T any](s []T) []T { return s[:len(s):len(s)] }
