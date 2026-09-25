package runtime

import (
	"sort"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
)

// quotaSeries is the quota counterpart of the cost chart: for each selectable
// span, equal bars of provider-wide quota consumption split by account, with
// the API-equivalent amount of the same accounts in the same bar. Consumption
// uses the window the provider total uses (weekly, else monthly) and the
// same interval allocation, so the bars add up to quotaConsumption.
func (in *analysisInput) quotaSeries(providerID string, accounts []*contract.Account, consumption map[string]any) map[string]any {
	windowID := ""
	if c, ok := consumption[calc.PeriodTwentyFourHour].(map[string]any); ok {
		windowID, _ = c["windowId"].(string)
	}
	out := map[string]any{"windowId": windowID}
	if windowID == "" {
		return out
	}
	type accountPoints struct {
		id, label string
		points    []calc.Point
	}
	var held []accountPoints
	for _, a := range accounts {
		for k := range a.Windows {
			w := &a.Windows[k]
			if w.ID == windowID {
				held = append(held, accountPoints{a.ID, a.Label, in.windowPoints(providerID, a.ID, w)})
			}
		}
	}
	for _, spec := range seriesSpecs {
		edges, froms := seriesEdges(in.usageNow, displayLocation, spec)
		n := len(edges) - 1
		buckets := make([]map[string]any, n)
		totals := make([]*float64, n)
		byAccount := make([]map[string]float64, n)
		for k := range buckets {
			byAccount[k] = map[string]float64{}
		}
		for _, h := range held {
			for k, v := range calc.ConsumeBuckets(h.points, edges) {
				if v == nil {
					continue
				}
				byAccount[k][h.id] = *v
				if totals[k] == nil {
					z := 0.0
					totals[k] = &z
				}
				*totals[k] += *v
			}
		}
		usd := make([]float64, n)
		requests := make([]int, n)
		lo := sort.Search(len(in.usage), func(i int) bool { return in.usage[i].At > edges[0] })
		for i := lo; i < len(in.usage) && in.usage[i].At <= edges[n]; i++ {
			u := in.usage[i]
			if u.Provider != providerID {
				continue
			}
			k := sort.Search(n, func(j int) bool { return edges[j+1] >= u.At })
			if k >= n {
				continue
			}
			requests[k]++
			if in.priced[i].USD != nil {
				usd[k] += *in.priced[i].USD
			}
		}
		for k := range buckets {
			buckets[k] = map[string]any{"from": froms[k], "to": froms[k+1], "deltaPp": totals[k],
				"byAccount": byAccount[k], "apiUsd": usd[k], "requests": requests[k]}
		}
		out[spec.period] = map[string]any{"bucketHours": spec.bucket.Hours(), "buckets": buckets}
	}
	labels := map[string]string{}
	for _, h := range held {
		labels[h.id] = h.label
	}
	out["accounts"] = labels
	return out
}

// seriesEdges returns the bar boundaries (ms) and ISO labels for spec. Bars
// align to local midnight (day bars) or the hour (hour-based bars); the first
// bar is clipped to the start of the span and the last to now, so the bars
// cover exactly the span the period totals cover and add up to them.
func seriesEdges(now int64, loc *time.Location, spec seriesSpec) ([]int64, []string) {
	end := time.UnixMilli(now).In(loc)
	start := now - spec.span.Milliseconds()
	var cuts []int64
	if spec.bucket >= 24*time.Hour {
		day := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, loc)
		for t := day; t.UnixMilli() > start; t = t.AddDate(0, 0, -1) {
			cuts = append([]int64{t.UnixMilli()}, cuts...)
		}
	} else {
		top := end.Truncate(time.Hour)
		if top.UnixMilli() == now {
			top = top.Add(-spec.bucket)
		}
		for t := top; t.UnixMilli() > start; t = t.Add(-spec.bucket) {
			cuts = append([]int64{t.UnixMilli()}, cuts...)
		}
	}
	edges := append(append([]int64{start}, cuts...), now)
	// Drop a zero-width last bar when now sits exactly on a boundary.
	if len(edges) > 2 && edges[len(edges)-2] >= now {
		edges = append(edges[:len(edges)-2], now)
	}
	labels := make([]string, len(edges))
	for i, e := range edges {
		labels[i] = time.UnixMilli(e).In(loc).Format(time.RFC3339)
	}
	return edges, labels
}
