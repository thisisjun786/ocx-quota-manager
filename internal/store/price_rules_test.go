package store

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// price_rules.json is edited by hand; these are the invariants the lookup relies on.
func TestPriceRulesAreWellFormed(t *testing.T) {
	if len(priceRules) == 0 {
		t.Fatal("no price rules embedded")
	}
	statuses := map[string]bool{"official": true, "ocx-provided": true, "unpriced": true, "local-catalog": true}
	tiers := map[string]bool{"default": true, "priority": true, "flex": true}
	seen := map[string]bool{}
	for i, r := range priceRules {
		key := fmt.Sprintf("%s|%s|%v|%v|%s", r.Provider, r.Model, r.Peak, r.InputFrom, r.Tier)
		where := fmt.Sprintf("rule %d (%s)", i, key)
		if seen[key] {
			t.Errorf("%s: duplicate selector", where)
		}
		seen[key] = true
		if strings.TrimSpace(r.Provider) == "" || strings.TrimSpace(r.Model) == "" {
			t.Errorf("%s: empty provider or model", where)
		}
		if !tiers[r.Tier] {
			t.Errorf("%s: unknown tier %q", where, r.Tier)
		}
		if !statuses[r.Quote.Status] {
			t.Errorf("%s: unknown status %q", where, r.Quote.Status)
		}
		for name, rate := range r.Quote.Rates {
			if rate != nil && *rate < 0 {
				t.Errorf("%s: negative %s rate", where, name)
			}
		}
		if r.Quote.Status != "unpriced" && (r.Quote.Rates["input"] == nil || r.Quote.Rates["output"] == nil) {
			t.Errorf("%s: priced rule without input and output rates", where)
		}
		for _, d := range []*string{r.Quote.CheckedAt, r.Quote.EffectiveFrom, r.Quote.EffectiveTo} {
			if d != nil {
				if _, err := time.Parse("2006-01-02", *d); err != nil {
					t.Errorf("%s: date %q is not YYYY-MM-DD", where, *d)
				}
			}
		}
	}
}
