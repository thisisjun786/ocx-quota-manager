package store

import (
	_ "embed"
	"encoding/json"
	"time"
)

//go:embed price_rules.json
var priceRuleJSON []byte

type priceRule struct {
	Provider  string
	Model     string
	Peak      bool
	InputFrom float64
	Tier      string
	Quote     struct {
		Reason         *string
		Conflict       any
		Status         string
		Rates          map[string]*float64
		TierMultiplier *float64
		SourceURL      *string
		CheckedAt      *string
		EffectiveFrom  *string
		EffectiveTo    *string
		Conditions     []string
		Unsupported    []string
	}
}

var priceRules = func() []priceRule {
	var rules []priceRule
	if err := json.Unmarshal(priceRuleJSON, &rules); err != nil {
		panic(err)
	}
	return rules
}()

// A stored evidence row contains applied rates, not the selectors that chose
// them. Read known conditional tariffs from the source-owned selector table;
// never infer the base tariff by picking the cheapest historical amount.
func conditionalEvidence(provider, model string, at int64, input float64, row map[string]any) (Evidence, bool) {
	tier := "default"
	response, requested := row["responseServiceTier"], row["requestedServiceTier"]
	if nested, ok := row["tierOutcome"].(map[string]any); ok {
		if v := nested["responseServiceTier"]; v != nil {
			response = v
		}
		if v := nested["requestedServiceTier"]; v != nil {
			requested = v
		}
		// OpenCodex records whether it actually sent the fast/priority tier. The
		// upstream response often echoes "default" even then, so an applied fast
		// outcome decides the tier.
		if appliedFastTier(nested) {
			response = "priority"
		}
	}
	if response != nil && response != "" {
		s, ok := response.(string)
		if !ok {
			return Evidence{}, true
		}
		tier = s
	} else if requested != nil && requested != "" && requested != "default" && requested != "auto" && requested != "standard" {
		return Evidence{}, true
	}
	switch tier {
	case "auto", "standard":
		tier = "default"
	case "fast":
		tier = "priority"
	case "batch":
		tier = "flex"
	}
	instant := time.UnixMilli(at).UTC()
	weekday := instant.Weekday() != time.Saturday && instant.Weekday() != time.Sunday
	peak := weekday && ((instant.Hour() >= 1 && instant.Hour() < 4) || (instant.Hour() >= 6 && instant.Hour() < 10))
	var selected *priceRule
	known := false
	for i := range priceRules {
		r := &priceRules[i]
		if r.Provider != provider || r.Model != model {
			continue
		}
		known = true
		if r.Peak != peak || r.Tier != tier || r.InputFrom > input {
			continue
		}
		if selected == nil || r.InputFrom > selected.InputFrom {
			selected = r
		}
	}
	if selected == nil {
		return Evidence{}, known
	}
	q := selected.Quote
	return Evidence{Provider: provider, Model: model, Status: q.Status, Reason: q.Reason, Conflict: q.Conflict, Rates: [4]*float64{q.Rates["input"], q.Rates["output"], q.Rates["cacheRead"], q.Rates["cacheWrite"]}, SourceURL: q.SourceURL, CheckedAt: q.CheckedAt, EffectiveFrom: q.EffectiveFrom, EffectiveTo: q.EffectiveTo, TierMultiplier: q.TierMultiplier, Conditions: q.Conditions, Unsupported: q.Unsupported}, true
}

// ModelPriceEvidence exposes the default source-owned quote for roster display.
func ModelPriceEvidence(provider, model string, at int64) (Evidence, bool) {
	return conditionalEvidence(provider, model, at, 0, nil)
}

// appliedFastTier reports whether OpenCodex sent the priority (fast) tier.
func appliedFastTier(outcome map[string]any) bool {
	if outcome["fastOutcome"] != "applied" {
		return false
	}
	canonical, _ := outcome["canonical"].(string)
	wire, _ := outcome["wireValue"].(string)
	return canonical == "priority" || canonical == "fast" || wire == "priority" || wire == "fast"
}
