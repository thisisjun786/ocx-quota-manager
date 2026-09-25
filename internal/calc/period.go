package calc

const (
	PeriodOneHour        = "oneHour"
	PeriodFiveHour       = "fiveHour"
	PeriodTwentyFourHour = "twentyFourHour"
	PeriodWeekly         = "weekly"
	PeriodMonthly        = "monthly"
)

// PeriodHours is the shared sliding horizon ending at the last usage read.
// These are not provider reset cycles. 24h is not a calendar day.
var PeriodHours = map[string]float64{
	PeriodOneHour:        1,
	PeriodFiveHour:       5,
	PeriodTwentyFourHour: 24,
	PeriodWeekly:         168,
	PeriodMonthly:        720,
}

const (
	WeeklyCapacityHours  = 168.0
	MonthlyCapacityHours = 720.0
	MaxGapMs             = 20 * 60 * 1000
	MinIntervalMs        = 5 * 60 * 1000
	ResetToleranceMs     = 60 * 1000
	DipTolerancePp       = 1.0
	HourMs               = 3600 * 1000
)

func CapacityHours(windowID string) float64 {
	switch windowID {
	case "weekly":
		return WeeklyCapacityHours
	case "monthly":
		return MonthlyCapacityHours
	default:
		return 0
	}
}

func PreferredWindow(ids []string) string {
	has := map[string]bool{}
	for _, id := range ids {
		has[id] = true
	}
	if has["weekly"] {
		return "weekly"
	}
	if has["monthly"] {
		return "monthly"
	}
	return ""
}
