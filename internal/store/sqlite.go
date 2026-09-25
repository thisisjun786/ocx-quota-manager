package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	_ "modernc.org/sqlite"
)

type History struct {
	db            *sql.DB
	path          string
	retentionDays int
	maxBytes      int64

	cacheMu    sync.Mutex
	usage      usageCache
	obs        observationCache
	catalog    *Catalog
	catalogRev string
}

type OpenOptions struct {
	RetentionDays int
	MaxBytes      int64
}

func Open(directory string, opt OpenOptions) (*History, error) {
	if opt.RetentionDays == 0 {
		opt.RetentionDays = 90
	}
	if opt.MaxBytes == 0 {
		opt.MaxBytes = 512 * 1024 * 1024
	}
	if opt.RetentionDays < 31 || opt.RetentionDays > 3650 || opt.MaxBytes < 1024*1024 {
		return nil, fmt.Errorf("invalid history storage limits")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, "history.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	h := &History{db: db, path: path, retentionDays: opt.RetentionDays, maxBytes: opt.MaxBytes}
	if err := h.init(); err != nil {
		db.Close()
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	return h, nil
}

func (h *History) init() error {
	var pageSize, pageCount int64
	if err := h.db.QueryRow("PRAGMA page_size").Scan(&pageSize); err != nil {
		return err
	}
	if err := h.db.QueryRow("PRAGMA page_count").Scan(&pageCount); err != nil {
		return err
	}
	maxPages := h.maxBytes / pageSize
	if pageCount > maxPages {
		return fmt.Errorf("existing history exceeds the configured limit; preserve or archive it before lowering the limit")
	}
	if _, err := h.db.Exec(fmt.Sprintf("PRAGMA max_page_count=%d", maxPages)); err != nil {
		return err
	}
	if _, err := h.db.Exec(schemaSQL); err != nil {
		return err
	}
	var mode string
	if err := h.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil {
		return err
	}
	if mode != "wal" {
		return fmt.Errorf("journal_mode=%s want wal", mode)
	}
	return nil
}

func (h *History) Path() string { return h.path }

func (h *History) Close() error { return h.db.Close() }

// DB exposes the raw handle. A caller may write anything through it, so the
// read cache starts over.
func (h *History) DB() *sql.DB {
	h.invalidateAll()
	return h.db
}

// Transact runs fn in a transaction. fn may write any table, so the read cache
// starts over once it commits.
func (h *History) Transact(fn func(tx *sql.Tx) error) error {
	err := h.transact(fn)
	h.invalidateAll()
	return err
}

func (h *History) transact(fn func(tx *sql.Tx) error) error {
	tx, err := h.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (h *History) Meta(key string) (any, bool) {
	var raw string
	err := h.db.QueryRow("SELECT value FROM meta WHERE key=?", key).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, false
	}
	if err != nil {
		return nil, false
	}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return raw, true
	}
	return value, true
}

func (h *History) SetMeta(key string, value any) error {
	raw, err := contract.MarshalCanonical(value)
	if err != nil {
		return err
	}
	_, err = h.db.Exec("INSERT OR REPLACE INTO meta VALUES (?,?)", key, string(raw))
	if key == "claudeCacheAssumption" || key == "cursorCacheReference" {
		h.invalidateUsage()
	}
	return err
}

func (h *History) bumpUsageRevision(tx *sql.Tx) error {
	var raw string
	rev := 0
	err := tx.QueryRow("SELECT value FROM meta WHERE key='usageDataRevision'").Scan(&raw)
	if err == nil {
		_ = json.Unmarshal([]byte(raw), &rev)
	} else if err != sql.ErrNoRows {
		return err
	}
	encoded, err := contract.MarshalCanonical(rev + 1)
	if err != nil {
		return err
	}
	_, err = tx.Exec("INSERT OR REPLACE INTO meta VALUES (?,?)", "usageDataRevision", string(encoded))
	return err
}

func (h *History) InsertUsage(row Usage) error {
	err := h.transact(func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(id) DO UPDATE SET usd=excluded.usd,basis=excluded.basis
			WHERE usage.usd IS NULL AND excluded.usd IS NOT NULL
			AND usage.provider=excluded.provider AND usage.model IS excluded.model AND usage.at=excluded.at
			AND usage.input=excluded.input AND usage.output=excluded.output AND usage.cached=excluded.cached AND usage.tokens=excluded.tokens`,
			row.ID, row.At, row.Provider, row.Account, row.Model, row.Input, row.Output, row.Cached, row.Tokens, row.USD, row.Basis)
		if err != nil {
			return err
		}
		return h.bumpUsageRevision(tx)
	})
	h.markUsageDirty([]string{row.ID})
	return err
}

func (h *History) InsertObservation(row Observation) error {
	return h.transact(func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO quota_observations (
			provider,account,window,at,epoch,basis,reportedPercent,calculatedPercent,observedPercent,
			used,limitValue,limitState,unit,method,windowSemantics,scopeKey,cycleKey,reset,source,sourceVersion,
			precisionEvidence,resolutionPp,reconciliation,usedAccumulation,pairsSample)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			row.Provider, row.Account, row.Window, row.At, row.Epoch, row.Basis, row.ReportedPercent, row.CalculatedPercent, row.ObservedPercent,
			row.Used, row.LimitValue, row.LimitState, row.Unit, row.Method, row.WindowSemantics, row.ScopeKey, row.CycleKey, row.Reset, row.Source, row.SourceVersion,
			row.PrecisionEvidence, row.ResolutionPp, row.Reconciliation, row.UsedAccumulation, row.PairsSample)
		return err
	})
}

func (h *History) InsertSample(row Sample) error {
	return h.transact(func(tx *sql.Tx) error {
		_, err := tx.Exec("INSERT OR IGNORE INTO samples VALUES (?,?,?,?,?,?)",
			row.Provider, row.Account, row.Window, row.At, row.Reset, row.Used)
		return err
	})
}

func (h *History) OpenEpoch(provider, account, basis string, digest *string, now int64, reason string) (int64, error) {
	var epoch int64
	err := h.transact(func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE identity_epochs SET endedAt=?,reason=? WHERE provider=? AND account=? AND endedAt IS NULL",
			now, reason, provider, account); err != nil {
			return err
		}
		var raw string
		seq := 0
		if err := tx.QueryRow("SELECT value FROM meta WHERE key='identityEpochSequence'").Scan(&raw); err == nil {
			_ = json.Unmarshal([]byte(raw), &seq)
		}
		seq++
		encoded, err := contract.MarshalCanonical(seq)
		if err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT OR REPLACE INTO meta VALUES (?,?)", "identityEpochSequence", string(encoded)); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO identity_epochs VALUES (?,?,?,?,?,?,NULL,?)",
			provider, account, seq, basis, digest, now, reason); err != nil {
			return err
		}
		epoch = int64(seq)
		return nil
	})
	return epoch, err
}

type Evidence struct {
	ID             int64
	Provider       string
	Model          string
	Status         string
	SourceURL      *string
	CheckedAt      *string
	EffectiveFrom  *string
	EffectiveTo    *string
	Rates          [4]*float64
	TierMultiplier *float64
	Conditions     []string
	Unsupported    []string
	Conflict       any
	Reason         *string
	FirstRevision  string
	FirstSeenAt    int64
}

func EvidenceDigest(e Evidence) (string, error) {
	conflict := any(nil)
	if e.Conflict != nil {
		conflict = conflictDigestTuple(e.Conflict)
	}
	payload := []any{
		e.Provider, e.Model, e.Status, e.SourceURL, e.CheckedAt, e.EffectiveFrom, e.EffectiveTo,
		[]any{e.Rates[0], e.Rates[1], e.Rates[2], e.Rates[3]}, e.TierMultiplier,
		sortedCopy(e.Conditions), sortedCopy(e.Unsupported), conflict, e.Reason,
	}
	raw, err := contract.MarshalCanonical(payload)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// conflictDigestTuple mirrors src/history.mjs evidenceDigest: a conflict enters
// the digest as the fixed-position tuple [status, rateTuple(rates), reason] with
// unknown members as null, never as a free-form object.
func conflictDigestTuple(conflict any) []any {
	m, ok := conflict.(map[string]any)
	if !ok {
		return []any{nil, []any{nil, nil, nil, nil}, nil}
	}
	tuple := []any{m["status"], nil, m["reason"]}
	rates, ok := m["rates"].(map[string]any)
	if ok {
		tuple[1] = []any{rates["input"], rates["output"], rates["cacheRead"], rates["cacheWrite"]}
		return tuple
	}
	if list, ok := m["rates"].([]any); ok {
		rateList := []any{nil, nil, nil, nil}
		for i := 0; i < 4 && i < len(list); i++ {
			rateList[i] = list[i]
		}
		tuple[1] = rateList
	}
	return tuple
}

// validateConflict accepts the contract shape: an object whose status and
// reason are strings (or null) and whose rates are the canonical object or the
// legacy length-4 array with number or null members. Anything else is
// malformed and must fail the insert instead of digesting as a null tuple.
func validateConflict(conflict any) error {
	m, ok := conflict.(map[string]any)
	if !ok {
		return fmt.Errorf("conflict: want object, got %v", conflict)
	}
	for _, key := range []string{"status", "reason"} {
		if v, ok := m[key]; ok && v != nil {
			if _, isStr := v.(string); !isStr {
				return fmt.Errorf("conflict.%s: want string or null, got %v", key, v)
			}
		}
	}
	raw, ok := m["rates"]
	if !ok || raw == nil {
		return nil
	}
	switch t := raw.(type) {
	case map[string]any:
		for _, key := range rateKeys {
			if v, ok := t[key]; ok && v != nil {
				if _, err := rateValue(v); err != nil {
					return fmt.Errorf("conflict.rates.%s: %w", key, err)
				}
			}
		}
	case []any:
		if len(t) != 4 {
			return fmt.Errorf("conflict.rates: legacy array length %d, want 4", len(t))
		}
		for i, v := range t {
			if v == nil {
				continue
			}
			if _, err := rateValue(v); err != nil {
				return fmt.Errorf("conflict.rates[%d]: %w", i, err)
			}
		}
	default:
		return fmt.Errorf("conflict.rates: want object or legacy array, got %v", raw)
	}
	return nil
}

func sortedCopy(in []string) []string {
	out := make([]string, len(in))
	copy(out, in)
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func (h *History) InsertEvidence(e Evidence) (int64, error) {
	if err := validateRates(e.Rates); err != nil {
		return 0, err
	}
	if e.Conflict != nil {
		if err := validateConflict(e.Conflict); err != nil {
			return 0, err
		}
	}
	digest, err := EvidenceDigest(e)
	if err != nil {
		return 0, err
	}
	rates, err := contract.MarshalCanonical(contract.RateCard{
		Input: e.Rates[0], Output: e.Rates[1], CacheRead: e.Rates[2], CacheWrite: e.Rates[3],
	})
	if err != nil {
		return 0, err
	}
	cond, err := contract.MarshalCanonical(sortedCopy(e.Conditions))
	if err != nil {
		return 0, err
	}
	unsup, err := contract.MarshalCanonical(sortedCopy(e.Unsupported))
	if err != nil {
		return 0, err
	}
	var conflict any
	if e.Conflict != nil {
		conflict, err = contract.MarshalCanonical(e.Conflict)
		if err != nil {
			return 0, err
		}
	}
	var id int64
	err = h.transact(func(tx *sql.Tx) error {
		id, err = insertEvidenceRow(tx, e, digest, string(rates), string(cond), string(unsup), conflict)
		return err
	})
	return id, err
}

func insertEvidenceRow(tx *sql.Tx, e Evidence, digest, rates, cond, unsup string, conflict any) (int64, error) {
	var id int64
	if _, err := tx.Exec(`INSERT OR IGNORE INTO price_evidence
		(digest,provider,model,status,sourceUrl,checkedAt,effectiveFrom,effectiveTo,rates,tierMultiplier,
		 conditions,unsupported,conflict,reason,firstRevision,firstSeenAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		digest, e.Provider, e.Model, e.Status, e.SourceURL, e.CheckedAt, e.EffectiveFrom, e.EffectiveTo,
		rates, e.TierMultiplier, cond, unsup, conflict, e.Reason, e.FirstRevision, e.FirstSeenAt); err != nil {
		return 0, err
	}
	err := tx.QueryRow("SELECT id FROM price_evidence WHERE digest=?", digest).Scan(&id)
	return id, err
}

func (h *History) LinkUsagePrice(usageID string, evidenceID, pricedAt int64) error {
	_, err := h.db.Exec("INSERT OR IGNORE INTO usage_prices(id,evidence,pricedAt) VALUES (?,?,?)", usageID, evidenceID, pricedAt)
	return err
}

func (h *History) Count(table string) (int, error) {
	var n int
	err := h.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n)
	return n, err
}

func (h *History) Tables() ([]string, error) {
	rows, err := h.db.Query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

func (h *History) HasRequiredSchema() error {
	have := map[string]bool{}
	names, err := h.Tables()
	if err != nil {
		return err
	}
	for _, n := range names {
		have[n] = true
	}
	for _, need := range requiredTables {
		if !have[need] {
			return fmt.Errorf("missing table %s", need)
		}
	}
	for _, idx := range requiredIndexes {
		var name string
		err := h.db.QueryRow("SELECT name FROM sqlite_master WHERE type='index' AND name=?", idx).Scan(&name)
		if err != nil {
			return fmt.Errorf("missing index %s", idx)
		}
	}
	return nil
}

func (h *History) Maintain(now int64) error {
	cutoff := now - int64(h.retentionDays)*86400000
	return h.Transact(func(tx *sql.Tx) error {
		cutoffStmts := []string{
			"DELETE FROM usage_timings WHERE id IN (SELECT id FROM usage WHERE at<?)",
			"DELETE FROM cursor_cache_costs WHERE id IN (SELECT id FROM usage WHERE at<?)",
			"DELETE FROM claude_cache_costs WHERE id IN (SELECT id FROM usage WHERE at<?)",
			"DELETE FROM usage WHERE at<?",
			"DELETE FROM samples WHERE at<?",
			"DELETE FROM quota_observations WHERE at<?",
			"DELETE FROM identity_epochs WHERE endedAt IS NOT NULL AND endedAt<?",
			"DELETE FROM ollama_observations WHERE at<?",
		}
		for _, s := range cutoffStmts {
			if _, err := tx.Exec(s, cutoff); err != nil {
				return err
			}
		}
		if _, err := tx.Exec("DELETE FROM usage_prices WHERE NOT EXISTS (SELECT 1 FROM usage WHERE usage.id=usage_prices.id)"); err != nil {
			return err
		}
		if _, err := tx.Exec("DELETE FROM price_evidence WHERE id NOT IN (SELECT evidence FROM usage_prices)"); err != nil {
			return err
		}
		encoded, err := contract.MarshalCanonical(cutoff)
		if err != nil {
			return err
		}
		// A later clock that jumps backward must not reopen rows the previous
		// boundary already declared excluded. historyResetAt is a separate
		// operator boundary and is never written here.
		var previous string
		err = tx.QueryRow("SELECT value FROM meta WHERE key='usageExcludedBefore'").Scan(&previous)
		if err == sql.ErrNoRows {
			err = nil
		}
		if err != nil {
			return err
		}
		advance := true
		if previous != "" {
			var prior float64
			if jsonErr := json.Unmarshal([]byte(previous), &prior); jsonErr == nil && int64(prior) >= cutoff {
				advance = false
			}
		}
		if advance {
			if _, err := tx.Exec("INSERT OR REPLACE INTO meta VALUES (?,?)", "usageExcludedBefore", string(encoded)); err != nil {
				return err
			}
		}
		return h.bumpUsageRevision(tx)
	})
}
