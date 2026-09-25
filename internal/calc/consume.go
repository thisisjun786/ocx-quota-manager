package calc

import (
	"math"
	"strconv"
	"time"
)

// Point is one observation after identity/epoch filtering. Used is the
// observed percent (or the running high after dip flattening).
type Point struct {
	At               int64
	Reset            int64
	Used             float64
	ObservedPercent  float64
	Epoch            *int64
	WindowSemantics  string
	CycleKey         string
	Source           string
	SourceVersion    string
	Method           string
	ScopeKey         string
	Unit             string
	LimitValue       *float64
	LimitState       string
	UsedAccumulation string
	Reconciliation   string
	Legacy           bool
	Barrier          bool
	SegmentID        int
}

type PeriodSample struct {
	Key              string
	DeltaPp          *float64
	ObservedHours    float64
	SpanHours        float64
	Coverage         *float64
	RecoveredDeltaPp float64
	RecoveredHours   float64
	ResetGapCount    int
	PeriodEndedAt    int64
	Basis            string // observed-increase | recovered-gap | mixed | ""
}

type ResetGap struct {
	From, To                 int64
	LastPercent, NextPercent float64
	Barrier                  bool
}

func sameCycleKey(a, b Point) bool {
	if a.CycleKey == b.CycleKey {
		return true
	}
	ak, aok := cycleKeyInstant(a.CycleKey)
	bk, bok := cycleKeyInstant(b.CycleKey)
	return aok && bok && math.Abs(float64(ak)-float64(a.Reset)) <= ResetToleranceMs &&
		math.Abs(float64(bk)-float64(b.Reset)) <= ResetToleranceMs
}

// Node history stores reset-derived cycle keys as ISO dates or integer epoch
// milliseconds. Opaque identifiers must never acquire meaning from a prefix.
func cycleKeyInstant(key string) (int64, bool) {
	if key == "" {
		return 0, false
	}
	digits := true
	for _, c := range key {
		if c < '0' || c > '9' {
			digits = false
			break
		}
	}
	if digits {
		n, err := strconv.ParseInt(key, 10, 64)
		return n, err == nil
	}
	if t, err := time.Parse(time.RFC3339Nano, key); err == nil {
		return t.UnixMilli(), true
	}
	return 0, false
}

func sameBasis(a, b Point) bool {
	return ((a.Epoch == nil && b.Epoch == nil) || (a.Epoch != nil && b.Epoch != nil && *a.Epoch == *b.Epoch)) && a.Legacy == b.Legacy &&
		a.Source == b.Source && a.SourceVersion == b.SourceVersion &&
		a.Method == b.Method && a.ScopeKey == b.ScopeKey && a.Unit == b.Unit &&
		ptrEq(a.LimitValue, b.LimitValue) && a.LimitState == b.LimitState &&
		a.WindowSemantics == b.WindowSemantics && a.UsedAccumulation == b.UsedAccumulation
}

func ptrEq(a, b *float64) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func recoverable(row Point) bool {
	if row.Epoch == nil || row.WindowSemantics != "fixed_reset" || row.Reconciliation == "mismatch" || row.UsedAccumulation == "interval" {
		return false
	}
	if row.Source == "" || row.SourceVersion == "" || row.Method == "" || row.ScopeKey == "" || row.Unit == "" {
		return false
	}
	if row.Method == "used_limit" && row.UsedAccumulation != "cumulative" {
		return false
	}
	if row.LimitState == "present" {
		return row.LimitValue != nil && *row.LimitValue > 0
	}
	return row.LimitState == "missing" && (row.Method == "reported_percent" || row.Method == "reported_fraction")
}

func sameCycleBoundary(a, b Point) bool {
	return math.Abs(float64(a.Reset-b.Reset)) <= ResetToleranceMs && sameCycleKey(a, b)
}

func canJoin(anchor, previous, point Point) bool {
	if point.Barrier || !sameBasis(anchor, point) || !sameCycleKey(anchor, point) {
		return false
	}
	if point.At >= anchor.Reset {
		return false
	}
	gap := point.At - previous.At
	return gap <= MaxGapMs || (recoverable(previous) && recoverable(point))
}

// Normalize flattens 1pp reporting dips and starts a new segment on reset
// change, time reversal, or a drop larger than DipTolerancePp.
func Normalize(points []Point) []Point {
	out := make([]Point, 0, len(points))
	var anchor *Point
	high := math.Inf(-1)
	segment := -1
	var previous *Point
	for _, p := range points {
		p.ObservedPercent = p.Used
		gapOK := previous == nil || (p.At-previous.At > 0)
		resetOK := anchor != nil && math.Abs(float64(p.Reset-anchor.Reset)) <= ResetToleranceMs
		drop := high - p.Used
		if anchor == nil || !resetOK || !gapOK || drop > DipTolerancePp || !canJoin(*anchor, *previous, p) {
			cp := p
			anchor = &cp
			high = p.Used
			segment++
		} else if p.Used > high {
			high = p.Used
		}
		p.Used = high
		p.Reset = anchor.Reset
		p.SegmentID = segment
		out = append(out, p)
		prev := p
		previous = &prev
	}
	return out
}

func ResetGaps(points []Point) []ResetGap {
	var gaps []ResetGap
	for i := 1; i < len(points); i++ {
		before, after := points[i-1], points[i]
		if before.SegmentID == after.SegmentID {
			continue
		}
		if after.At-before.At <= MaxGapMs {
			continue
		}
		if sameCycleBoundary(before, after) {
			continue
		}
		gaps = append(gaps, ResetGap{
			From: before.At, To: after.At,
			LastPercent: before.ObservedPercent, NextPercent: after.ObservedPercent,
			Barrier: after.Barrier,
		})
	}
	return gaps
}

// ConsumePeriods totals 1h/5h/24h/7d/30d from a shared end instant.
// A long gap that starts before the selected horizon is not split into that
// horizon. A reset inside a gap is counted, never allocated.
func ConsumePeriods(points []Point, now int64) map[string]PeriodSample {
	accepted := make([]Point, 0, len(points))
	watermark := int64(math.MinInt64)
	barrier := false
	for _, p := range points {
		ordered := p.At > watermark
		if p.At > watermark {
			watermark = p.At
		}
		if !ordered || p.At > now || p.At >= p.Reset || p.Used < 0 || math.IsNaN(p.Used) || math.IsInf(p.Used, 0) {
			barrier = true
			continue
		}
		p.Barrier = p.Barrier || barrier
		accepted = append(accepted, p)
		barrier = false
	}
	pts := Normalize(accepted)
	gaps := ResetGaps(pts)
	out := map[string]PeriodSample{}
	for key, hours := range PeriodHours {
		horizon := int64(hours * HourMs)
		from := now - horizon
		var delta, observedHours, recoveredDelta, recoveredHours float64
		for i := 1; i < len(pts); i++ {
			before, after := pts[i-1], pts[i]
			if before.SegmentID != after.SegmentID || after.At <= from {
				continue
			}
			gap := float64(after.At - before.At)
			consumed := after.Used - before.Used
			if after.At-before.At > MaxGapMs {
				// Do not invent an hourly distribution for a gap that began
				// outside the selected period. Downward endpoints are not recovery.
				if before.At < from || after.ObservedPercent < before.ObservedPercent {
					continue
				}
				recoveredDelta += consumed
				recoveredHours += gap / HourMs
				continue
			}
			elapsed := float64(after.At - max64(before.At, from))
			if gap <= 0 {
				continue
			}
			observedHours += elapsed / HourMs
			delta += consumed * elapsed / gap
		}
		var spanHours float64
		if len(pts) > 0 {
			first, last := pts[0], pts[len(pts)-1]
			spanHours = math.Max(0, float64(last.At-max64(first.At, from))/HourMs)
		}
		enough := (observedHours+recoveredHours)*HourMs >= MinIntervalMs
		resets := 0
		for _, g := range gaps {
			if g.To > from {
				resets++
			}
		}
		sample := PeriodSample{
			Key: key, ObservedHours: observedHours, SpanHours: spanHours,
			RecoveredDeltaPp: recoveredDelta, RecoveredHours: recoveredHours,
			ResetGapCount: resets, PeriodEndedAt: now,
		}
		if enough {
			total := delta + recoveredDelta
			sample.DeltaPp = &total
			switch {
			case recoveredHours > 0 && observedHours > 0:
				sample.Basis = "mixed"
			case recoveredHours > 0:
				sample.Basis = "recovered-gap"
			default:
				sample.Basis = "observed-increase"
			}
		}
		if len(pts) > 0 {
			cov := math.Min(1, observedHours/hours)
			sample.Coverage = &cov
		}
		out[key] = sample
	}
	return out
}

// ConsumeBuckets allocates observed consumption into the given bucket edges
// (len(edges) = buckets+1, ascending) using the same rules as ConsumePeriods:
// each short interval is split by elapsed time; a long gap is counted whole in
// the bucket where it ends, and only if it began inside the series. A bucket
// with no observation at all has no value (nil), so the bars add up to the
// period total ConsumePeriods reports for the same span.
func ConsumeBuckets(points []Point, edges []int64) []*float64 {
	n := len(edges) - 1
	out := make([]*float64, n)
	if n <= 0 {
		return out
	}
	now := edges[n]
	accepted := make([]Point, 0, len(points))
	watermark := int64(math.MinInt64)
	barrier := false
	for _, p := range points {
		ordered := p.At > watermark
		if p.At > watermark {
			watermark = p.At
		}
		if !ordered || p.At > now || p.At >= p.Reset || p.Used < 0 || math.IsNaN(p.Used) || math.IsInf(p.Used, 0) {
			barrier = true
			continue
		}
		p.Barrier = p.Barrier || barrier
		accepted = append(accepted, p)
		barrier = false
	}
	pts := Normalize(accepted)
	delta := make([]float64, n)
	observed := make([]float64, n)
	for i := 1; i < len(pts); i++ {
		before, after := pts[i-1], pts[i]
		if before.SegmentID != after.SegmentID || after.At <= edges[0] {
			continue
		}
		gap := after.At - before.At
		if gap <= 0 {
			continue
		}
		consumed := after.Used - before.Used
		if gap > MaxGapMs {
			if before.At < edges[0] || after.ObservedPercent < before.ObservedPercent {
				continue
			}
			k := bucketOf(edges, after.At)
			delta[k] += consumed
			observed[k] += float64(gap)
			continue
		}
		for k := bucketOf(edges, max64(before.At+1, edges[0]+1)); k < n && edges[k] < after.At; k++ {
			lo, hi := max64(before.At, edges[k]), min64(after.At, edges[k+1])
			if hi <= lo {
				continue
			}
			share := float64(hi-lo) / float64(gap)
			delta[k] += consumed * share
			observed[k] += float64(hi - lo)
		}
	}
	for k := range out {
		if observed[k] > 0 {
			v := delta[k]
			out[k] = &v
		}
	}
	return out
}

// bucketOf returns the bucket holding instant at (edges[k] < at <= edges[k+1]).
func bucketOf(edges []int64, at int64) int {
	lo, hi := 0, len(edges)-2
	for lo < hi {
		mid := (lo + hi) / 2
		if at <= edges[mid+1] {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	return lo
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
