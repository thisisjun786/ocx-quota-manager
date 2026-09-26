package runtime

import (
	"fmt"
	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"math"
	"sort"
	"time"
)

// Pair only continuous, same-identity/scope/reset runs with that account's
// valued requests. Unpriced quota still enters the denominator.
func windowCapacity(provider, account string, w contract.Window, points []calc.Point, rows []store.Usage, prices []calc.AppliedPrice, now int64) map[string]any {
	out := map[string]any{"capacityApiUsd": nil, "remainingApiUsd": nil, "matchedApiUsd": nil, "capacityBasis": nil, "capacityReason": "같은 계정의 연속 쿼타 관측과 환산 가능한 사용 기록을 기다리고 있습니다."}
	if w.ID != "weekly" && w.ID != "monthly" && w.ID != "five-hour" && w.ID != "short" {
		return out
	}
	if w.UsageScope != nil && *w.UsageScope != "provider" && *w.UsageScope != "all" && *w.UsageScope != "" {
		return out
	}
	// Only the epoch carried by this reading may contribute observations.
	var accepted []calc.Point
	watermark := int64(0)
	barrier := false
	for _, p := range points {
		if ((p.Epoch == nil) != (w.IdentityEpoch == nil)) || (p.Epoch != nil && w.IdentityEpoch != nil && *p.Epoch != *w.IdentityEpoch) || p.At < now-30*24*calc.HourMs || p.At <= watermark || p.At > now || p.Reset <= p.At || !validTokenCount(p.Used) || p.Used > 100 {
			barrier = true
			continue
		}
		watermark = p.At
		p.Barrier = p.Barrier || barrier
		accepted = append(accepted, p)
		barrier = false
	}
	pts := calc.Normalize(accepted)
	if len(pts) < 2 {
		return out
	}
	var dollars, delta, matchedDelta float64
	var latestMatched calc.Point
	historical := false
	partial := false
	requests := 0
	// Runs are grouped by the reset they belong to: one cycle per limit period.
	var cycles []*capacityCycle
	cycleFor := func(p calc.Point) *capacityCycle {
		for _, c := range cycles {
			if math.Abs(float64(c.reset-p.Reset)) <= calc.ResetToleranceMs {
				return c
			}
		}
		c := &capacityCycle{reset: p.Reset, from: p.At}
		cycles = append(cycles, c)
		return c
	}
	match := func(start, end int) {
		a, b := pts[start], pts[end]
		change := b.Used - a.Used
		if b.At-a.At < calc.MinIntervalMs || change <= 1e-6 {
			return
		}
		c := cycleFor(b)
		if a.At < c.from {
			c.from = a.At
		}
		c.to = b.At
		c.delta += change
		sum := 0.0
		n := 0
		// rows are ordered by time; skip straight to the interval.
		first := sort.Search(len(rows), func(i int) bool { return rows[i].At > a.At })
		for i := first; i < len(rows) && rows[i].At <= b.At; i++ {
			u := rows[i]
			if u.Provider != provider {
				continue
			}
			if u.Account == nil {
				c.partial = true
				continue
			}
			if *u.Account != account {
				continue
			}
			if prices[i].USD == nil {
				c.partial = true
				continue
			}
			sum += *prices[i].USD
			n++
		}
		if sum > 0 {
			c.dollars += sum
			c.matched += change
			c.requests += n
			c.latestMatched = b
			if w.ResetAt == nil {
				c.historical = true
			} else if reset, err := time.Parse(time.RFC3339Nano, *w.ResetAt); err != nil || math.Abs(float64(reset.UnixMilli()-b.Reset)) > calc.ResetToleranceMs {
				c.historical = true
			}
		}
	}
	start := 0
	for i := 1; i < len(pts); i++ {
		if pts[i].SegmentID != pts[start].SegmentID || pts[i].At-pts[i-1].At > calc.MaxGapMs {
			match(start, i-1)
			start = i
		}
	}
	match(start, len(pts)-1)
	selected, shift := selectCapacityCycles(cycles)
	for _, c := range selected {
		delta += c.delta
		partial = partial || c.partial
		if c.dollars > 0 {
			dollars += c.dollars
			matchedDelta += c.matched
			requests += c.requests
			historical = historical || c.historical
			if c.latestMatched.At > latestMatched.At {
				latestMatched = c.latestMatched
			}
		}
	}
	if delta <= 0 || dollars <= 0 || requests == 0 {
		return out
	}
	capacity := dollars / delta * 100
	if math.IsInf(capacity, 0) || math.IsNaN(capacity) {
		return out
	}
	out["capacityCycles"] = cycleDTOs(cycles, selected)
	out["capacityCycleCount"] = len(selected)
	if lo, hi, ok := cycleRange(selected); ok {
		out["capacityRangeApiUsd"] = map[string]any{"low": lo, "high": hi}
	}
	if shift != nil {
		out["capacityShift"] = shift
	}
	out["capacityApiUsd"] = capacity
	out["matchedApiUsd"] = dollars
	out["matchedDeltaPp"] = matchedDelta
	out["capacityObservedDeltaPp"] = delta
	out["unexplainedDeltaPp"] = delta - matchedDelta
	out["capacityBasis"] = "matched"
	if historical {
		out["capacityBasis"] = "historical"
	}
	if partial {
		out["capacityBasis"] = "partial"
	}
	if delta > matchedDelta {
		out["capacityBasis"] = "lower-bound"
	}
	out["confidence"] = "low"
	out["capacityReason"] = "같은 계정의 연속 관측 구간에서 API 환산액과 쿼타 소모를 비교한 추정입니다."
	if len(selected) > 0 && selected[0].usable() {
		out["capacityReason"] = fmt.Sprintf("최근 한도 주기 %d개에서 API 환산액과 쿼타 소모를 비교한 추정입니다.", len(selected))
		if len(selected) >= 2 {
			out["confidence"] = "medium"
		}
	}
	if shift != nil {
		out["capacityReason"] = out["capacityReason"].(string) + " 공급량 변경이 감지되어 변경 이후 주기만 사용합니다."
	}
	latest := pts[len(pts)-1]
	resetMatches := false
	if w.ResetAt != nil {
		if reset, err := time.Parse(time.RFC3339Nano, *w.ResetAt); err == nil {
			resetMatches = math.Abs(float64(reset.UnixMilli()-latest.Reset)) <= calc.ResetToleranceMs
		}
	}
	readingMatches := resetMatches && now-latest.At <= 15*60*1000 && w.RemainingPercent != nil && math.Abs((100-*w.RemainingPercent)-latest.ObservedPercent) < 1e-6
	if readingMatches && (w.Stale == nil || !*w.Stale) && w.RemainingPercent != nil && *w.RemainingPercent >= 0 && *w.RemainingPercent <= 100 {
		out["remainingApiUsd"] = capacity * *w.RemainingPercent / 100
	}
	observedAt := time.UnixMilli(latestMatched.At).UTC().Format(time.RFC3339Nano)
	out["capacityObservedAt"] = observedAt
	out["capacityMatchedQuotaCoverage"] = matchedDelta / delta
	if !readingMatches || (w.Stale != nil && *w.Stale) {
		out["historicalCapacity"] = map[string]any{"apiUsd": capacity, "observedAt": observedAt, "basis": out["capacityBasis"], "confidence": out["confidence"], "reason": out["capacityReason"], "remainingApiUsd": nil, "readingObservedAt": nil}
		out["capacityApiUsd"] = nil
		out["remainingApiUsd"] = nil
	}
	return out
}

// Cycle selection. A cycle needs this much matched quota movement before its
// ratio is trusted; smaller moves are dominated by integer-percent rounding.
const (
	cycleMinMatchedPp = 5.0
	cycleShiftRatio   = 0.25
	cycleEstimateN    = 3
)

type capacityCycle struct {
	reset, from, to         int64
	dollars, delta, matched float64
	requests                int
	partial, historical     bool
	latestMatched           calc.Point
}

func (c *capacityCycle) usable() bool {
	return c.matched >= cycleMinMatchedPp && c.dollars > 0 && c.requests > 0
}

func (c *capacityCycle) apiUsd() float64 { return c.dollars / c.delta * 100 }

func median(values []float64) float64 {
	s := append([]float64(nil), values...)
	sort.Float64s(s)
	if len(s)%2 == 1 {
		return s[len(s)/2]
	}
	return (s[len(s)/2-1] + s[len(s)/2]) / 2
}

// selectCapacityCycles returns the cycles the estimate is built from and the
// latest detected supply change. Usable cycles form regimes: a regime ends when
// two consecutive usable cycles sit more than cycleShiftRatio away from the
// regime's median in the same direction (a single outlier is usage noise). The
// estimate pools the last cycleEstimateN usable cycles of the latest regime.
// Without any usable cycle every observed cycle is pooled, as before.
func selectCapacityCycles(cycles []*capacityCycle) ([]*capacityCycle, map[string]any) {
	sort.Slice(cycles, func(i, j int) bool { return cycles[i].from < cycles[j].from })
	var usable []*capacityCycle
	for _, c := range cycles {
		if c.usable() {
			usable = append(usable, c)
		}
	}
	if len(usable) == 0 {
		return cycles, nil
	}
	regime := 0
	var shift map[string]any
	for i := regime + 2; i+1 < len(usable); i++ {
		var base []float64
		for _, c := range usable[regime:i] {
			base = append(base, c.apiUsd())
		}
		m := median(base)
		a, b := usable[i].apiUsd()/m-1, usable[i+1].apiUsd()/m-1
		if math.Abs(a) > cycleShiftRatio && math.Abs(b) > cycleShiftRatio && (a > 0) == (b > 0) {
			after := []float64{usable[i].apiUsd(), usable[i+1].apiUsd()}
			shift = map[string]any{
				"at":           time.UnixMilli(usable[i].from).UTC().Format(time.RFC3339Nano),
				"beforeApiUsd": m,
				"afterApiUsd":  median(after),
				"changeRatio":  median(after)/m - 1,
			}
			regime = i
			i = regime + 1
		}
	}
	selected := usable[regime:]
	if len(selected) > cycleEstimateN {
		selected = selected[len(selected)-cycleEstimateN:]
	}
	return selected, shift
}

func cycleRange(selected []*capacityCycle) (float64, float64, bool) {
	if len(selected) < 2 {
		return 0, 0, false
	}
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, c := range selected {
		if !c.usable() {
			return 0, 0, false
		}
		lo, hi = math.Min(lo, c.apiUsd()), math.Max(hi, c.apiUsd())
	}
	return lo, hi, true
}

func cycleDTOs(cycles, selected []*capacityCycle) []map[string]any {
	used := map[*capacityCycle]bool{}
	for _, c := range selected {
		used[c] = true
	}
	out := []map[string]any{}
	for _, c := range cycles {
		if c.dollars <= 0 {
			continue
		}
		out = append(out, map[string]any{
			"from": time.UnixMilli(c.from).UTC().Format(time.RFC3339Nano), "to": time.UnixMilli(c.to).UTC().Format(time.RFC3339Nano),
			"resetAt": time.UnixMilli(c.reset).UTC().Format(time.RFC3339Nano),
			"apiUsd":  c.apiUsd(), "deltaPp": c.delta, "matchedDeltaPp": c.matched, "matchedApiUsd": c.dollars,
			"usable": c.usable(), "selected": used[c],
		})
	}
	return out
}
