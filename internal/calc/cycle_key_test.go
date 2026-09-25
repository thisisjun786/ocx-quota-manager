package calc

import (
	"strconv"
	"testing"
	"time"
)

func TestResetDerivedCycleKeysKeepConsumptionAcrossTimestampDrift(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC).UnixMilli()
	reset := now + 7*24*HourMs
	for _, format := range []string{"iso", "milliseconds"} {
		t.Run(format, func(t *testing.T) {
			points := []Point{}
			for i := 0; i < 4; i++ {
				r := reset + int64(i)*123
				key := strconv.FormatInt(r, 10)
				if format == "iso" {
					key = time.UnixMilli(r).UTC().Format(time.RFC3339Nano)
				}
				points = append(points, Point{At: now - int64(3-i)*10*60*1000, Reset: r, Used: float64(i) * 10, CycleKey: key})
			}
			periods := ConsumePeriods(points, now)
			for _, key := range []string{PeriodOneHour, PeriodWeekly, PeriodMonthly} {
				if p := periods[key]; p.DeltaPp == nil || *p.DeltaPp != 30 {
					t.Fatalf("%s consumption=%v want30pp", key, p.DeltaPp)
				}
			}
		})
	}
}
func TestOpaqueCycleKeysNeverParseNumericPrefix(t *testing.T) {
	for _, keys := range [][2]string{{"2026-old", "2026-new"}, {"1700000000000-old", "1700000000000-new"}, {"1700000000000", "1700000000000junk"}} {
		reset := int64(1700000000000)
		if keys[0] == "2026-old" {
			reset = 2026
		}
		if sameCycleKey(Point{CycleKey: keys[0], Reset: reset}, Point{CycleKey: keys[1], Reset: reset}) {
			t.Fatal("opaque keys joined", keys)
		}
	}
}
