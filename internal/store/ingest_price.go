package store

import (
	"database/sql"
	"encoding/json"
	"math"
	"reflect"
	"time"
)

// UnknownInputBasis prevents repricing after ingestion has discarded selectors
// (tier, cache-write count) that cannot be recovered from the legacy usage row.
const UnknownInputBasis = "unknown-input"
const claudePriceSource = "https://platform.claude.com/docs/en/about-claude/pricing"

type ingestQuote struct {
	resolved *Evidence
	usd      *float64
	hour     *float64
	write    float64
	evidence int64
	basis    string
}

func finiteToken(v float64) bool { return v >= 0 && !math.IsNaN(v) && !math.IsInf(v, 0) }
func quoteIngest(provider, model string, at int64, row map[string]any, evidence []Evidence, catalog ...*Catalog) ingestQuote {
	q := ingestQuote{basis: UnknownInputBasis}
	u, _ := row["usage"].(map[string]any)
	input, output := numPtr(u, "inputTokens"), numPtr(u, "outputTokens")
	if input == nil || output == nil || !finiteToken(*input) || !finiteToken(*output) {
		return q
	}
	if status, _ := row["usageStatus"].(string); status == "unreported" || status == "unsupported" {
		return q
	}
	resolved, conditional := conditionalEvidence(provider, model, at, *input, row)
	if conditional {
		if resolved.Status == "" || resolved.Status == "unpriced" {
			return q
		}
		evidence = []Evidence{resolved}
	} else {
		response, requested := row["responseServiceTier"], row["requestedServiceTier"]
		if nested, ok := row["tierOutcome"].(map[string]any); ok {
			if v := nested["responseServiceTier"]; v != nil {
				response = v
			}
			if v := nested["requestedServiceTier"]; v != nil {
				requested = v
			}
			if appliedFastTier(nested) {
				response = "priority"
			}
		}
		for _, v := range []any{response, requested} {
			if v != nil && v != "" && v != "default" && v != "auto" && v != "standard" {
				return q
			}
		}
	}
	read, write := 0.0, 0.0
	for _, key := range []string{"cacheReadInputTokens", "cachedInputTokens", "cacheCreationInputTokens"} {
		if raw, ok := u[key]; ok && raw != nil {
			v, ok := raw.(float64)
			if !ok || !finiteToken(v) {
				return q
			}
		}
	}
	if p := firstNum(u, "cacheReadInputTokens", "cachedInputTokens"); p != nil {
		read = *p
	}
	if p := numPtr(u, "cacheCreationInputTokens"); p != nil {
		write = *p
	}
	if read+write > *input && u["cacheReadInputTokens"] == nil && u["cachedInputTokens"] != nil {
		read = math.Max(0, read-write)
	}
	if read+write > *input {
		return q
	}
	if write == 0 {
		q.basis = "unknown"
	}
	var chosen *Evidence
	var chosenFrom int64 = math.MinInt64
	ambiguous := false
	for i := range evidence {
		e := &evidence[i]
		if e.Provider != provider || e.Model != model {
			continue
		}
		from, to := int64(math.MinInt64), int64(math.MaxInt64)
		for j, b := range []*string{e.EffectiveFrom, e.EffectiveTo} {
			if b != nil {
				t, err := time.Parse(time.RFC3339Nano, *b)
				if err != nil {
					return q
				}
				if j == 0 {
					from = t.UnixMilli()
				} else {
					to = t.UnixMilli()
				}
			}
		}
		if from >= to {
			return q
		}
		if at < from || at >= to {
			continue
		}
		if chosen == nil || from > chosenFrom {
			chosen = e
			chosenFrom = from
			ambiguous = false
		} else if from == chosenFrom {
			if !reflect.DeepEqual(chosen.Rates, e.Rates) || !reflect.DeepEqual(chosen.Conditions, e.Conditions) || chosen.Status != e.Status || !reflect.DeepEqual(chosen.TierMultiplier, e.TierMultiplier) || !reflect.DeepEqual(chosen.SourceURL, e.SourceURL) || !reflect.DeepEqual(chosen.Conflict, e.Conflict) {
				ambiguous = true
			}
		}
	}
	if chosen == nil && !ambiguous && !conditional && len(catalog) > 0 {
		// No source-owned quote for this exact model: fall back to the public
		// catalog, as the Node collector did. Tier-dependent rows returned above.
		if fallback, ok := catalog[0].evidence(provider, model, *input); ok {
			chosen = &fallback
		}
	}
	if chosen == nil || ambiguous {
		return q
	}
	e := chosen
	if e.Conflict != nil || (e.Status != "official" && e.Status != "local-catalog" && e.Status != "reference" && e.Status != "ocx-provided") || (!conditional && e.TierMultiplier != nil && *e.TierMultiplier != 1) {
		return q
	}
	claude := provider == "anthropic" && e.SourceURL != nil && (*e.SourceURL == claudePriceSource || *e.SourceURL == CatalogSource)
	for _, c := range e.Conditions {
		switch c {
		case "list-price-reference", "alias-derived":
		case "promotional":
			if e.EffectiveTo == nil {
				return q
			}
		case "cache-write-assumed":
			if !claude {
				return q
			}
		default:
			if !conditional {
				return q
			}
		}
	}
	for _, r := range e.Rates {
		if r != nil && !finiteToken(*r) {
			return q
		}
	}
	if e.Rates[0] == nil || e.Rates[1] == nil || (read > 0 && e.Rates[2] == nil) || (write > 0 && e.Rates[3] == nil) {
		return q
	}
	usd := (*input-read-write)**e.Rates[0] + *output**e.Rates[1]
	if read > 0 {
		usd += read * *e.Rates[2]
	}
	if write > 0 {
		usd += write * *e.Rates[3]
	}
	usd /= 1e6
	if conditional && e.TierMultiplier != nil {
		usd *= *e.TierMultiplier
	}
	if !finiteToken(usd) {
		return q
	}
	q.usd = &usd
	q.basis = "official"
	if e.Status != "official" {
		q.basis = "local-catalog"
	}
	q.evidence = e.ID
	if conditional {
		q.resolved = e
	}
	if write > 0 && claude {
		// A one-hour coefficient is justified only by the known 5m base tariff.
		if math.Abs(*e.Rates[3]-1.25**e.Rates[0]) > 1e-9 {
			return ingestQuote{basis: UnknownInputBasis}
		}
		hour := usd + write*(2**e.Rates[0]-*e.Rates[3])/1e6
		if !finiteToken(hour) {
			return ingestQuote{basis: UnknownInputBasis}
		}
		q.hour = &hour
		q.write = write
		q.basis = "local-catalog"
	}
	return q
}

func settleIngest(tx *sql.Tx, created bool, id string, at int64, provider, model string, input, output, cached, tokens *float64, q ingestQuote, now int64, reprice bool) error {
	if q.usd == nil {
		return nil
	}
	// A replay can fill an unknown amount, but never replace a settled valuation,
	// except in the one bounded repricing pass (reprice) the caller runs when the
	// tariff for this exact row changed.
	guard := "usd IS NULL"
	if reprice {
		guard = "(usd IS NULL OR abs(usd-?)>1e-9*max(abs(usd),abs(?),1))"
	}
	args := []any{q.usd, q.basis, id}
	if reprice {
		args = append(args, q.usd, q.usd)
	}
	args = append(args, provider, nilIfEmpty(model), at, input, output, cached, tokens)
	result, err := tx.Exec(`UPDATE usage SET usd=?,basis=? WHERE id=? AND `+guard+` AND provider=? AND model IS ? AND at=? AND input IS ? AND output IS ? AND cached IS ? AND tokens IS ?`, args...)
	if err != nil {
		return err
	}
	where := ` FROM usage WHERE id=? AND provider=? AND model IS ? AND at=? AND input IS ? AND output IS ? AND cached IS ? AND tokens IS ? AND usd IS NOT NULL AND abs(usd-?)<=1e-9*max(abs(usd),abs(?),1)`
	args = []any{id, provider, nilIfEmpty(model), at, input, output, cached, tokens, q.usd, q.usd}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if q.resolved != nil && (created || updated > 0) {
		e := *q.resolved
		e.FirstRevision = "conditional-price-v1"
		e.FirstSeenAt = now
		digest, err := EvidenceDigest(e)
		if err != nil {
			return err
		}
		rates, err := json.Marshal(map[string]*float64{"input": e.Rates[0], "output": e.Rates[1], "cacheRead": e.Rates[2], "cacheWrite": e.Rates[3]})
		if err != nil {
			return err
		}
		conditions, _ := json.Marshal(sortedCopy(e.Conditions))
		unsupported, _ := json.Marshal(sortedCopy(e.Unsupported))
		q.evidence, err = insertEvidenceRow(tx, e, digest, string(rates), string(conditions), string(unsupported), nil)
		if err != nil {
			return err
		}
	}
	if reprice && updated > 0 {
		if _, err = tx.Exec(`DELETE FROM usage_prices WHERE id=?`, id); err != nil {
			return err
		}
	}
	if q.evidence > 0 && (created || updated > 0) {
		if _, err = tx.Exec(`INSERT OR IGNORE INTO usage_prices(id,evidence,pricedAt) SELECT id,?,?`+where, append([]any{q.evidence, now}, args...)...); err != nil {
			return err
		}
	}
	if q.hour != nil && q.write > 0 && *q.usd > 0 {
		_, err = tx.Exec(`INSERT OR IGNORE INTO claude_cache_costs(id,fiveMinuteUsd,oneHourUsd,cacheWriteTokens) SELECT id,?,?,?`+where, append([]any{q.usd, q.hour, q.write}, args...)...)
	}
	return err
}
