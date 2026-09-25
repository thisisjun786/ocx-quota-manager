package runtime

import (
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
	match := func(start, end int) {
		a, b := pts[start], pts[end]
		change := b.Used - a.Used
		if b.At-a.At < calc.MinIntervalMs || change <= 1e-6 {
			return
		}
		delta += change
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
				partial = true
				continue
			}
			if *u.Account != account {
				continue
			}
			if prices[i].USD == nil {
				partial = true
				continue
			}
			sum += *prices[i].USD
			n++
		}
		if sum > 0 {
			dollars += sum
			matchedDelta += change
			requests += n
			latestMatched = b
			if w.ResetAt == nil {
				historical = true
			} else if reset, err := time.Parse(time.RFC3339Nano, *w.ResetAt); err != nil || math.Abs(float64(reset.UnixMilli()-b.Reset)) > calc.ResetToleranceMs {
				historical = true
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
	if delta <= 0 || dollars <= 0 || requests == 0 {
		return out
	}
	capacity := dollars / delta * 100
	if math.IsInf(capacity, 0) || math.IsNaN(capacity) {
		return out
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
		out["historicalCapacity"] = map[string]any{"apiUsd": capacity, "observedAt": observedAt, "basis": out["capacityBasis"], "confidence": "low", "reason": out["capacityReason"], "remainingApiUsd": nil, "readingObservedAt": nil}
		out["capacityApiUsd"] = nil
		out["remainingApiUsd"] = nil
	}
	return out
}
