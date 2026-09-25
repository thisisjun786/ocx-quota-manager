package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"time"
)

// Matches the existing seven-day priced-usage projection. It is independent of
// the selected quota-consumption tab and never substitutes for quota capacity.
func usagePace(provider string, account *string, rows []store.Usage, prices []calc.AppliedPrice, now int64) map[string]any {
	var first int64
	var usd float64
	requests, priced := 0, 0
	for i, u := range rows {
		if u.Provider != provider || u.At <= now-168*calc.HourMs || u.At > now {
			continue
		}
		if account != nil && (u.Account == nil || *u.Account != *account) {
			continue
		}
		requests++
		if prices[i].USD == nil {
			continue
		}
		priced++
		usd += *prices[i].USD
		if first == 0 || u.At < first {
			first = u.At
		}
	}
	hours := float64(0)
	if first > 0 {
		hours = float64(now-first) / calc.HourMs
	}
	out := map[string]any{"usdPerHour": nil, "projectedFiveHourUsd": nil, "projectedWeekUsd": nil, "observedHours": hours, "observedAt": time.UnixMilli(now).UTC().Format(time.RFC3339Nano), "stale": false, "basisPeriod": "weekly", "pricedCoverage": float64(0)}
	if requests > 0 {
		out["pricedCoverage"] = float64(priced) / float64(requests)
	}
	if hours >= 1 && priced > 0 {
		rate := usd / hours
		out["usdPerHour"] = rate
		out["projectedFiveHourUsd"] = rate * 5
		out["projectedWeekUsd"] = rate * 168
	}
	return out
}
