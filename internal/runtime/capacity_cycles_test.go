package runtime

import (
	"math"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

// cycleFixture builds one 10-minute run per hourly reset cycle. Cycle k moves
// quota by moves[k]pp and spends usd[k]; its own ratio is usd/moves*100.
func cycleFixture(usd, moves []float64) (contract.Window, []calc.Point, []store.Usage, []calc.AppliedPrice, int64) {
	now := int64(1800000000000)
	n := len(usd)
	var pts []calc.Point
	var rows []store.Usage
	var prices []calc.AppliedPrice
	for k := 0; k < n; k++ {
		start := now - int64(n-k)*3600000
		reset := start + 3600000
		pts = append(pts, calc.Point{At: start, Reset: reset, Used: 0}, calc.Point{At: start + 600000, Reset: reset, Used: moves[k]})
		rows = append(rows, store.Usage{Provider: "anthropic", Account: repairPtr("a"), At: start + 300000})
		prices = append(prices, calc.AppliedPrice{USD: repairPtr(usd[k])})
	}
	last := pts[len(pts)-1]
	win := contract.Window{ID: "five-hour", RemainingPercent: repairPtr(100 - last.Used), ResetAt: repairPtr(time.UnixMilli(last.Reset).UTC().Format(time.RFC3339Nano))}
	return win, pts, rows, prices, last.At + 60000
}

func tens(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = 10
	}
	return out
}

func near(got any, want float64) bool {
	v, ok := got.(float64)
	return ok && math.Abs(v-want) < 1e-9
}

func TestCapacityUsesRecentCyclesWhenSteady(t *testing.T) {
	win, pts, rows, prices, now := cycleFixture([]float64{5, 5, 5, 5, 5}, tens(5))
	got := windowCapacity("anthropic", "a", win, pts, rows, prices, now)
	cycles, _ := got["capacityCycles"].([]map[string]any)
	if !near(got["capacityApiUsd"], 50) || got["capacityShift"] != nil || len(cycles) != 5 || got["capacityCycleCount"] != 3 {
		t.Fatalf("steady %v", got)
	}
	if cycles[0]["selected"] != false || cycles[4]["selected"] != true {
		t.Fatalf("selection %v", cycles)
	}
}

func TestCapacityDetectsSupplyChangeAfterTwoCycles(t *testing.T) {
	win, pts, rows, prices, now := cycleFixture([]float64{5, 5, 5, 10, 10}, tens(5))
	got := windowCapacity("anthropic", "a", win, pts, rows, prices, now)
	shift, _ := got["capacityShift"].(map[string]any)
	if !near(got["capacityApiUsd"], 100) || shift == nil || !near(shift["beforeApiUsd"], 50) || !near(shift["afterApiUsd"], 100) || got["capacityCycleCount"] != 2 {
		t.Fatalf("shift %v", got)
	}
	if shift["at"] != time.UnixMilli(pts[6].At).UTC().Format(time.RFC3339Nano) {
		t.Fatalf("shift instant %v", shift)
	}
}

func TestCapacityIgnoresSingleCycleSpike(t *testing.T) {
	win, pts, rows, prices, now := cycleFixture([]float64{5, 5, 5, 10, 5}, tens(5))
	got := windowCapacity("anthropic", "a", win, pts, rows, prices, now)
	rng, _ := got["capacityRangeApiUsd"].(map[string]any)
	if got["capacityShift"] != nil || !near(rng["low"], 50) || !near(rng["high"], 100) {
		t.Fatalf("spike %v", got)
	}
}

func TestCapacityExcludesThinCycles(t *testing.T) {
	// The last cycle moved only 2pp: its 250 USD/100% ratio is rounding noise.
	win, pts, rows, prices, now := cycleFixture([]float64{5, 5, 5}, []float64{10, 10, 2})
	got := windowCapacity("anthropic", "a", win, pts, rows, prices, now)
	cycles, _ := got["capacityCycles"].([]map[string]any)
	if !near(got["capacityApiUsd"], 50) || len(cycles) != 3 || cycles[2]["usable"] != false || cycles[2]["selected"] != false {
		t.Fatalf("thin %v", got)
	}
}
