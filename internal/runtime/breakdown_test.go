package runtime

import (
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func TestCostBreakdownGroupsPeriodsAndMarksRemovedProviders(t *testing.T) {
	now := int64(1_800_000_000_000)
	acc := "a1"
	model := "m1"
	usd := func(v float64) *float64 { return &v }
	rows := []store.Usage{
		{ID: "old", At: now - 10*24*calc.HourMs, Provider: "anthropic", Account: &acc, Model: &model, Tokens: usd(5)},
		{ID: "wk", At: now - 3*24*calc.HourMs, Provider: "anthropic", Account: &acc, Model: &model, Tokens: usd(10)},
		{ID: "d1", At: now - calc.HourMs, Provider: "anthropic", Account: &acc, Model: &model, Tokens: usd(20)},
		{ID: "gone", At: now - 2*calc.HourMs, Provider: "command-code", Tokens: usd(7)},
	}
	prices := []calc.AppliedPrice{{USD: usd(1)}, {USD: usd(2)}, {USD: usd(4)}, {}}
	providers := []contract.Provider{{ID: "anthropic", Name: "Anthropic", Accounts: []contract.Account{{ID: "a1", Label: "me@x"}}}}
	out := costBreakdown(rows, prices, providers, now, time.UTC)
	periods := out["periods"].(map[string]any)
	day := periods["day"].(costPeriod)
	week := periods["week"].(costPeriod)
	month := periods["month"].(costPeriod)
	if day.Total.APIUsd != 4 || day.Total.Requests != 2 || day.Total.Unpriced != 0 || day.Total.Tokenless != 1 {
		t.Fatalf("day total %+v", day.Total)
	}
	if week.Total.APIUsd != 6 || month.Total.APIUsd != 7 || month.Total.Requests != 4 {
		t.Fatalf("week %+v month %+v", week.Total, month.Total)
	}
	if len(day.Providers) != 2 || day.Providers[0].Provider != "anthropic" || *day.Providers[0].Configured != true || *day.Providers[1].Configured != false {
		t.Fatalf("providers %+v", day.Providers)
	}
	if len(day.Accounts) != 2 || day.Accounts[0].Name != "me@x" || day.Accounts[1].Name != "계정 미확인" {
		t.Fatalf("accounts %+v", day.Accounts)
	}
	removed := out["removedProviders"].([]removedProvider)
	if len(removed) != 1 || removed[0].Provider != "command-code" || removed[0].Requests != 1 || removed[0].LastRequestAt == "" {
		t.Fatalf("removed providers %+v", removed)
	}
	daily := out["daily"].([]costDay)
	if len(daily) != 30 {
		t.Fatalf("daily len %d", len(daily))
	}
	var sum float64
	for _, d := range daily {
		sum += d.APIUsd
	}
	if sum != 7 {
		t.Fatalf("daily sum %v", sum)
	}
}

func TestAccountRosterOrdersByUrgency(t *testing.T) {
	now := int64(1_800_000_000_000)
	pct := func(v float64) *float64 { return &v }
	reset := time.UnixMilli(now + 3600_000).UTC().Format(time.RFC3339Nano)
	providers := []contract.Provider{{ID: "p", Name: "P", Accounts: []contract.Account{
		{ID: "healthy", Status: "ok", Windows: []contract.Window{{ID: "weekly", Label: "주간", RemainingPercent: pct(80)}}},
		{ID: "paused", Status: "paused", Windows: []contract.Window{{ID: "weekly", Label: "주간", RemainingPercent: pct(0)}}},
		{ID: "low", Status: "ok", Windows: []contract.Window{{ID: "five-hour", Label: "5시간", RemainingPercent: pct(90), ResetAt: &reset}, {ID: "weekly", Label: "주간", RemainingPercent: pct(5)}}},
		{ID: "warn", Status: "ok", Windows: []contract.Window{{ID: "weekly", Label: "주간", RemainingPercent: pct(25)}}},
	}}}
	got := accountRoster(providers, nil, nil, now)
	order := []string{}
	for _, r := range got {
		order = append(order, r.ID+":"+r.Health)
	}
	want := []string{"low:critical", "warn:warning", "healthy:ok", "paused:idle"}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order %v want %v", order, want)
		}
	}
	if got[0].Lowest == nil || got[0].Lowest.ID != "weekly" || got[0].NextReset == nil || *got[0].NextReset != reset {
		t.Fatalf("lowest/next reset %+v", got[0])
	}
}

func TestAccountRosterDoesNotFlagAHealthyStaleReading(t *testing.T) {
	pct := func(v float64) *float64 { return &v }
	stale := true
	got := accountRoster([]contract.Provider{{ID: "devin", Accounts: []contract.Account{
		{ID: "d", Status: "stale", Windows: []contract.Window{{ID: "weekly", Label: "주간", RemainingPercent: pct(48), Stale: &stale}}},
	}}}, nil, nil, 1_800_000_000_000)
	if got[0].Health != "ok" {
		t.Fatalf("a failed lookup with 48%% left is not urgent: %+v", got[0])
	}
}

func TestBucketSeriesUsesPeriodBarSizes(t *testing.T) {
	loc := time.UTC
	now := time.Date(2027, 1, 10, 12, 30, 0, 0, loc).UnixMilli()
	usd := func(v float64) *float64 { return &v }
	model := "m"
	rows := []store.Usage{
		{ID: "old", At: now - 25*calc.HourMs, Provider: "p", Model: &model},
		{ID: "a", At: now - 90*60*1000, Provider: "p", Model: &model},
		{ID: "b", At: now - 10*60*1000, Provider: "p", Model: &model},
	}
	prices := []calc.AppliedPrice{{USD: usd(9)}, {USD: usd(1)}, {USD: usd(2)}}
	out := costBreakdown(rows, prices, nil, now, loc)
	series := out["series"].(map[string]any)
	day := series["day"].(map[string]any)["buckets"].([]costBucket)
	week := series["week"].(map[string]any)["buckets"].([]costBucket)
	month := series["month"].(map[string]any)["buckets"].([]costBucket)
	// 24h ending 12:30: 11:30-12:00 partial, 23 full hours, 12:00-12:30 partial = 25 bars.
	if len(day) != 25 || day[0].From != "2027-01-09T12:30:00Z" || day[24].To != "2027-01-10T12:30:00Z" {
		t.Fatalf("day bars %d %s..%s", len(day), day[0].From, day[len(day)-1].To)
	}
	// The call at exactly 11:00 belongs to the bar ending at 11:00 (bars are
	// (from, to], like the period totals).
	if day[24].APIUsd != 2 || day[22].APIUsd != 1 || day[22].To != "2027-01-10T11:00:00Z" {
		t.Fatalf("hour bars %+v %+v", day[22], day[24])
	}
	// Bars cover exactly the span, so they add up to the period total.
	sum := func(bs []costBucket) (s float64) {
		for _, b := range bs {
			s += b.APIUsd
		}
		return
	}
	periods := out["periods"].(map[string]any)
	if sum(day) != periods["day"].(costPeriod).Total.APIUsd || sum(week) != periods["week"].(costPeriod).Total.APIUsd || sum(month) != periods["month"].(costPeriod).Total.APIUsd {
		t.Fatalf("bar sums %v %v %v vs totals", sum(day), sum(week), sum(month))
	}
	if week[0].From != "2027-01-03T12:30:00Z" || week[len(week)-1].To != "2027-01-10T12:30:00Z" || len(month) != 31 {
		t.Fatalf("week %s..%s month bars %d", week[0].From, week[len(week)-1].To, len(month))
	}
}

func TestBucketSeriesTrailingTotalIsTheSpanEndingAtEachBar(t *testing.T) {
	loc := time.UTC
	now := time.Date(2027, 1, 10, 12, 30, 0, 0, loc).UnixMilli()
	usd := func(v float64) *float64 { return &v }
	model := "m"
	h := int64(calc.HourMs)
	rows := []store.Usage{
		{ID: "old", At: now - 30*h, Provider: "p", Model: &model},
		{ID: "a", At: now - 20*h, Provider: "p", Model: &model},
		{ID: "b", At: now - 3*h, Provider: "p", Model: &model},
		{ID: "c", At: now - h/2, Provider: "p", Model: &model},
	}
	prices := []calc.AppliedPrice{{USD: usd(100)}, {USD: usd(10)}, {USD: usd(2)}, {USD: nil}}
	out := costBreakdown(rows, prices, nil, now, loc)
	day := out["series"].(map[string]any)["day"].(map[string]any)
	if day["spanHours"].(float64) != 24 {
		t.Fatalf("span %v", day["spanHours"])
	}
	bars := day["buckets"].([]costBucket)
	last := bars[len(bars)-1]
	// The last bar ends now: its 24-hour window holds a and b (12), not old
	// (30h ago) and not the unpriced c.
	if last.TrailingUsd != 12 || !last.TrailingComplete {
		t.Fatalf("last %+v", last)
	}
	if total := out["periods"].(map[string]any)["day"].(costPeriod).Total.APIUsd; total != last.TrailingUsd {
		t.Fatalf("last trailing %v != 24h total %v", last.TrailingUsd, total)
	}
	// The bar ending at 11:00 covers 11:00 the day before to 11:00: a (16:30
	// the day before) and b (09:30), not old (06:30 the day before).
	var at11 *costBucket
	for i := range bars {
		if bars[i].To == "2027-01-10T11:00:00Z" {
			at11 = &bars[i]
		}
	}
	if at11 == nil || at11.TrailingUsd != 12 {
		t.Fatalf("11:00 %+v", at11)
	}
	// A row exactly 24 hours before a bar's end lies outside that bar's window
	// and inside the previous one, the same (from, to] rule as the 24h total.
	edge := time.Date(2027, 1, 9, 11, 0, 0, 0, loc).UnixMilli()
	withEdge := append([]store.Usage{rows[0], {ID: "edge", At: edge, Provider: "p", Model: &model}}, rows[1:]...)
	edgePrices := append([]calc.AppliedPrice{prices[0], {USD: usd(1000)}}, prices[1:]...)
	bars = costBreakdown(withEdge, edgePrices, nil, now, loc)["series"].(map[string]any)["day"].(map[string]any)["buckets"].([]costBucket)
	for _, b := range bars {
		if b.To == "2027-01-10T11:00:00Z" && b.TrailingUsd != 12 {
			t.Fatalf("a row at the window start leaked in: %+v", b)
		}
	}
	// A 7-day window at the first week bar starts 14 days back, long before
	// the oldest row, so its total is marked incomplete.
	week := out["series"].(map[string]any)["week"].(map[string]any)["buckets"].([]costBucket)
	if week[0].TrailingComplete {
		t.Fatalf("a 7-day window starting 14 days back cannot be complete with 30 hours of rows: %+v", week[0])
	}
	if week[len(week)-1].TrailingUsd != 112 {
		t.Fatalf("7-day window at now holds every priced row: %+v", week[len(week)-1])
	}
}
