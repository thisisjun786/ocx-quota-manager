package runtime

import (
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func TestSubscriptionAndUnpricedDetailsReachSnapshot(t *testing.T) {
	now := int64(1800000000000)
	h := openProbeStore(t)
	for _, u := range []store.Usage{
		{ID: "priced", Provider: "anthropic", Account: repairPtr("a"), At: now - calc.HourMs, USD: repairPtr(100.0)},
		{ID: "unlinked", Provider: "anthropic", At: now - calc.HourMs, Model: repairPtr("private-log-value")},
	} {
		if err := h.InsertUsage(u); err != nil {
			t.Fatal(err)
		}
	}
	top, providers, err := attachAnalytics([]contract.Provider{{ID: "anthropic", Accounts: []contract.Account{{ID: "a"}}}}, h, time.UnixMilli(now), "ok")
	if err != nil {
		t.Fatal(err)
	}
	p := providers[0].Analytics.(map[string]any)
	a := providers[0].Accounts[0].Analytics.(map[string]any)
	if p["subscriptionMonthlyUsd"] != 200.0 || *top["subscriptionMonthlyUsd"].(*float64) != 200 || a["monthlyValueRatio"] != .5 || a["monthlyValueBasis"] != "partial" {
		t.Fatal(top, p, a)
	}
	if p["unattributed"].(map[string]any)["requests"] != 1 || p["unpricedModels"].([]map[string]any)[0]["model"] != "" {
		t.Fatal(p)
	}
}

func TestUsageReadBoundaryFreezesPaceAndPeriods(t *testing.T) {
	now := int64(1800000000000)
	h := openProbeStore(t)
	if err := h.InsertUsage(store.Usage{ID: "u", Provider: "anthropic", Account: repairPtr("a"), At: now - 3*calc.HourMs, USD: repairPtr(10.0)}); err != nil {
		t.Fatal(err)
	}
	if err := h.SetMeta("usageObservedThrough", now-calc.HourMs); err != nil {
		t.Fatal(err)
	}
	if err := h.SetMeta("usageReadAt", now-24*calc.HourMs); err != nil {
		t.Fatal(err)
	}
	top, providers, err := attachAnalytics([]contract.Provider{{ID: "anthropic", Accounts: []contract.Account{{ID: "a"}}}}, h, time.UnixMilli(now), "ok")
	if err != nil {
		t.Fatal(err)
	}
	pace := providers[0].Analytics.(map[string]any)["pace"].(map[string]any)
	if pace["usdPerHour"] != 5.0 || pace["stale"] != true || top["usageStale"] != true {
		t.Fatal(pace, top)
	}
}
