package runtime

import "testing"

// subscription_catalog.json is edited by hand; every entry must render as a subscription.
func TestSubscriptionCatalogIsWellFormed(t *testing.T) {
	check := func(where string, e subscriptionEntry) {
		if (e.MonthlyUSD == nil && e.Basis != "ambiguous") || (e.MonthlyUSD != nil && *e.MonthlyUSD < 0) {
			t.Errorf("%s: monthlyUsd must be non-negative, or null only for an ambiguous plan", where)
		}
		if e.Label == "" || e.Basis == "" {
			t.Errorf("%s: label and basis are required", where)
		}
	}
	if len(subscriptions.Overrides)+len(subscriptions.Plans) == 0 {
		t.Fatal("empty subscription catalog")
	}
	for provider, e := range subscriptions.Overrides {
		check("overrides."+provider, e)
	}
	for provider, plans := range subscriptions.Plans {
		for plan, e := range plans {
			check("plans."+provider+"."+plan, e)
		}
	}
}
