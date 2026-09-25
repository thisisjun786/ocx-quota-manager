package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"testing"
)

func TestHistoricalConsumptionHasOwnPeriodEnd(t *testing.T) {
	now := int64(1800000000000)
	last := now - 10*24*calc.HourMs
	pts := []calc.Point{{At: last - calc.HourMs/3, Reset: last + calc.HourMs, Used: 10}, {At: last - calc.HourMs/6, Reset: last + calc.HourMs, Used: 20}, {At: last, Reset: last + calc.HourMs, Used: 30}}
	dto, samples := historicalConsumption(pts, now)
	_ = samples
	if dto == nil || samples[calc.PeriodOneHour].PeriodEndedAt != last || samples[calc.PeriodOneHour].DeltaPp == nil || *samples[calc.PeriodOneHour].DeltaPp != 20 {
		t.Fatal(dto)
	}
	current := calc.ConsumePeriods(pts, now)
	mapped := map[string]*calc.PeriodSample{}
	for k, p := range current {
		v := p
		mapped[k] = &v
	}
	rec := calc.RecommendQuotaAccounts([]calc.AccountInput{{Status: "stale", Windows: []calc.WindowInput{{ID: "weekly", ProviderWide: true, Periods: mapped}}}}, calc.PeriodOneHour)
	// A 10-day-old hour is not demand in the last hour: no recommendation.
	if rec.Status != "collecting" || rec.RecommendedAccounts != nil {
		t.Fatal(rec)
	}
	dto, _ = historicalConsumption(pts, last)
	if dto != nil {
		t.Fatal("fresh history duplicated")
	}
}
