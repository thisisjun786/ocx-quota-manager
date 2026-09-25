package calc

import (
	"math"
	"testing"
)

func TestDipAndReboundIsNotCountedAsNewUse(t *testing.T) {
	min := int64(60_000)
	reset := int64(1e13)
	var pts []Point
	for at := int64(0); at <= 120; at += 5 {
		used := 10.0
		switch {
		case at == 65:
			used = 9.5
		case at >= 75:
			used = 12
		}
		pts = append(pts, Point{At: at * min, Reset: reset, Used: used})
	}
	// The hour ends at 125 min and starts at the 65-min dip, so the rebound to 10
	// lies inside it; only the rise from 10 to 12 is new use.
	got := ConsumePeriods(pts, 125*min)[PeriodOneHour]
	if got.DeltaPp == nil || math.Abs(*got.DeltaPp-2) > 1e-9 {
		t.Fatalf("dip and rebound counted as use: %v", got.DeltaPp)
	}
}

func TestResetWobbleWithinToleranceStaysOneCycle(t *testing.T) {
	min := int64(60_000)
	reset := int64(1e13)
	// Reset instants drift by up to 30s, inside ResetToleranceMs.
	pts := []Point{
		{At: 0, Reset: reset, Used: 20},
		{At: 5 * min, Reset: reset + 30_000, Used: 21},
		{At: 10 * min, Reset: reset - 20_000, Used: 23},
	}
	norm := Normalize(pts)
	if norm[0].SegmentID != norm[2].SegmentID {
		t.Fatalf("a reset wobble inside tolerance split the cycle: %+v", norm)
	}
	got := ConsumePeriods(pts, 10*min)[PeriodOneHour]
	if got.DeltaPp == nil || math.Abs(*got.DeltaPp-3) > 1e-9 {
		t.Fatalf("increment across a wobble: %v", got.DeltaPp)
	}
}

func TestDropBeyondToleranceStartsANewCycleInsteadOfNegativeUse(t *testing.T) {
	min := int64(60_000)
	reset := int64(1e13)
	pts := []Point{
		{At: 0, Reset: reset, Used: 40},
		{At: 5 * min, Reset: reset, Used: 5},
		{At: 10 * min, Reset: reset, Used: 7},
	}
	norm := Normalize(pts)
	if norm[1].SegmentID == norm[0].SegmentID {
		t.Fatalf("a large drop did not start a new segment: %+v", norm)
	}
	got := ConsumePeriods(pts, 10*min)[PeriodOneHour]
	if got.DeltaPp == nil || *got.DeltaPp < 0 || math.Abs(*got.DeltaPp-2) > 1e-9 {
		t.Fatalf("consumption after a drop: %v", got.DeltaPp)
	}
}
