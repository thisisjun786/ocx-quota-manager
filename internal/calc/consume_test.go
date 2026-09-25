package calc

import "testing"

func ms(h float64) int64 { return int64(h * HourMs) }

func TestFiveHourGapNotAllocatedIntoOneHour(t *testing.T) {
	now := int64(1_800_000_000_000)
	// Two points 5h apart, both before the last 1h. The selected 1h tab
	// must not inherit a slice of that unobserved gap.
	points := []Point{
		{At: now - ms(6), Reset: now + ms(100), Used: 10, WindowSemantics: "fixed_reset", Source: "s", SourceVersion: "1", Method: "reported_percent", ScopeKey: "all", Unit: "%", LimitState: "missing"},
		{At: now - ms(1), Reset: now + ms(100), Used: 40, WindowSemantics: "fixed_reset", Source: "s", SourceVersion: "1", Method: "reported_percent", ScopeKey: "all", Unit: "%", LimitState: "missing"},
	}
	got := ConsumePeriods(points, now)
	one := got[PeriodOneHour]
	if one.DeltaPp != nil {
		t.Fatalf("1h must not split a 5h gap: %+v", one)
	}
	if one.RecoveredHours != 0 {
		t.Fatalf("recovered into 1h: %v", one.RecoveredHours)
	}
}

func TestResetInsideGapIsCountedNotAllocated(t *testing.T) {
	now := int64(1_800_000_000_000)
	points := []Point{
		{At: now - ms(10), Reset: now - ms(4), Used: 80, ObservedPercent: 80},
		{At: now - ms(2), Reset: now + ms(160), Used: 5, ObservedPercent: 5},
	}
	got := ConsumePeriods(points, now)
	week := got[PeriodWeekly]
	if week.ResetGapCount == 0 {
		t.Fatal("reset inside silence must be reported")
	}
	if week.DeltaPp != nil && *week.DeltaPp < 0 {
		t.Fatalf("must not invent a negative allocation: %v", *week.DeltaPp)
	}
}

func TestMidnightBoundaryUsesSharedEnd(t *testing.T) {
	// 2027-01-15T00:00:00Z
	now := int64(1799971200000)
	points := []Point{
		{At: now - ms(2), Reset: now + ms(100), Used: 10},
		{At: now - 60_000, Reset: now + ms(100), Used: 20},
	}
	got := ConsumePeriods(points, now)
	if got[PeriodOneHour].PeriodEndedAt != now || got[PeriodTwentyFourHour].PeriodEndedAt != now {
		t.Fatal("periods must share the same end instant")
	}
}

func TestRecommend24h100pp(t *testing.T) {
	delta := 100.0
	cov := 1.0
	sample := PeriodSample{DeltaPp: &delta, Coverage: &cov, SpanHours: 24, Basis: ""}
	need := RecommendQuotaAccounts([]AccountInput{{
		Status:  "ok",
		Windows: []WindowInput{{ID: "weekly", ProviderWide: true, Periods: map[string]*PeriodSample{PeriodTwentyFourHour: &sample}}},
	}}, PeriodTwentyFourHour)
	if need.RecommendedAccounts == nil || *need.RecommendedAccounts != 7 {
		t.Fatalf("weekly 24h 100pp: %+v", need)
	}
	need = RecommendQuotaAccounts([]AccountInput{{
		Status:  "ok",
		Windows: []WindowInput{{ID: "monthly", ProviderWide: true, Periods: map[string]*PeriodSample{PeriodTwentyFourHour: &sample}}},
	}}, PeriodTwentyFourHour)
	if need.RecommendedAccounts == nil || *need.RecommendedAccounts != 30 {
		t.Fatalf("monthly 24h 100pp: %+v", need)
	}
}

func TestStoredPriceNotRewritten(t *testing.T) {
	stored := 1.25
	line := UsageLine{Model: "gpt", InputTokens: 1e6, OutputTokens: 1e6, At: 100, StoredUSD: &stored}
	rate := 9.0
	got := ApplyPrice(line, []StoredRate{{Model: "gpt", Origin: OriginOfficial, Input: &rate, Output: &rate, EffectiveFrom: 0}})
	if got.Origin != OriginStored || got.USD == nil || *got.USD != 1.25 {
		t.Fatalf("%+v", got)
	}
}

func TestUnknownPriceStaysUnknown(t *testing.T) {
	got := ApplyPrice(UsageLine{Model: "secret", InputTokens: 10, At: 1}, nil)
	if !got.UnknownPrice || got.USD != nil {
		t.Fatalf("%+v", got)
	}
}

func TestCacheGuessDoesNotBecomeStored(t *testing.T) {
	in, out := 1.0, 2.0
	got := ApplyPrice(UsageLine{Model: "m", InputTokens: 1e6, OutputTokens: 1e6, CacheRead: 1e6, At: 5},
		[]StoredRate{{Model: "m", Origin: OriginReference, Input: &in, Output: &out, EffectiveFrom: 0}})
	if got.Origin != OriginReference || !got.CacheGuess {
		t.Fatalf("%+v", got)
	}
}

func TestFailuresStaySeparated(t *testing.T) {
	if ClassifyPeriod(nil, false) != StateUnsupported {
		t.Fatal("unsupported")
	}
	if ClassifyPeriod(nil, true) != StateUnknown {
		t.Fatal("unknown")
	}
	zero := 0.0
	cov := 1.0
	if ClassifyPeriod(&PeriodSample{DeltaPp: &zero, Coverage: &cov}, true) != StateMeasuredZero {
		t.Fatal("measured zero")
	}
}

func TestOllamaCompareMissingLocal(t *testing.T) {
	usd := 3.0
	got := CompareOllama(nil, nil, &UsageTotals{APIUsd: &usd})
	if !got.LocalMissing || got.Ratio != nil {
		t.Fatalf("%+v", got)
	}
}

func TestCanJoinUsesRecoverableGap(t *testing.T) {
	epoch := int64(1)
	a := Point{Epoch: &epoch, At: 0, Reset: ms(200), Used: 10, WindowSemantics: "fixed_reset", Source: "s", SourceVersion: "1", Method: "reported_percent", ScopeKey: "all", Unit: "%", LimitState: "missing", UsedAccumulation: "cumulative"}
	b := a
	b.At = ms(1)
	if !canJoin(a, a, b) {
		t.Fatal("short gap should join")
	}
}

func TestConsumptionBasisBarriers(t *testing.T) {
	epoch := int64(1)
	a := Point{At: 1800000000000, Reset: 1800010000000, Used: 10, ObservedPercent: 10, Epoch: &epoch, Source: "s", SourceVersion: "1", Method: "reported_percent", ScopeKey: "all", Unit: "percent", LimitState: "missing", WindowSemantics: "fixed_reset"}
	for _, test := range []struct {
		name string
		edit func(*Point)
	}{
		{"unit", func(p *Point) { p.Unit = "usd-cents" }},
		{"epoch", func(p *Point) { n := int64(2); p.Epoch = &n }},
		{"source", func(p *Point) { p.Source = "other" }},
		{"reset", func(p *Point) { p.Reset += 3600000 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			b := a
			b.At += 600000
			b.Used = 20
			b.ObservedPercent = 20
			test.edit(&b)
			got := ConsumePeriods([]Point{a, b}, b.At)[PeriodOneHour]
			if got.DeltaPp != nil {
				t.Fatalf("crossed %s boundary: %+v", test.name, got)
			}
		})
	}
	b := a
	b.At += 600000
	got := ConsumePeriods([]Point{a, b}, b.At)[PeriodOneHour]
	if got.DeltaPp == nil || *got.DeltaPp != 0 {
		t.Fatal("measured zero lost", got)
	}
}

func TestInvalidObservationCannotBridgeConsumption(t *testing.T) {
	now := int64(1800000000000)
	a := Point{At: now - 1200000, Reset: now + 3600000, Used: 10}
	bad := a
	bad.At -= 1000
	bad.Used = 50
	b := a
	b.At = now
	b.Used = 20
	got := ConsumePeriods([]Point{a, bad, b}, now)[PeriodOneHour]
	if got.DeltaPp != nil {
		t.Fatal("reversed observation bridged", got)
	}
}
