package calc

import (
	"math"
	"testing"
)

func TestConsumeBucketsSplitsIntervalsAndMatchesPeriodTotal(t *testing.T) {
	min := int64(60_000)
	reset := int64(10_000) * min
	// Readings every 5 minutes for 3 hours, +1pp each: 36pp.
	var pts []Point
	for i := int64(0); i <= 36; i++ {
		pts = append(pts, Point{At: i * 5 * min, Reset: reset, Used: float64(i)})
	}
	edges := []int64{0, 60 * min, 120 * min, 180 * min}
	got := ConsumeBuckets(pts, edges)
	for k, v := range got {
		if v == nil || math.Abs(*v-12) > 1e-9 {
			t.Fatalf("bucket %d = %v, want 12", k, v)
		}
	}
	// The same points summed by ConsumePeriods over the last hour agree with the last bucket.
	periods := ConsumePeriods(pts, 180*min)
	if p := periods[PeriodOneHour]; p.DeltaPp == nil || math.Abs(*p.DeltaPp-*got[2]) > 1e-9 {
		t.Fatalf("period 1h %v vs bucket %v", p.DeltaPp, *got[2])
	}
}

func TestConsumeBucketsSplitsOneIntervalAcrossTwoBuckets(t *testing.T) {
	min := int64(60_000)
	pts := []Point{{At: 50 * min, Reset: 1e12, Used: 10}, {At: 70 * min, Reset: 1e12, Used: 14}}
	got := ConsumeBuckets(pts, []int64{0, 60 * min, 120 * min})
	if got[0] == nil || got[1] == nil || math.Abs(*got[0]-2) > 1e-9 || math.Abs(*got[1]-2) > 1e-9 {
		t.Fatalf("split %v %v", got[0], got[1])
	}
}

func TestConsumeBucketsLeavesUnobservedBucketsEmpty(t *testing.T) {
	min := int64(60_000)
	pts := []Point{{At: 0, Reset: 1e12, Used: 1}, {At: 10 * min, Reset: 1e12, Used: 2}}
	got := ConsumeBuckets(pts, []int64{0, 60 * min, 120 * min})
	if got[0] == nil || got[1] != nil {
		t.Fatalf("observed then unobserved: %v %v", got[0], got[1])
	}
}
