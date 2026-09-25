package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
)

var rateKeys = []string{"input", "output", "cacheRead", "cacheWrite"}

func rateValue(val any) (float64, error) {
	f, ok := val.(float64)
	if !ok {
		return 0, fmt.Errorf("rate: want number, got %v", val)
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return 0, fmt.Errorf("rate: want finite non-negative, got %v", f)
	}
	return f, nil
}

func validateRates(rates [4]*float64) error {
	for i, key := range rateKeys {
		if rates[i] == nil {
			continue
		}
		if _, err := rateValue(*rates[i]); err != nil {
			return fmt.Errorf("rates.%s: %w", key, err)
		}
	}
	return nil
}

// decodeRates reads the rates column: the canonical object the Node writer
// stores, or the legacy fixed-position array of length 4. null members mean an
// unknown rate; anything else malformed is an error, not a silent zero.
func decodeRates(raw string) ([4]*float64, error) {
	out := [4]*float64{}
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return out, fmt.Errorf("rates: %w", err)
	}
	switch t := v.(type) {
	case map[string]any:
		for i, key := range rateKeys {
			val, ok := t[key]
			if !ok || val == nil {
				continue
			}
			f, err := rateValue(val)
			if err != nil {
				return out, fmt.Errorf("rates.%s: %w", key, err)
			}
			out[i] = &f
		}
	case []any:
		if len(t) != 4 {
			return out, fmt.Errorf("rates: legacy array length %d, want 4", len(t))
		}
		for i, val := range t {
			if val == nil {
				continue
			}
			f, err := rateValue(val)
			if err != nil {
				return out, fmt.Errorf("rates[%d]: %w", i, err)
			}
			out[i] = &f
		}
	case nil:
		return out, fmt.Errorf("rates: null")
	default:
		return out, fmt.Errorf("rates: want object, got %v", v)
	}
	return out, nil
}

// evidenceQueryer is satisfied by both *sql.DB and *sql.Tx, so the same read
// runs standalone and inside an ingest transaction.
type evidenceQueryer interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func (h *History) ListEvidence() ([]Evidence, error) {
	return listEvidence(h.db)
}

func listEvidence(q evidenceQueryer) ([]Evidence, error) {
	rows, err := q.Query(`SELECT id,provider,model,status,sourceUrl,checkedAt,effectiveFrom,effectiveTo,rates,tierMultiplier,conditions,unsupported,conflict,reason,firstRevision,firstSeenAt
		FROM price_evidence ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Evidence
	for rows.Next() {
		var e Evidence
		var rates, cond, unsup string
		var conflict sql.NullString
		if err := rows.Scan(&e.ID, &e.Provider, &e.Model, &e.Status, &e.SourceURL, &e.CheckedAt, &e.EffectiveFrom, &e.EffectiveTo,
			&rates, &e.TierMultiplier, &cond, &unsup, &conflict, &e.Reason, &e.FirstRevision, &e.FirstSeenAt); err != nil {
			return nil, err
		}
		if conflict.Valid {
			if err := json.Unmarshal([]byte(conflict.String), &e.Conflict); err != nil {
				return nil, err
			}
		}
		decoded, err := decodeRates(rates)
		if err != nil {
			return nil, err
		}
		e.Rates = decoded
		if err := json.Unmarshal([]byte(cond), &e.Conditions); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(unsup), &e.Unsupported)
		if e.Conditions == nil {
			e.Conditions = []string{}
		}
		if e.Unsupported == nil {
			e.Unsupported = []string{}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (h *History) UsageCursor() (UsageCursor, bool) {
	raw, ok := h.Meta("usageCursor")
	if !ok {
		return UsageCursor{}, false
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return UsageCursor{}, false
	}
	c := UsageCursor{}
	c.Ino, _ = m["ino"].(string)
	c.Fingerprint, _ = m["fingerprint"].(string)
	if off, ok := m["offset"].(float64); ok {
		c.Offset = int64(off)
	}
	return c, true
}
