package collect

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Matches the installed OCX Kimi Code /usages contract. Total credits stay
// scoped; only explicitly weekly limits enter the account recommendation.
var kimiFiveHour = regexp.MustCompile(`(^|\b)5\s*(h|hour)`)
var kimiWeekly = regexp.MustCompile(`weekly|7\s*(d|day)`)

func kimiNumber(v any) *float64 {
	n := num(v)
	if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
		if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			n = &f
		}
	}
	if n == nil || math.IsNaN(*n) || math.IsInf(*n, 0) {
		return nil
	}
	return n
}
func kimiReset(m map[string]any) *int64 {
	for _, k := range []string{"resetTime", "resetAt", "reset_time", "reset_at"} {
		if r := instant(m[k]); r != nil {
			return r
		}
	}
	return nil
}
func kimiRow(v any, fallback map[string]any, id, label string, now int64) *Reading {
	m := obj(v)
	if m == nil {
		return nil
	}
	var pct *float64
	limit, used := kimiNumber(m["limit"]), kimiNumber(m["used"])
	if limit != nil && *limit > 0 {
		if used == nil {
			if rem := kimiNumber(m["remaining"]); rem != nil && *rem >= 0 && *rem <= *limit {
				u := *limit - *rem
				used = &u
			}
		}
		if used != nil && *used >= 0 {
			v := *used / *limit * 100
			pct = &v
		}
	}
	if pct == nil {
		for _, k := range []string{"utilization", "percent", "usedPercent", "used_percent"} {
			if m[k] != nil {
				pct = kimiNumber(m[k])
				break
			}
		}
	}
	if pct == nil || *pct < 0 || math.IsInf(*pct, 0) || math.IsNaN(*pct) {
		return nil
	}
	bounded := math.Min(100, *pct)
	pct = &bounded
	reset := kimiReset(m)
	if reset == nil {
		reset = kimiReset(fallback)
	}
	return &Reading{Provider: "kimi", Endpoint: "usages", WindowID: id, Label: label, UsedPercent: pct, RemainingPercent: remain(pct), ResetAt: reset, Kind: WindowOK, ObservedAt: now}
}
func parseKimi(body []byte, now int64) ([]Reading, error) {
	m, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "kimi", "usages", now)
	}
	if m["usage"] == nil && m["limits"] == nil && m["totalQuota"] == nil && obj(m["data"]) != nil {
		m = obj(m["data"])
	}
	weekly := kimiRow(m["usage"], nil, weeklyID, weeklyLabel, now)
	var five *Reading
	for _, raw := range arr(m["limits"]) {
		item := obj(raw)
		detail := obj(item["detail"])
		if detail == nil {
			detail = item
		}
		window := obj(item["window"])
		duration, unit := (*float64)(nil), ""
		for _, part := range []map[string]any{window, item, detail} {
			if duration == nil {
				duration = kimiNumber(part["duration"])
			}
			if unit == "" {
				unit, _ = part["timeUnit"].(string)
			}
		}
		unit = strings.ToUpper(unit)
		var labels []string
		for _, v := range []any{item["name"], item["title"], item["scope"], detail["name"], detail["title"]} {
			if s, ok := v.(string); ok {
				labels = append(labels, s)
			}
		}
		label := strings.ToLower(strings.Join(labels, " "))
		isFive := duration != nil && ((strings.Contains(unit, "MINUTE") && *duration == 300) || (strings.Contains(unit, "HOUR") && *duration == 5))
		isWeekly := duration != nil && ((strings.Contains(unit, "DAY") && *duration == 7) || (strings.Contains(unit, "HOUR") && *duration == 168))
		if five == nil && (isFive || kimiFiveHour.MatchString(label)) {
			five = kimiRow(detail, window, fiveHourID, fiveHourLabel, now)
		}
		if weekly == nil && (isWeekly || kimiWeekly.MatchString(label)) {
			weekly = kimiRow(detail, window, weeklyID, weeklyLabel, now)
		}
	}
	var rows []Reading
	for _, r := range []*Reading{five, weekly, kimiRow(m["totalQuota"], nil, scopedWindowID("Total subscription credits"), "Total subscription credits", now)} {
		if r != nil {
			rows = append(rows, *r)
		}
	}
	return parserResult(rows, nil, "kimi", "usages", now)
}
