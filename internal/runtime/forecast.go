package runtime

import (
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
)

const (
	forecastWeekMs     = int64(168 * calc.HourMs)
	forecastMonthMs    = int64(720 * calc.HourMs)
	forecastStaleMs    = int64(15 * 60 * 1000)
	forecastSkewMs     = int64(60 * 1000)
	forecastMinMs      = int64(5 * 60 * 1000)
	forecastMinRateMs  = int64(15 * 60 * 1000)
	forecastMinDeltaPp = 2.0
)

// windowForecast publishes the seven-day burn of one already filtered window.
// The caller passes observations for this window and identity only. The rate
// divides by watched time plus recovered same-cycle gaps, not by the 168h wall.
// An ETA needs the current reset and a fresh reading that matches the snapshot.
// A stale, failed, missing, or short sample can still expose the historic rate.
func windowForecast(w contract.Window, points []calc.Point, now int64) map[string]any {
	out := map[string]any{
		"status": "collecting", "reason": "새 측정값이 5분 이상 쌓이면 계산합니다.",
		"forecastRatePpHour": nil, "forecastObservedHours": 0.0, "forecastSpanHours": 0.0,
		"forecastCoverage": (*float64)(nil), "forecastObservedAt": nil,
		"forecastDeltaPp": (*float64)(nil), "forecastBasisPeriod": "weekly",
		"forecastRecoveredHours": 0.0, "forecastRecoveredDeltaPp": 0.0,
		"forecastReason": "새 측정값이 5분 이상 쌓이면 계산합니다.", "exhaustsAt": nil, "resetBeforeExhaustion": nil,
		"projectedUsedAtReset": nil, "history": []map[string]any{},
	}
	pts := forecastSeries(points, now)
	out["history"] = sampleForecastHistory(forecastHistory(pts, w, now))
	if len(pts) == 0 {
		forecastNote(out, "관측이 없어 소진 시각을 계산하지 않습니다.")
		return out
	}
	measuredAt := pts[len(pts)-1].At
	observedH, observedD, spanH := observedForecast(pts, measuredAt)
	recoveredH, recoveredD := recoveredForecast(pts, measuredAt)
	out["forecastObservedHours"] = observedH
	out["forecastSpanHours"] = spanH
	out["forecastRecoveredHours"] = recoveredH
	out["forecastRecoveredDeltaPp"] = recoveredD
	if spanH > 0 {
		cov := math.Min(1, observedH/spanH)
		out["forecastCoverage"] = &cov
	}
	out["forecastObservedAt"] = time.UnixMilli(measuredAt).UTC().Format(time.RFC3339Nano)
	hours := observedH + recoveredH
	delta := observedD + recoveredD
	if hours*float64(calc.HourMs) >= float64(forecastMinMs) {
		out["forecastDeltaPp"] = &delta
	}
	var rate *float64
	if hours > 0 && hours*float64(calc.HourMs) >= float64(forecastMinMs) {
		v := delta / hours
		rate = &v
		out["forecastRatePpHour"] = rate
		forecastNote(out, "최근 7일 관측과 같은 주기 복원 구간의 평균입니다.")
		if recoveredH > 0 {
			forecastNote(out, "최근 7일 관측과 끊긴 같은 주기 구간의 전체 경과를 분모로 나눈 평균입니다.")
		}
	} else {
		forecastNote(out, "관측이 5분 미만이라 속도만 보류합니다.")
	}
	reset, resetOK := forecastReset(w)
	if w.Stale != nil && *w.Stale {
		forecastNote(out, "최근 쿼타 측정값을 기다리고 있습니다.")
		out["status"] = "stale"
		return out
	}
	if !resetOK {
		forecastNote(out, "리셋 시각이 없어 같은 한도 구간인지 확인할 수 없습니다.")
		out["status"] = "unsupported"
		return out
	}
	if reset <= now {
		forecastNote(out, "리셋 이후의 새 측정값을 기다리고 있습니다.")
		out["status"] = "stale"
		return out
	}
	fresh := forecastFresh(w, pts, now, reset, resetOK)
	remain := 0.0
	if w.RemainingPercent != nil {
		remain = *w.RemainingPercent
	}
	used := 100 - remain
	if fresh && remain == 0 {
		out["exhaustsAt"] = time.UnixMilli(measuredAt).UTC().Format(time.RFC3339Nano)
		out["resetBeforeExhaustion"] = false
		out["projectedUsedAtReset"] = used
		out["status"] = "ok"
		forecastNote(out, "마지막 관측에서 한도를 모두 사용했습니다.")
		return out
	}
	if !fresh || rate == nil {
		if !fresh {
			forecastNote(out, "현재 리셋의 최신 측정이 아니라 소진 시각은 계산하지 않습니다.")
		}
		return out
	}
	if *rate == 0 || hours*float64(calc.HourMs) < float64(forecastMinRateMs) || delta < forecastMinDeltaPp {
		if *rate == 0 {
			out["status"] = "ok"
			forecastNote(out, "관측된 소모가 0이라 소진 시각은 없습니다.")
			out["resetBeforeExhaustion"] = true
			out["projectedUsedAtReset"] = used
		} else {
			forecastNote(out, "소진 예상은 15분 이상, 2%p 이상 변화가 필요합니다.")
			out["forecastRatePpHour"] = nil
			out["status"] = "collecting"
		}
		return out
	}
	exhaust := measuredAt + int64(remain / *rate * float64(calc.HourMs))
	out["exhaustsAt"] = time.UnixMilli(exhaust).UTC().Format(time.RFC3339Nano)
	before := reset < exhaust
	out["resetBeforeExhaustion"] = before
	projected := used + math.Max(0, float64(reset-measuredAt))/float64(calc.HourMs)**rate
	out["projectedUsedAtReset"] = projected
	out["status"] = "ok"
	return out
}

func forecastNote(out map[string]any, note string) {
	out["reason"] = note
	out["forecastReason"] = note
}

func forecastSeries(points []calc.Point, now int64) []calc.Point {
	out := make([]calc.Point, 0, len(points))
	watermark := int64(math.MinInt64)
	barrier := false
	for _, p := range points {
		ordered := p.At > watermark
		if p.At > watermark {
			watermark = p.At
		}
		if !ordered || p.At > now+forecastSkewMs || p.At >= p.Reset || p.Used < 0 || math.IsNaN(p.Used) || math.IsInf(p.Used, 0) {
			barrier = true
			continue
		}
		p.Barrier = p.Barrier || barrier
		out = append(out, p)
		barrier = false
	}
	return calc.Normalize(out)
}

func forecastHistory(pts []calc.Point, w contract.Window, now int64) []calc.Point {
	hours := forecastWindowHours(w)
	if hours <= 0 {
		return []calc.Point{}
	}
	horizon := int64(hours * float64(calc.HourMs))
	from := now - horizon
	out := make([]calc.Point, 0, len(pts))
	for _, p := range pts {
		if p.At >= from {
			out = append(out, p)
		}
	}
	return out
}

func forecastWindowHours(w contract.Window) float64 {
	switch w.ID {
	case "five-hour":
		return 5
	case "weekly":
		return 168
	case "monthly":
		return 720
	case "short":
		return labelledHours(w.Label)
	default:
		return 0
	}
}

func labelledHours(label string) float64 {
	label = strings.TrimSpace(label)
	if !strings.HasSuffix(label, "시간") {
		return 0
	}
	n, err := strconv.ParseFloat(strings.TrimSuffix(label, "시간"), 64)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func observedForecast(pts []calc.Point, measuredAt int64) (hours, delta, span float64) {
	from := measuredAt - forecastWeekMs
	for i := 1; i < len(pts); i++ {
		before, after := pts[i-1], pts[i]
		gap := after.At - before.At
		consumed := after.Used - before.Used
		if before.SegmentID != after.SegmentID || gap > calc.MaxGapMs || consumed < 0 {
			continue
		}
		elapsed := forecastMin(after.At, measuredAt) - forecastMax(before.At, from)
		if gap <= 0 || elapsed <= 0 {
			continue
		}
		hours += float64(elapsed) / float64(calc.HourMs)
		delta += consumed * float64(elapsed) / float64(gap)
	}
	if len(pts) > 0 {
		span = math.Max(0, float64(measuredAt-forecastMax(pts[0].At, from))/float64(calc.HourMs))
	}
	return hours, delta, span
}

func recoveredForecast(pts []calc.Point, measuredAt int64) (hours, delta float64) {
	from := measuredAt - forecastWeekMs
	for i := 1; i < len(pts); i++ {
		before, after := pts[i-1], pts[i]
		gap := after.At - before.At
		consumed := after.Used - before.Used
		if before.SegmentID != after.SegmentID || gap <= calc.MaxGapMs || consumed < 0 || before.At <= from {
			continue
		}
		if after.ObservedPercent < before.ObservedPercent {
			continue
		}
		hours += float64(gap) / float64(calc.HourMs)
		delta += consumed
	}
	return hours, delta
}

func forecastReset(w contract.Window) (int64, bool) {
	if w.ResetAt == nil || *w.ResetAt == "" {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339Nano, *w.ResetAt)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}

func forecastFresh(w contract.Window, pts []calc.Point, now, reset int64, resetOK bool) bool {
	if w.Stale != nil && *w.Stale {
		return false
	}
	if !resetOK || reset <= now || w.RemainingPercent == nil {
		return false
	}
	last := pts[len(pts)-1]
	if last.WindowSemantics != "fixed_reset" {
		return false
	}
	if last.At > now+forecastSkewMs || now-last.At > forecastStaleMs || math.Abs(float64(last.Reset-reset)) > float64(calc.ResetToleranceMs) {
		return false
	}
	used := 100 - *w.RemainingPercent
	return math.Abs(last.Used-used) <= 1e-6
}

func sampleForecastHistory(pts []calc.Point) []map[string]any {
	if len(pts) == 0 {
		return []map[string]any{}
	}
	step := 1
	if len(pts) > 180 {
		step = int(math.Ceil(float64(len(pts)) / 180))
	}
	out := []map[string]any{}
	for i, p := range pts {
		if i%step != 0 && i != len(pts)-1 {
			continue
		}
		out = append(out, map[string]any{
			"at": time.UnixMilli(p.At).UTC().Format(time.RFC3339Nano), "usedPercent": p.Used,
			"resetAt": time.UnixMilli(p.Reset).UTC().Format(time.RFC3339Nano),
		})
	}
	return out
}

func forecastMax(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func forecastMin(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
