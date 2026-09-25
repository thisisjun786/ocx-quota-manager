package calc

// AccountNeed is the public recommendation for one provider / selected period.
// USD inversion never enters NeededAccounts.
type AccountNeed struct {
	Status              string
	BasisPeriod         string
	PeriodHours         float64
	WindowID            string
	CapacityHours       float64
	CurrentAccounts     int
	SampleAccounts      int
	MinimumAccounts     *int
	RecommendedAccounts *int
	AdditionalAccounts  *int
	TotalConsumedPp     *float64
	EstimatedMonthlyUSD *float64
	UsageStale          bool
	Reason              string
}

type AccountInput struct {
	Status     string
	MonthlyUSD *float64
	Windows    []WindowInput
}

// WindowInput carries one account window's consumption per trailing period.
type WindowInput struct {
	ID           string
	ProviderWide bool
	Periods      map[string]*PeriodSample
}

// RecommendQuotaAccounts turns the provider's consumption total for the
// period into an account count: ceil(sumPp/100 x capacityHours / periodHours).
func RecommendQuotaAccounts(accounts []AccountInput, periodKey string) AccountNeed {
	return RecommendFromTotal(accounts, SumConsumption(accounts, periodKey))
}

func RecommendFromTotal(accounts []AccountInput, t ConsumptionTotal) AccountNeed {
	current := 0
	for _, a := range accounts {
		if a.Status != "reauth" && a.Status != "paused" {
			current++
		}
	}
	need := AccountNeed{
		Status: "collecting", BasisPeriod: t.Period, PeriodHours: t.PeriodHours,
		WindowID: t.WindowID, CapacityHours: t.CapacityHours, CurrentAccounts: current,
		Reason: "주간·월간 쿼타 소모 기록을 기다리고 있습니다.",
	}
	if t.DeltaPp == nil {
		return need
	}
	needed := NeededAccounts(*t.DeltaPp, t.CapacityHours, t.PeriodHours)
	need.Status = "ready"
	if t.Partial || t.ObservedIncrease || t.Unobserved > 0 {
		need.Status = "provisional"
	}
	need.MinimumAccounts = &needed
	need.RecommendedAccounts = &needed
	add := needed - current
	if add < 0 {
		add = 0
	}
	need.AdditionalAccounts = &add
	total := *t.DeltaPp
	need.TotalConsumedPp = &total
	need.SampleAccounts = t.Measured
	// Monthly budget uses the mean subscription of the accounts that were measured.
	var prices []float64
	priceOK := true
	for _, a := range accounts {
		measured := false
		for _, w := range a.Windows {
			if w.ID == t.WindowID && w.ProviderWide {
				if s := w.Periods[t.Period]; s != nil && s.DeltaPp != nil && *s.DeltaPp >= 0 {
					measured = true
				}
			}
		}
		if !measured {
			continue
		}
		if a.MonthlyUSD != nil && *a.MonthlyUSD > 0 {
			prices = append(prices, *a.MonthlyUSD)
		} else {
			priceOK = false
		}
	}
	if priceOK && len(prices) == t.Measured && len(prices) > 0 {
		mean := 0.0
		for _, p := range prices {
			mean += p
		}
		usd := float64(needed) * mean / float64(len(prices))
		need.EstimatedMonthlyUSD = &usd
	}
	need.Reason = "선택 기간에 관측된 쿼타 소모 합계 기준: ceil(합계%p/100 × 한도 주기 시간 / 기간 시간), 여유분 없음"
	return need
}
