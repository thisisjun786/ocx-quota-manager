package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"testing"
	"time"
)

func TestConsumptionUsesPercentAcrossRawUnits(t *testing.T) {
	for _, unit := range []string{"usd-cents", "usd", "tokens", "requests", "percent"} {
		t.Run(unit, func(t *testing.T) {
			hist := openProbeStore(t)
			now := int64(1800000000000)
			reset := now + 3600000
			for i, percent := range []float64{10, 12} {
				raw := float64(10000 + i*2000)
				err := hist.InsertObservation(store.Observation{Provider: "cursor", Account: "a", Window: "monthly", At: now - 600000 + int64(i)*600000, Reset: &reset, ObservedPercent: percent, Used: &raw, Unit: &unit, LimitState: "missing", WindowSemantics: "fixed_reset", Basis: "observed", PrecisionEvidence: "{}", Reconciliation: "unverified", UsedAccumulation: "unknown"})
				if err != nil {
					t.Fatal(err)
				}
			}
			providers := []contract.Provider{{ID: "cursor", Accounts: []contract.Account{{ID: "a", Windows: []contract.Window{{ID: "monthly"}}}}}}
			_, got, err := attachAnalytics(providers, hist, time.UnixMilli(now), "ok")
			if err != nil {
				t.Fatal(err)
			}
			a := repairMap(t, got[0].Accounts[0].Windows[0].Analytics)
			periods := a["consumptionPeriods"].(map[string]any)
			day := periods["twentyFourHour"].(map[string]any)
			if day["deltaPp"] != float64(2) {
				t.Fatalf("raw unit %s leaked into percentage: %v", unit, day)
			}
		})
	}
}

func TestUnknownInputCannotBeRepricedAfterSelectorsLost(t *testing.T) {
	r := store.Usage{Provider: "anthropic", Model: repairPtr("m"), At: 1800000000000, Input: repairPtr(100.0), Output: repairPtr(10.0), Basis: repairPtr("unknown-input")}
	evidence := []store.Evidence{{Provider: "anthropic", Model: "m", Status: "official", Rates: [4]*float64{repairPtr(1.0), repairPtr(1.0)}}}
	got, _ := priceUsage([]store.Usage{r}, evidence, r.At)
	if got[0].USD != nil {
		t.Fatalf("lost selectors repriced: %+v", got[0])
	}
}

func TestValuedUsageFieldsReachPeriodDTO(t *testing.T) {
	row := store.Usage{Provider: "cursor", At: 1800000000000, USD: repairPtr(8.0), NoCacheUSD: repairPtr(10.0), CacheEstimated: true, EstimatedCachedTokens: 250, Basis: repairPtr("local-catalog")}
	got := buildUsagePeriods([]store.Usage{row}, []calc.AppliedPrice{{USD: row.USD, Origin: calc.OriginStored}}, nil, nil, row.At)
	period := repairMap(t, got.top["oneHour"])
	if period["apiUsd"] != 8.0 || period["noCacheApiUsd"] != 10.0 || period["estimatedCachedTokens"] != 250.0 || period["cacheEstimatedRequests"] != 1.0 {
		t.Fatal(period)
	}
}
