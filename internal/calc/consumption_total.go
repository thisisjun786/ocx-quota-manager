package calc

// ConsumptionTotal is the single definition of "quota consumed by a provider
// in a trailing period". The summary figure and the needed-account estimate
// both read it, so the two can no longer disagree.
//
// Rules:
//   - The window is the provider-wide weekly limit, else monthly.
//   - Only consumption observed inside the selected period counts. A past
//     period of an account with no reading now is not demand in this period.
//   - Accounts that hold the window but have no reading are counted as
//     unobserved, never as zero.
type ConsumptionTotal struct {
	Period           string
	PeriodHours      float64
	WindowID         string
	CapacityHours    float64
	DeltaPp          *float64
	Accounts         int // accounts holding the window
	Measured         int // accounts with a reading in the period
	Unobserved       int // accounts holding the window without a reading
	CoverageMean     *float64
	SpanHoursMean    float64
	Partial          bool // any measured account covered less than the full period
	ObservedIncrease bool // summed from observed increases without a known reset cycle
	RecoveredPp      float64
	ResetGaps        int
}

func SumConsumption(accounts []AccountInput, periodKey string) ConsumptionTotal {
	hours := PeriodHours[periodKey]
	t := ConsumptionTotal{Period: periodKey, PeriodHours: hours}
	for _, id := range []string{"weekly", "monthly"} {
		for _, a := range accounts {
			for _, w := range a.Windows {
				if w.ID == id && w.ProviderWide {
					t.WindowID = id
				}
			}
		}
		if t.WindowID != "" {
			break
		}
	}
	t.CapacityHours = CapacityHours(t.WindowID)
	if t.WindowID == "" || hours <= 0 {
		return t
	}
	var sum, coverage float64
	coverageKnown := true
	for _, a := range accounts {
		held := false
		var sample *PeriodSample
		for _, w := range a.Windows {
			if w.ID != t.WindowID || !w.ProviderWide {
				continue
			}
			held = true
			if s := w.Periods[periodKey]; s != nil && s.DeltaPp != nil && *s.DeltaPp >= 0 {
				sample = s
			}
		}
		if !held {
			continue
		}
		t.Accounts++
		if sample == nil {
			t.Unobserved++
			continue
		}
		t.Measured++
		sum += *sample.DeltaPp
		t.SpanHoursMean += sample.SpanHours
		if sample.Coverage == nil {
			coverageKnown = false
		} else {
			coverage += *sample.Coverage
		}
		if sample.Coverage == nil || *sample.Coverage < 1-1e-9 || sample.SpanHours < hours-1.0/3600 {
			t.Partial = true
		}
		if sample.Basis == "observed-increase" {
			t.ObservedIncrease = true
		}
		t.RecoveredPp += sample.RecoveredDeltaPp
		t.ResetGaps += sample.ResetGapCount
	}
	if t.Measured == 0 {
		return t
	}
	t.DeltaPp = &sum
	t.SpanHoursMean /= float64(t.Measured)
	if coverageKnown {
		mean := coverage / float64(t.Measured)
		t.CoverageMean = &mean
	}
	return t
}
