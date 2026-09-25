package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func repairPtr[T any](v T) *T { return &v }

func TestPriceProviderAndEffectiveWindow(t *testing.T) {
	now := time.Date(2027, 1, 15, 0, 0, 0, 0, time.UTC).UnixMilli()
	row := store.Usage{Provider: "openai", Model: repairPtr("shared"), At: now, Input: repairPtr(1e6), Output: repairPtr(0.0)}
	base := store.Evidence{Provider: "openai", Model: "shared", Status: "official", Rates: [4]*float64{repairPtr(1.0), repairPtr(0.0)}}
	other := base
	other.Provider = "other"
	other.Rates[0] = repairPtr(99.0)
	future := base
	future.EffectiveFrom = repairPtr("2028-01-01T00:00:00Z")
	future.Rates[0] = repairPtr(99.0)
	expired := base
	expired.EffectiveTo = repairPtr("2027-01-15T00:00:00Z")
	invalid := base
	invalid.EffectiveFrom = repairPtr("not-a-date")
	reversed := base
	reversed.EffectiveFrom = repairPtr("2027-01-16T00:00:00Z")
	reversed.EffectiveTo = repairPtr("2027-01-15T00:00:00Z")
	latest := base
	latest.EffectiveFrom = repairPtr("2027-01-15T00:00:00Z")
	latest.Rates[0] = repairPtr(2.0)
	conflict := latest
	conflict.Rates[0] = repairPtr(3.0)
	for _, tc := range []struct {
		name     string
		evidence []store.Evidence
		want     *float64
	}{
		{"provider", []store.Evidence{other, base}, repairPtr(1.0)},
		{"future", []store.Evidence{future}, nil}, {"expired-exclusive", []store.Evidence{expired}, nil},
		{"invalid", []store.Evidence{invalid}, nil}, {"reversed", []store.Evidence{reversed}, nil},
		{"latest-inclusive", []store.Evidence{base, latest}, repairPtr(2.0)},
		{"conflict", []store.Evidence{latest, conflict}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := priceUsage([]store.Usage{row}, tc.evidence, now)
			if !reflect.DeepEqual(got[0].USD, tc.want) {
				t.Fatalf("USD=%v want=%v (%+v)", got[0].USD, tc.want, got[0])
			}
			settled := row
			settled.USD = repairPtr(0.0)
			got, _ = priceUsage([]store.Usage{settled}, tc.evidence, now)
			if got[0].USD == nil || *got[0].USD != 0 || got[0].Origin != "stored" {
				t.Fatal("stored zero changed", got)
			}
		})
	}
}

func repairMap(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err = json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func repairPeriod(t *testing.T, v any, key string) map[string]any {
	t.Helper()
	m := repairMap(t, v)
	p, ok := m["periods"].(map[string]any)
	if !ok {
		t.Fatal("missing usage periods", m)
	}
	s, ok := p[key].(map[string]any)
	if !ok {
		t.Fatal("missing period", key)
	}
	return s
}
func TestUsagePeriodsPreserveAttributionAndBoundaries(t *testing.T) {
	home, native := writeRuntimeFixture(t)
	now := int64(1800000000000)
	hist := openProbeStore(t)
	rows := []store.Usage{
		{ID: "listed", At: now, Provider: "openai", Account: repairPtr("pool1"), USD: repairPtr(1.25), Tokens: repairPtr(100.0)},
		{ID: "nil", At: now - 1, Provider: "openai", Tokens: repairPtr(50.0)},
		{ID: "deleted", At: now - 2, Provider: "openai", Account: repairPtr("gone"), USD: repairPtr(0.0)},
		{ID: "lower-bound", At: now - 3600000, Provider: "openai", USD: repairPtr(2.0)},
		{ID: "future", At: now + 1, Provider: "openai", USD: repairPtr(99.0)},
		{ID: "absent-provider", At: now, Provider: "missing", USD: repairPtr(3.0)},
	}
	for _, r := range rows {
		if err := hist.InsertUsage(r); err != nil {
			t.Fatal(err)
		}
	}
	rt := New(clock.Fixed{T: time.UnixMilli(now)}, hist, &collect.Fake{})
	rt.Home = home
	rt.CodexHome = native
	rt.cycle(context.Background())
	snap := rt.Snapshot()
	top := repairPeriod(t, snap.Analytics, "oneHour")
	p := repairPeriod(t, snap.Providers[0].Analytics, "oneHour")
	a := repairPeriod(t, findAccount(t, snap, "openai", "pool1").Analytics, "oneHour")
	for name, stats := range map[string]map[string]any{"top": top, "provider": p, "account": a} {
		want := map[string]float64{"top": 4, "provider": 3, "account": 1}[name]
		if stats["requests"] != want {
			t.Fatalf("%s requests=%v want%v", name, stats["requests"], want)
		}
		if stats["observedCoverageHours"] != nil && stats["observedCoverageHours"] != float64(0) {
			t.Fatal("invented observation", stats)
		}
	}
	if p["apiUsd"] != 1.25 || a["apiUsd"] != 1.25 || top["apiUsd"] != 4.25 || p["unknownPriceRequests"] != float64(1) {
		t.Fatal(top, p, a)
	}
	for _, key := range []string{"fiveHour", "twentyFourHour", "weekly", "monthly"} {
		period := repairPeriod(t, snap.Providers[0].Analytics, key)
		if period["requests"] != float64(4) || period["apiUsd"] != 3.25 {
			t.Fatal(key, period)
		}
	}
	if p["listedAccountRequests"] != float64(1) || p["unlistedAccountRequests"] != float64(1) || p["unattributedRequests"] != float64(1) {
		t.Fatal("partition", p)
	}
}

type repairFailHistory struct {
	*store.History
	fail string
}

func (h *repairFailHistory) ListObservations() ([]store.Observation, error) {
	if h.fail == "observations" {
		return nil, errors.New("injected")
	}
	return h.History.ListObservations()
}
func (h *repairFailHistory) ListUsage() ([]store.Usage, error) {
	if h.fail == "usage" {
		return nil, errors.New("injected")
	}
	return h.History.ListUsage()
}
func (h *repairFailHistory) ListEvidence() ([]store.Evidence, error) {
	if h.fail == "evidence" {
		return nil, errors.New("injected")
	}
	return h.History.ListEvidence()
}

func TestHistoryReadFailureKeepsLastGoodAnalysis(t *testing.T) {
	for _, failed := range []string{"observations", "usage", "evidence"} {
		t.Run(failed, func(t *testing.T) {
			home, native := writeRuntimeFixture(t)
			clk := &clock.Var{T: time.UnixMilli(1800000000000)}
			hist := &repairFailHistory{History: openProbeStore(t)}
			if err := hist.InsertUsage(store.Usage{ID: "saved", At: clk.T.UnixMilli(), Provider: "openai", Account: repairPtr("pool1"), USD: repairPtr(1.25)}); err != nil {
				t.Fatal(err)
			}
			rt := New(clk, hist, &collect.Fake{})
			rt.Home = home
			rt.CodexHome = native
			rt.cycle(context.Background())
			old := rt.Snapshot()
			oldBytes, _ := json.Marshal(old)
			oldA := repairMap(t, old.Analytics)
			hist.fail = failed
			clk.T = clk.T.Add(time.Minute)
			mustWrite(t, filepath.Join(home, "codex-quota-cache.json"), fmt.Sprintf(`{"version":1,"quotas":{"pool1":{"updatedAt":%d,"weeklyPercent":15}}}`, clk.T.UnixMilli()))
			rt.cycle(context.Background())
			next := rt.Snapshot()
			nextA := repairMap(t, next.Analytics)
			freshAccount := findAccount(t, next, "openai", "pool1")
			if len(freshAccount.Windows) == 0 || freshAccount.Windows[0].RemainingPercent == nil || *freshAccount.Windows[0].RemainingPercent != 85 {
				t.Fatal("history failure discarded fresh quota", freshAccount)
			}
			if nextA["status"] != "error" || nextA["usageStale"] != true {
				t.Fatal(nextA)
			}
			if nextA["lastCollectedAt"] != oldA["lastCollectedAt"] || *next.ObservedAt == *old.ObservedAt {
				t.Fatal("wrong clocks", nextA)
			}
			if !reflect.DeepEqual(nextA["periods"], oldA["periods"]) {
				t.Fatal("periods overwritten")
			}
			oldAccount := findAccount(t, old, "openai", "pool1")
			if !reflect.DeepEqual(next.Providers[0].Analytics, old.Providers[0].Analytics) || !reflect.DeepEqual(freshAccount.Analytics, oldAccount.Analytics) || !reflect.DeepEqual(freshAccount.Windows[0].Analytics, oldAccount.Windows[0].Analytics) {
				t.Fatal("nested lastgood lost")
			}
			afterBytes, _ := json.Marshal(old)
			if string(oldBytes) != string(afterBytes) {
				t.Fatal("published snapshot mutated")
			}
			hist.fail = ""
			clk.T = clk.T.Add(time.Minute)
			rt.cycle(context.Background())
			recovered := repairMap(t, rt.Snapshot().Analytics)
			if recovered["status"] != "ok" || recovered["lastCollectedAt"] == oldA["lastCollectedAt"] {
				t.Fatal("no recovery", recovered)
			}
			first := New(clk, hist, &collect.Fake{})
			first.Home = home
			hist.fail = failed
			first.cycle(context.Background())
			initial := repairMap(t, first.Snapshot().Analytics)
			if initial["status"] != "error" || initial["periods"] != nil || initial["lastCollectedAt"] != nil {
				t.Fatal("first failure fabricated analytics", initial)
			}
		})
	}
}

func TestAllUsagePeriodEdges(t *testing.T) {
	now := int64(1800000000000)
	for key, hours := range calc.PeriodHours {
		t.Run(key, func(t *testing.T) {
			start := now - int64(hours*calc.HourMs)
			rows := []store.Usage{}
			for i, at := range []int64{start - 1, start, start + 1, now, now + 1} {
				rows = append(rows, store.Usage{ID: fmt.Sprint(i), At: at, Provider: "openai", USD: repairPtr(1.0)})
			}
			prices, _ := priceUsage(rows, nil, now)
			result := buildUsagePeriods(rows, prices, nil, nil, now)
			m := repairMap(t, result.top[key])
			if m["requests"] != float64(2) || m["apiUsd"] != float64(2) {
				t.Fatal(m)
			}
		})
	}
}
func TestUsageCoverageIsBoundedByObservedMeta(t *testing.T) {
	hist := openProbeStore(t)
	now := int64(1800000000000)
	for k, v := range map[string]int64{"usageObservedSince": now - 7200000, "usageObservedThrough": now - 900000, "historyResetAt": now - 1800000} {
		if err := hist.SetMeta(k, v); err != nil {
			t.Fatal(err)
		}
	}
	h := observedUsageHours(hist, now, 1)
	if h == nil || *h != 0.25 {
		t.Fatal("observation must honor end and reset", h)
	}
}
func TestConflictingStoredEvidenceRemainsUnknown(t *testing.T) {
	hist := openProbeStore(t)
	_, err := hist.InsertEvidence(store.Evidence{Provider: "openai", Model: "m", Status: "official", Rates: [4]*float64{repairPtr(1.0), repairPtr(2.0)}, Conflict: map[string]any{"kind": "unresolved"}, FirstRevision: "r", FirstSeenAt: 1800000000000})
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := hist.ListEvidence()
	if err != nil {
		t.Fatal(err)
	}
	if len(evidence) != 1 || evidence[0].Conflict == nil {
		t.Fatal("lost conflict on DB read", evidence)
	}
	got, _ := priceUsage([]store.Usage{{Provider: "openai", Model: repairPtr("m"), Input: repairPtr(100.0), Output: repairPtr(0.0), At: 1800000000000}}, evidence, 1800000000000)
	if !got[0].UnknownPrice || got[0].USD != nil {
		t.Fatal(got)
	}
}

func TestCachedInputIsNotPricedTwice(t *testing.T) {
	row := store.Usage{Provider: "openai", Model: repairPtr("cached"), At: 1800000000000, Input: repairPtr(1000000.0), Output: repairPtr(0.0), Cached: repairPtr(500000.0)}
	rate := store.Evidence{Provider: "openai", Model: "cached", Status: "official", Rates: [4]*float64{repairPtr(2.0), repairPtr(0.0), repairPtr(0.2)}}
	got, _ := priceUsage([]store.Usage{row}, []store.Evidence{rate}, row.At)
	if got[0].USD == nil || *got[0].USD != 1.1 {
		t.Fatal("cached tokens counted at both rates", got)
	}
	rate.Rates[2] = nil
	got, _ = priceUsage([]store.Usage{row}, []store.Evidence{rate}, row.At)
	if got[0].USD != nil {
		t.Fatal("missing cache rate priced as free", got)
	}
}

func TestRetainAnalysisMatchesReorderedIDs(t *testing.T) {
	previous := contract.Snapshot{Analytics: map[string]any{"lastCollectedAt": "before"}, Providers: []contract.Provider{
		{ID: "p", Analytics: map[string]any{"p": 1}, Accounts: []contract.Account{
			{ID: "a", Analytics: map[string]any{"a": 1}, Windows: []contract.Window{{ID: "weekly", Analytics: map[string]any{"w": 1}}}},
			{ID: "b", Analytics: map[string]any{"b": 2}},
		}},
	}}
	current := []contract.Provider{{ID: "new"}, {ID: "p", Accounts: []contract.Account{{ID: "b"}, {ID: "new"}, {ID: "a", Windows: []contract.Window{{ID: "new"}, {ID: "weekly", RemainingPercent: repairPtr(42.0)}}}}}}
	_, got := retainAnalysis(previous, current)
	if got[0].Analytics != nil || got[1].Accounts[1].Analytics != nil || got[1].Accounts[2].Windows[0].Analytics != nil {
		t.Fatal("inherited unrelated analytics", got)
	}
	if !reflect.DeepEqual(got[1].Accounts[0].Analytics, previous.Providers[0].Accounts[1].Analytics) || !reflect.DeepEqual(got[1].Accounts[2].Windows[1].Analytics, previous.Providers[0].Accounts[0].Windows[0].Analytics) || *got[1].Accounts[2].Windows[1].RemainingPercent != 42 {
		t.Fatal("wrong ID mapping", got)
	}
}

func TestConditionalEvidenceCannotPriceUnselectedUsage(t *testing.T) {
	for _, tc := range []struct {
		name       string
		mult       *float64
		conditions []string
	}{
		{"priority", repairPtr(2.0), nil}, {"flex", repairPtr(0.5), nil},
		{"peak", nil, []string{"peak-hours"}}, {"cachewrite", nil, []string{"cache-write-assumed"}},
		{"longcontext", repairPtr(1.0), []string{"long-context"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hist := openProbeStore(t)
			_, err := hist.InsertEvidence(store.Evidence{Provider: "openai", Model: "m", Status: "official", Rates: [4]*float64{repairPtr(1.0), repairPtr(2.0)}, TierMultiplier: tc.mult, Conditions: tc.conditions, FirstRevision: "r", FirstSeenAt: 1800000000000})
			if err != nil {
				t.Fatal(err)
			}
			evidence, err := hist.ListEvidence()
			if err != nil {
				t.Fatal(err)
			}
			row := store.Usage{Provider: "openai", Model: repairPtr("m"), Input: repairPtr(100.0), Output: repairPtr(0.0), At: 1800000000000}
			got, _ := priceUsage([]store.Usage{row}, evidence, row.At)
			if got[0].USD != nil {
				t.Fatal("conditional evidence priced usage without selectors", got)
			}
			row.USD = repairPtr(1.25)
			got, _ = priceUsage([]store.Usage{row}, evidence, row.At)
			if got[0].USD == nil || *got[0].USD != 1.25 {
				t.Fatal("stored USD changed", got)
			}
		})
	}
}
