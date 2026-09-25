package runtime

import (
	"math"
	"reflect"
	"regexp"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

// A nil bound is open; a malformed bound is not an open-ended tariff.
var evidenceInstant = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T[0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$`)

type priceKey struct{ provider, model string }
type datedRate struct {
	rate   calc.StoredRate
	valid  bool
	usable bool
}

func evidenceBound(raw *string) (*int64, bool) {
	if raw == nil {
		return nil, true
	}
	if !evidenceInstant.MatchString(*raw) {
		return nil, false
	}
	t, err := time.Parse(time.RFC3339Nano, *raw)
	if err != nil {
		return nil, false
	}
	ms := t.UnixMilli()
	return &ms, true
}
func priceUsage(rows []store.Usage, evidence []store.Evidence, _ int64) ([]calc.AppliedPrice, int) {
	byModel := map[priceKey][]datedRate{}
	for _, e := range evidence {
		from, fromOK := evidenceBound(e.EffectiveFrom)
		to, toOK := evidenceBound(e.EffectiveTo)
		r := calc.StoredRate{Model: e.Model, Canonical: e.Model, Origin: e.Status, EffectiveFrom: math.MinInt64, EffectiveTo: to, Input: e.Rates[0], Output: e.Rates[1], CacheRead: e.Rates[2], CacheWrite: e.Rates[3]}
		if from != nil {
			r.EffectiveFrom = *from
		}
		valid := fromOK && toOK && (from == nil || to == nil || *from < *to)
		usable := reusableEvidence(e) && e.Conflict == nil && e.Status != "unknown" && e.Status != "unsupported" && e.Status != "conflict"
		for _, n := range e.Rates {
			if n != nil && (math.IsNaN(*n) || math.IsInf(*n, 0) || *n < 0) {
				usable = false
			}
		}
		key := priceKey{e.Provider, e.Model}
		byModel[key] = append(byModel[key], datedRate{r, valid, usable})
	}
	out := make([]calc.AppliedPrice, 0, len(rows))
	unknown := 0
	for _, u := range rows {
		model := ""
		if u.Model != nil {
			model = *u.Model
		}
		line := calc.UsageLine{Model: model, At: u.At, StoredUSD: u.USD}
		if u.Input != nil {
			line.InputTokens = *u.Input
		}
		if u.Output != nil {
			line.OutputTokens = *u.Output
		}
		if u.Cached != nil {
			line.CacheRead = *u.Cached
		}
		rates := selectUsageRate(byModel[priceKey{u.Provider, model}], u.At)
		if u.Basis != nil && *u.Basis == store.UnknownInputBasis {
			rates = nil
		}
		// Missing token counts cannot establish a zero-priced request.
		if u.Input == nil || u.Output == nil || !validTokenCount(line.InputTokens) || !validTokenCount(line.OutputTokens) || !validTokenCount(line.CacheRead) || line.CacheRead > line.InputTokens {
			rates = nil
		} else {
			// Persisted input includes cached input; ApplyPrice expects uncached input.
			line.InputTokens -= line.CacheRead
			if line.CacheRead > 0 && len(rates) > 0 && rates[0].CacheRead == nil {
				rates = nil
			}
		}
		priced := calc.ApplyPrice(line, rates)
		if priced.UnknownPrice {
			unknown++
		}
		out = append(out, priced)
	}
	return out, unknown
}
func selectUsageRate(rows []datedRate, at int64) []calc.StoredRate {
	var selected *datedRate
	ambiguous := false
	for i := range rows {
		r := &rows[i]
		if !r.valid {
			return nil
		}
		if at < r.rate.EffectiveFrom || (r.rate.EffectiveTo != nil && at >= *r.rate.EffectiveTo) {
			continue
		}
		if selected == nil || r.rate.EffectiveFrom > selected.rate.EffectiveFrom {
			selected = r
			ambiguous = false
		} else if r.rate.EffectiveFrom == selected.rate.EffectiveFrom && (!r.usable || !reflect.DeepEqual(r.rate, selected.rate)) {
			ambiguous = true
		}
	}
	if selected == nil || !selected.usable || ambiguous {
		return nil
	}
	return []calc.StoredRate{selected.rate}
}

func validTokenCount(n float64) bool { return n >= 0 && !math.IsNaN(n) && !math.IsInf(n, 0) }

// Usage has no service tier, context-band or cache-write selector. Provenance
// labels alone are reusable; conditional tariffs cannot price an unrelated row.
func reusableEvidence(e store.Evidence) bool {
	if e.TierMultiplier != nil && *e.TierMultiplier != 1 {
		return false
	}
	for _, condition := range e.Conditions {
		switch condition {
		case "list-price-reference", "alias-derived":
		case "promotional":
			if e.EffectiveTo == nil {
				return false
			}
		default:
			return false
		}
	}
	return true
}
