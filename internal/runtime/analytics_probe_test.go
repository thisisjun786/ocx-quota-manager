package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

func TestProbeHealthySnapshotRetainsAnalytics(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1_800_000_000_000).UTC()}
	home := writeProbeHome(t, map[string]string{"openai": "sk-test"})
	writeUsageLog(t, home, []map[string]any{
		{"requestId": "u1", "timestamp": 1_800_000_000_000 - 3_600_000, "provider": "openai", "model": "gpt-5.4",
			"usage": map[string]any{"inputTokens": 1000.0, "outputTokens": 100.0}},
		{"requestId": "u2", "timestamp": 1_800_000_000_000 - 1_000, "provider": "openai", "model": "gpt-5.4",
			"usage": map[string]any{"inputTokens": 2000.0, "outputTokens": 200.0}},
	})
	hist := openProbeStore(t)
	// Seed the actual physical binding that owns these epoch-1 observations.
	if epoch, err := hist.EpochForIdentity("openai", "key:default", "chatgpt_account_id", repairPtr(sha256Hex("qm-epoch-v1\x00account")), 1_800_000_000_000-24*3600_000); err != nil || epoch != 1 {
		t.Fatalf("seed epoch %d %v", epoch, err)
	}

	reset := int64(1_800_000_000_000 + 3600_000)
	if err := hist.InsertObservation(store.Observation{
		Provider: "openai", Account: "key:default", Window: "weekly",
		At: 1_800_000_000_000 - 24*3600_000, Reset: &reset, Basis: "ok",
		ObservedPercent: 0, LimitState: "missing", WindowSemantics: "fixed_reset", Epoch: repairPtr(int64(1)), Source: repairPtr("test"), SourceVersion: repairPtr("1"), Method: repairPtr("reported_percent"), ScopeKey: repairPtr("all"), Unit: repairPtr("percent"),
		PrecisionEvidence: "unknown", Reconciliation: "unverified", UsedAccumulation: "unknown",
	}); err != nil {
		t.Fatal(err)
	}
	if err := hist.InsertObservation(store.Observation{
		Provider: "openai", Account: "key:default", Window: "weekly",
		At: 1_800_000_000_000, Reset: &reset, Basis: "ok",
		ObservedPercent: 100, LimitState: "missing", WindowSemantics: "fixed_reset", Epoch: repairPtr(int64(1)), Source: repairPtr("test"), SourceVersion: repairPtr("1"), Method: repairPtr("reported_percent"), ScopeKey: repairPtr("all"), Unit: repairPtr("percent"),
		PrecisionEvidence: "unknown", Reconciliation: "unverified", UsedAccumulation: "unknown",
	}); err != nil {
		t.Fatal(err)
	}
	in, out := 5.0, 25.0
	if _, err := hist.InsertEvidence(store.Evidence{
		Provider: "openai", Model: "gpt-5.4", Status: "official",
		Rates: [4]*float64{&in, &out, nil, nil}, Conditions: []string{}, Unsupported: []string{},
		FirstRevision: "1", FirstSeenAt: 1_800_000_000_000,
	}); err != nil {
		t.Fatal(err)
	}

	fake := &collect.Fake{}
	fake.SetHost("chatgpt.com", transport.Response{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":100,"limit_window_seconds":604800}}}`)}, nil)
	rt := New(clk, hist, fake)
	rt.Home = home
	rt.Direct = []string{"openai"}
	srv := startProbeHTTP(t, rt)
	rt.cycle(context.Background())
	rt.cycle(context.Background())

	snap := getProbeSnapshot(t, srv)
	if snap.SchemaVersion != 1 {
		t.Fatalf("schema %d", snap.SchemaVersion)
	}
	analytics, _ := snap.Analytics.(map[string]any)
	if analytics == nil {
		raw, _ := json.Marshal(snap.Analytics)
		t.Fatalf("analytics %s", raw)
	}
	if _, ok := analytics["surfaces"]; ok {
		t.Fatal("surfaces name list must not replace computed analytics")
	}
	usage, _ := analytics["usage"].(map[string]any)
	if usage["status"] != "ok" {
		t.Fatalf("usage %+v", usage)
	}
	if n, _ := usage["requests"].(float64); n != 2 {
		t.Fatalf("usage requests %v (must not double-count)", usage["requests"])
	}
	cursor, _ := usage["cursor"].(map[string]any)
	if cursor == nil {
		t.Fatal("usage cursor missing")
	}
	if rows, err := hist.ListUsage(); err != nil || len(rows) != 2 {
		t.Fatalf("usage rows %v %v", len(rows), err)
	}

	acc := findAccount(t, snap, "openai", "key:default")
	if len(acc.Windows) == 0 {
		t.Fatal("missing weekly window")
	}
	win := acc.Windows[0]
	wA, _ := win.Analytics.(map[string]any)
	periods, _ := wA["consumptionPeriods"].(map[string]any)
	if periods == nil {
		t.Fatalf("window analytics %+v", win.Analytics)
	}
	day, _ := periods["twentyFourHour"].(map[string]any)
	if day["deltaPp"] == nil {
		t.Fatalf("24h %+v", day)
	}
	if n, _ := day["deltaPp"].(float64); n != 100 {
		t.Fatalf("24h deltaPp %v want 100", day["deltaPp"])
	}
	if day["basis"] != "observed-increase" && day["basis"] != "recovered-gap" && day["basis"] != "mixed" {
		t.Fatalf("24h basis %v", day["basis"])
	}

	// quotaRecommendations is a map of five periods, not one flat 24h object.
	// One provider may surface at the top level; the 24h tab is still 100pp over 24h.
	recs, _ := analytics["quotaRecommendations"].(map[string]any)
	dayRec, _ := recs[calc.PeriodTwentyFourHour].(map[string]any)
	if dayRec == nil {
		t.Fatalf("recommendation %+v", recs)
	}
	gotN := 0
	switch v := dayRec["recommendedAccounts"].(type) {
	case *int:
		if v != nil {
			gotN = *v
		}
	case int:
		gotN = v
	case float64:
		gotN = int(v)
	}
	if gotN != 7 {
		t.Fatalf("24h 100%%p weekly needed want 7 got %v (formula ceil(sumPp/100*168/24)) %+v", dayRec["recommendedAccounts"], dayRec)
	}
	monthly := calc.NeededAccounts(100, calc.MonthlyCapacityHours, 24)
	if monthly != 30 {
		t.Fatalf("monthly needed %d", monthly)
	}

	p := snap.Providers[0]
	pA, _ := p.Analytics.(map[string]any)
	if pA["modelPrices"] == nil {
		t.Fatalf("provider analytics %+v", p.Analytics)
	}
	if analytics["modelRoster"] == nil || analytics["priceEvidence"] == nil || analytics["ollamaComparison"] == nil {
		t.Fatalf("top analytics %+v", analytics)
	}
}

func TestFiveHourGapIsNotHourlyAllocated(t *testing.T) {
	now := int64(1_800_000_000_000)
	points := []calc.Point{
		{At: now - 6*3600_000, Reset: now + 3600_000, Used: 10, ObservedPercent: 10},
		{At: now, Reset: now + 3600_000, Used: 40, ObservedPercent: 40},
	}
	got := calc.ConsumePeriods(points, now)
	hour := got[calc.PeriodOneHour]
	if hour.DeltaPp != nil {
		t.Fatalf("5h+ gap must not fill 1h, got %+v", hour)
	}
	day := got[calc.PeriodTwentyFourHour]
	if day.DeltaPp != nil {
		t.Fatalf("unproven gap must remain unknown: %+v", day)
	}
}

// The dashboard reads provider.analytics.quotaRecommendations[period] for all five
// trailing horizons. A flat 24h object makes every tab the same count. Samples that
// differ by period must produce different recommended counts, and incompatible
// providers must not be added into one meaningful top-level count.
func TestQuotaRecommendationsArePerPeriod(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000).UTC()
	reset := int64(1_800_000_000_000 + 7*24*3600_000)
	obs := func(provider string, at int64, used float64) store.Observation {
		return store.Observation{
			Provider: provider, Account: "main", Window: "weekly",
			At: at, Reset: &reset, Basis: "ok", ObservedPercent: used, LimitState: "missing",
			WindowSemantics: "fixed_reset", Epoch: repairPtr(int64(1)), Source: repairPtr("test"),
			SourceVersion: repairPtr("1"), Method: repairPtr("reported_percent"), ScopeKey: repairPtr("all"),
			Unit: repairPtr("percent"), PrecisionEvidence: "unknown", Reconciliation: "unverified",
			UsedAccumulation: "unknown",
		}
	}
	hist := openProbeStore(t)
	// Observed rises, each pair inside the 20-minute gap limit:
	// 1h gets 10pp, 5h gets 20pp, 24h gets 50pp, the week and month get 100pp.
	// Weekly capacity 168h => ceil(pp/100*168/hours): 17, 7, 4, 1, 1.
	for _, row := range []store.Observation{
		obs("openai", 1_800_000_000_000-48*3600_000, 0),
		obs("openai", 1_800_000_000_000-48*3600_000+10*60_000, 50),
		obs("openai", 1_800_000_000_000-6*3600_000, 50),
		obs("openai", 1_800_000_000_000-6*3600_000+10*60_000, 80),
		obs("openai", 1_800_000_000_000-2*3600_000, 80),
		obs("openai", 1_800_000_000_000-2*3600_000+10*60_000, 90),
		obs("openai", 1_800_000_000_000-20*60_000, 90),
		obs("openai", 1_800_000_000_000-10*60_000, 100),
		obs("openai", 1_800_000_000_000, 100),
		// A second provider with its own week must not be summed into the top count.
		obs("anthropic", 1_800_000_000_000-2*3600_000, 0),
		obs("anthropic", 1_800_000_000_000, 50),
	} {
		if err := hist.InsertObservation(row); err != nil {
			t.Fatal(err)
		}
	}
	providers := []contract.Provider{
		{ID: "openai", Accounts: []contract.Account{{ID: "main", Status: "ok", Windows: []contract.Window{{ID: "weekly", IdentityEpoch: repairPtr(int64(1))}}}}},
		{ID: "anthropic", Accounts: []contract.Account{{ID: "main", Status: "ok", Windows: []contract.Window{{ID: "weekly", IdentityEpoch: repairPtr(int64(1))}}}}},
	}
	analytics, got, err := attachAnalytics(providers, hist, now, "absent")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{
		calc.PeriodOneHour: 17, calc.PeriodFiveHour: 7, calc.PeriodTwentyFourHour: 4,
		calc.PeriodWeekly: 1, calc.PeriodMonthly: 1,
	}
	check := func(where string, recs map[string]any) {
		t.Helper()
		if _, flat := recs["recommendedAccounts"]; flat {
			t.Fatalf("%s published a flat recommendation; UI reads a map of five periods: %+v", where, recs)
		}
		for key, n := range want {
			entry, _ := recs[key].(map[string]any)
			if entry == nil {
				t.Fatalf("%s missing %s: %+v", where, key, recs)
			}
			if entry["basisPeriod"] != key {
				t.Fatalf("%s %s basis %v", where, key, entry["basisPeriod"])
			}
			gotN := 0
			switch v := entry["recommendedAccounts"].(type) {
			case *int:
				if v == nil {
					t.Fatalf("%s %s recommended nil want %d", where, key, n)
				}
				gotN = *v
			case int:
				gotN = v
			case float64:
				gotN = int(v)
			default:
				t.Fatalf("%s %s recommended %v want %d", where, key, entry["recommendedAccounts"], n)
			}
			if gotN != n {
				t.Fatalf("%s %s recommended %d want %d (must not reuse the 24h sample)", where, key, gotN, n)
			}
		}
	}
	pA, _ := got[0].Analytics.(map[string]any)
	recs, _ := pA["quotaRecommendations"].(map[string]any)
	if recs == nil {
		t.Fatalf("provider recommendations %+v", pA["quotaRecommendations"])
	}
	check("openai", recs)
	top, _ := analytics["quotaRecommendations"].(map[string]any)
	if top == nil {
		t.Fatal("top quotaRecommendations missing")
	}
	if n, ok := top["recommendedAccounts"]; ok && n != nil {
		t.Fatalf("top-level summed incompatible providers: %v", n)
	}
	for _, key := range []string{calc.PeriodOneHour, calc.PeriodFiveHour, calc.PeriodTwentyFourHour, calc.PeriodWeekly, calc.PeriodMonthly} {
		entry, _ := top[key].(map[string]any)
		if entry == nil || entry["status"] != "collecting" {
			t.Fatalf("top %s must stay collecting, not a cross-provider sum: %+v", key, entry)
		}
	}
	wA, _ := got[0].Accounts[0].Windows[0].Analytics.(map[string]any)
	periods, _ := wA["consumptionPeriods"].(map[string]any)
	hour, _ := periods[calc.PeriodOneHour].(map[string]any)
	if _, ok := hour["recoveredHours"]; !ok {
		t.Fatalf("period DTO omitted recoveredHours: %+v", hour)
	}
}

func writeUsageLog(t *testing.T, home string, rows []map[string]any) {
	t.Helper()
	f, err := os.Create(filepath.Join(home, "usage.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	for _, row := range rows {
		if err := enc.Encode(row); err != nil {
			t.Fatal(err)
		}
	}
}
