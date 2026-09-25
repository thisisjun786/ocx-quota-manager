package runtime

import (
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
)

func forecastWindow(now int64, remain float64, stale bool) contract.Window {
	reset := time.UnixMilli(now + 10*calc.HourMs).UTC().Format(time.RFC3339Nano)
	return contract.Window{ID: "weekly", RemainingPercent: &remain, Stale: &stale, ResetAt: &reset}
}

func forecastPoint(at, reset int64, used float64) calc.Point {
	return calc.Point{At: at, Reset: reset, Used: used, ObservedPercent: used, WindowSemantics: "fixed_reset", Source: "s", SourceVersion: "1", Method: "reported_percent", ScopeKey: "all", Unit: "percent", LimitState: "missing"}
}

func TestForecastResetArrivesBeforeExhaustion(t *testing.T) {
	reset := int64(1_800_000_000_000)
	now := reset - 10*calc.HourMs
	pts := []calc.Point{
		forecastPoint(now-15*60_000, reset, 10),
		forecastPoint(now, reset, 12),
	}
	got := windowForecast(forecastWindow(now, 88, false), pts, now)
	if got["exhaustsAt"] == nil || got["resetBeforeExhaustion"] != true {
		t.Fatalf("slow burn must exhaust after reset: %+v", got)
	}
	if got["forecastRatePpHour"] == nil {
		t.Fatal("historic rate missing")
	}
	if got["status"] != "ok" || got["reason"] == "" || got["exhaustsAt"] == nil {
		t.Fatalf("fresh ETA is hidden unless status is ok: %+v", got)
	}
}

func TestForecastHistoryUsesWindowHours(t *testing.T) {
	reset := int64(1_800_000_000_000)
	now := reset - 2*calc.HourMs
	w := forecastWindow(now, 90, false)
	w.ID = "short"
	w.Label = "3시간"
	pts := []calc.Point{
		forecastPoint(now-4*calc.HourMs, reset, 0),
		forecastPoint(now-2*calc.HourMs, reset, 1),
		forecastPoint(now, reset, 2),
	}
	got := windowForecast(w, pts, now)
	hist, _ := got["history"].([]map[string]any)
	if len(hist) != 2 {
		t.Fatalf("3h label must drop the 4h-old point: %+v", hist)
	}
	custom := forecastWindow(now, 90, false)
	custom.ID = "custom"
	custom.Label = "90일"
	got = windowForecast(custom, pts, now)
	hist, _ = got["history"].([]map[string]any)
	if len(hist) != 0 {
		t.Fatalf("unknown window must not inherit a 30-day chart: %+v", hist)
	}
}

func TestForecastFastBurnExhaustsBeforeReset(t *testing.T) {
	reset := int64(1_800_000_000_000)
	now := reset - 10*calc.HourMs
	pts := []calc.Point{
		forecastPoint(now-15*60_000, reset, 0),
		forecastPoint(now, reset, 5),
	}
	got := windowForecast(forecastWindow(now, 95, false), pts, now)
	if got["resetBeforeExhaustion"] != false || got["exhaustsAt"] == nil {
		t.Fatalf("20pp/h and 5pp left exhausts before a 10h reset: %+v", got)
	}
}

func TestForecastRecoveredGapNeedsEpoch(t *testing.T) {
	reset := int64(1_800_000_000_000)
	now := reset - 10*calc.HourMs
	epoch := int64(1)
	gap := func(at int64, used float64) calc.Point {
		p := forecastPoint(at, reset, used)
		p.Epoch = &epoch
		return p
	}
	pts := []calc.Point{gap(now-2*calc.HourMs, 0), gap(now, 10)}
	got := windowForecast(forecastWindow(now, 90, false), pts, now)
	hours, _ := got["forecastRecoveredHours"].(float64)
	if hours < 1.9 {
		t.Fatalf("same epoch fixed-reset gap must be recovered: %+v", got)
	}
	bare := []calc.Point{forecastPoint(now-2*calc.HourMs, reset, 0), forecastPoint(now, reset, 10)}
	without := windowForecast(forecastWindow(now, 90, false), bare, now)
	if without["forecastRatePpHour"] != nil {
		t.Fatalf("a gap without an epoch must not become a rate: %+v", without)
	}
}

func TestForecastInvalidPointIsABarrier(t *testing.T) {
	reset := int64(1_800_000_000_000)
	now := reset - 10*calc.HourMs
	pts := []calc.Point{
		forecastPoint(now-20*60_000, reset, 0),
		forecastPoint(now-10*60_000, reset, -1),
		forecastPoint(now, reset, 10),
	}
	got := windowForecast(forecastWindow(now, 90, false), pts, now)
	if got["forecastRatePpHour"] != nil {
		t.Fatalf("an invalid middle reading must stop the join: %+v", got)
	}
}

func TestForecastStaleKeepsRateWithoutETA(t *testing.T) {
	reset := int64(1_800_000_000_000)
	now := reset - 10*calc.HourMs
	pts := []calc.Point{
		forecastPoint(now-30*60_000, reset, 0),
		forecastPoint(now-15*60_000, reset, 10),
	}
	got := windowForecast(forecastWindow(now, 90, true), pts, now)
	if got["exhaustsAt"] != nil || got["resetBeforeExhaustion"] != nil {
		t.Fatalf("stale snapshot must not publish an ETA: %+v", got)
	}
	if got["forecastRatePpHour"] == nil {
		t.Fatalf("stale window may still expose the historic rate: %+v", got)
	}
}

func TestForecastMeasuredZeroHasNoETA(t *testing.T) {
	reset := int64(1_800_000_000_000)
	now := reset - 10*calc.HourMs
	pts := []calc.Point{
		forecastPoint(now-15*60_000, reset, 40),
		forecastPoint(now, reset, 40),
	}
	got := windowForecast(forecastWindow(now, 60, false), pts, now)
	rate, _ := got["forecastRatePpHour"].(*float64)
	if rate == nil || *rate != 0 || got["exhaustsAt"] != nil {
		t.Fatalf("measured zero is a rate without an exhaustion time: %+v", got)
	}
	if got["resetBeforeExhaustion"] != true {
		t.Fatalf("zero burn resets first: %+v", got)
	}
}

func TestForecastSingleExhaustedPoint(t *testing.T) {
	reset := int64(1_800_000_000_000)
	now := reset - 10*calc.HourMs
	pts := []calc.Point{forecastPoint(now, reset, 100)}
	got := windowForecast(forecastWindow(now, 0, false), pts, now)
	if got["status"] != "ok" || got["forecastRatePpHour"] != nil || got["exhaustsAt"] == nil || got["resetBeforeExhaustion"] != false {
		t.Fatalf("one fresh exhausted point needs no rate: %+v", got)
	}
}

func TestForecastExpectsEpochAlreadyFiltered(t *testing.T) {
	reset := int64(1_800_000_000_000)
	now := reset - 10*calc.HourMs
	// The helper does not infer scope or drop another epoch. A caller that already
	// removed the other identity passes only this epoch, so its 10pp stands alone.
	pts := []calc.Point{forecastPoint(now-15*60_000, reset, 0), forecastPoint(now, reset, 10)}
	got := windowForecast(forecastWindow(now, 90, false), pts, now)
	delta, _ := got["forecastDeltaPp"].(*float64)
	if delta == nil || *delta < 9.9 || *delta > 10.1 {
		t.Fatalf("filtered series keeps its own delta: %+v", got["forecastDeltaPp"])
	}
}
