package calc

import "testing"

func sampleOf(d float64, cov float64, span float64) *PeriodSample {
	return &PeriodSample{DeltaPp: &d, Coverage: &cov, SpanHours: span}
}

func TestSumConsumptionCountsOnlyReadingsInThePeriod(t *testing.T) {
	accounts := []AccountInput{
		{Status: "ok", Windows: []WindowInput{{ID: "weekly", ProviderWide: true, Periods: map[string]*PeriodSample{PeriodOneHour: sampleOf(8, 1, 1)}}}},
		// Paused accounts with no reading in the last hour.
		{Status: "paused", Windows: []WindowInput{{ID: "weekly", ProviderWide: true, Periods: map[string]*PeriodSample{}}}},
		{Status: "paused", Windows: []WindowInput{{ID: "weekly", ProviderWide: true, Periods: map[string]*PeriodSample{PeriodOneHour: {}}}}},
		// A model-scoped window is not the provider limit.
		{Status: "ok", Windows: []WindowInput{{ID: "custom-x", ProviderWide: false, Periods: map[string]*PeriodSample{PeriodOneHour: sampleOf(50, 1, 1)}}}},
	}
	got := SumConsumption(accounts, PeriodOneHour)
	if got.WindowID != "weekly" || got.DeltaPp == nil || *got.DeltaPp != 8 || got.Accounts != 3 || got.Measured != 1 || got.Unobserved != 2 {
		t.Fatalf("total %+v", got)
	}
	rec := RecommendFromTotal(accounts, got)
	// 8%p in one hour of a 168-hour window: 0.08 x 168 = 13.44 -> 14.
	if rec.RecommendedAccounts == nil || *rec.RecommendedAccounts != 14 || rec.SampleAccounts != 1 || rec.Status != "provisional" {
		t.Fatalf("recommendation %+v", rec)
	}
}

func TestSumConsumptionFallsBackToMonthlyAndMarksPartial(t *testing.T) {
	accounts := []AccountInput{
		{Status: "ok", Windows: []WindowInput{{ID: "monthly", ProviderWide: true, Periods: map[string]*PeriodSample{PeriodFiveHour: sampleOf(3, 0.5, 5)}}}},
	}
	got := SumConsumption(accounts, PeriodFiveHour)
	if got.WindowID != "monthly" || got.CapacityHours != MonthlyCapacityHours || !got.Partial || got.CoverageMean == nil || *got.CoverageMean != 0.5 {
		t.Fatalf("monthly %+v", got)
	}
	if rec := RecommendFromTotal(accounts, got); rec.Status != "provisional" {
		t.Fatalf("partial coverage must be provisional: %+v", rec)
	}
}

func TestSumConsumptionWithNoReadingIsUnobservedNotZero(t *testing.T) {
	accounts := []AccountInput{{Status: "paused", Windows: []WindowInput{{ID: "weekly", ProviderWide: true, Periods: map[string]*PeriodSample{}}}}}
	got := SumConsumption(accounts, PeriodOneHour)
	if got.DeltaPp != nil || got.Unobserved != 1 {
		t.Fatalf("unobserved %+v", got)
	}
	if rec := RecommendFromTotal(accounts, got); rec.RecommendedAccounts != nil || rec.Status != "collecting" {
		t.Fatalf("no count without a reading: %+v", rec)
	}
}
