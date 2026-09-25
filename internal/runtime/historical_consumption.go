package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"math"
)

// The last observed horizon stays available separately when present-period
// samples run out. It must never be relabelled as today's consumption.
func historicalConsumption(points []calc.Point, now int64) (map[string]any, map[string]*calc.PeriodSample) {
	var last int64
	for _, p := range points {
		if p.At <= now && p.At < p.Reset && p.At > last && p.Used >= 0 && !math.IsInf(p.Used, 0) {
			last = p.At
		}
	}
	if last == 0 || now-last <= 15*60*1000 {
		return nil, nil
	}
	periods := calc.ConsumePeriods(points, last)
	dto := map[string]any{}
	samples := map[string]*calc.PeriodSample{}
	for key, value := range periods {
		v := value
		dto[key] = periodDTO(v)
		samples[key] = &v
	}
	return dto, samples
}
