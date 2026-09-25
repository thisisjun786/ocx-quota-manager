package collect

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Ports of src/provider-quota-adapters.mjs and src/devin-quota.mjs. Window
// identifiers are the ones the product already publishes; a limit that arrives
// under one id from the cached path and another here would count as two limits.
// A numeric zero is a measured zero; an absent field is unknown, never zero.

// Codex reads its account limits from the WHAM usage endpoint. Which window a
// reading belongs to is decided by the duration the response declares and by
// nothing else.
const (
	codexBurstMaxSeconds    = 24 * 60 * 60
	codexMonthlyMinSeconds  = 28 * 24 * 60 * 60
	weeklyID, weeklyLabel   = "weekly", "주간"
	monthlyID, monthlyLabel = "monthly", "월간"
	fiveHourID              = "five-hour"
	fiveHourLabel           = "5시간"
)

type codexWindowName struct {
	id, label string
	declared  bool
}

func codexWindow(seconds *float64) codexWindowName {
	if seconds == nil || *seconds <= 0 {
		return codexWindowName{weeklyID, weeklyLabel, false}
	}
	switch {
	case *seconds < codexBurstMaxSeconds:
		return codexWindowName{"short", hoursLabel(*seconds), true}
	case *seconds >= codexMonthlyMinSeconds:
		return codexWindowName{monthlyID, monthlyLabel, true}
	default:
		return codexWindowName{weeklyID, weeklyLabel, true}
	}
}

func parseCodex(body []byte, now int64) ([]Reading, error) {
	objBody, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "openai", "wham-usage", now)
	}
	limits := obj(objBody["rate_limit"])
	rows := []Reading{}
	if limits == nil {
		return parserResult(rows, nil, "openai", "wham-usage", now)
	}
	claimed := map[string]bool{}
	add := func(window map[string]any, forced *codexWindowName) {
		if window == nil {
			return
		}
		percent := num(window["used_percent"])
		if percent == nil {
			return
		}
		mapped := forced
		if mapped == nil {
			m := codexWindow(num(window["limit_window_seconds"]))
			mapped = &m
		}
		if claimed[mapped.id] {
			return
		}
		claimed[mapped.id] = true
		rows = append(rows, Reading{Provider: "openai", Endpoint: "wham-usage",
			WindowID: mapped.id, Label: mapped.label, UsedPercent: percent,
			RemainingPercent: remain(percent), ResetAt: instant(window["reset_at"]),
			Kind: WindowOK, ObservedAt: now})
	}
	add(obj(limits["primary_window"]), nil)
	weekly := codexWindowName{weeklyID, weeklyLabel, true}
	monthly := codexWindowName{monthlyID, monthlyLabel, true}
	add(obj(limits["secondary_window"]), &weekly)
	add(obj(limits["tertiary_window"]), &monthly)
	return parserResult(rows, nil, "openai", "wham-usage", now)
}

// Claude reports an overall five-hour window, an overall weekly window, and
// weekly windows scoped to particular models. The scoped ones keep their own
// custom- id and are never filled in from the overall figure.
var claudeScopedBuckets = []struct{ field, label string }{
	{"seven_day_fable", "Fable"},
	{"seven_day_opus", "Opus"},
	{"seven_day_sonnet", "Sonnet"},
}

func parseClaude(body []byte, now int64) ([]Reading, error) {
	objBody, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "anthropic", "oauth-usage", now)
	}
	rows := []Reading{}
	claimed := map[string]bool{}
	add := func(windowID, label string, percent any, resetValue any) {
		pct := num(percent)
		if pct == nil || claimed[windowID] {
			return
		}
		claimed[windowID] = true
		rows = append(rows, Reading{Provider: "anthropic", Endpoint: "oauth-usage",
			WindowID: windowID, Label: label, UsedPercent: pct,
			RemainingPercent: remain(pct), ResetAt: instant(resetValue),
			Kind: WindowOK, ObservedAt: now})
	}
	for _, w := range []struct{ field, id, label string }{
		{"five_hour", fiveHourID, fiveHourLabel},
		{"seven_day", weeklyID, weeklyLabel},
	} {
		if bucket := obj(objBody[w.field]); bucket != nil {
			add(w.id, w.label, bucket["utilization"], bucket["resets_at"])
		}
	}
	for _, scoped := range claudeScopedBuckets {
		bucket := obj(objBody[scoped.field])
		if bucket == nil {
			continue
		}
		id := scopedWindowID(scoped.label)
		add(id, scoped.label, bucket["utilization"], bucket["resets_at"])
	}
	for _, raw := range arr(objBody["limits"]) {
		limit := obj(raw)
		kind, ok := str(limit["kind"])
		if !ok || !strings.EqualFold(strings.TrimSpace(kind), "weekly_scoped") {
			continue
		}
		label, ok := str(obj(obj(limit["scope"])["model"])["display_name"])
		if !ok {
			continue
		}
		label = strings.TrimSpace(label)
		id := scopedWindowID(label)
		if id == "" {
			continue
		}
		add(id, label, limit["percent"], limit["resets_at"])
	}
	return parserResult(rows, nil, "anthropic", "oauth-usage", now)
}

// Cursor's own meter reports a percentage and the spend it was computed from.
// The reported one is published; the two secondary pools measure part of the
// plan and keep their own scoped ids.
func parseCursor(body []byte, now int64) ([]Reading, error) {
	objBody, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "cursor", "period-usage", now)
	}
	plan := obj(objBody["planUsage"])
	rows := []Reading{}
	if plan == nil {
		return parserResult(rows, nil, "cursor", "period-usage", now)
	}
	resetAt := instant(objBody["billingCycleEnd"])
	if resetAt == nil {
		resetAt = instant(plan["billingCycleEnd"])
	}
	if resetAt == nil {
		resetAt = instant(objBody["periodEnd"])
	}
	row := Reading{Provider: "cursor", Endpoint: "period-usage",
		WindowID: monthlyID, Label: monthlyLabel, ResetAt: resetAt,
		Kind: WindowOK, ObservedAt: now}
	reported := num(plan["totalPercentUsed"])
	if reported == nil {
		reported = num(plan["percentUsed"])
	}
	used := num(plan["includedSpend"])
	if used == nil {
		used = num(plan["usedCents"])
	}
	if used == nil {
		used = num(plan["used"])
	}
	if reported != nil || used != nil {
		row.UsedPercent = reported
		row.RemainingPercent = remain(reported)
		rows = append(rows, row)
	}
	for _, pool := range []struct{ field, label string }{
		{"autoPercentUsed", "First-party models"},
		{"apiPercentUsed", "API usage"},
	} {
		percent := num(plan[pool.field])
		id := scopedWindowID(pool.label)
		if percent == nil || id == "" {
			continue
		}
		rows = append(rows, Reading{Provider: "cursor", Endpoint: "period-usage",
			WindowID: id, Label: pool.label, UsedPercent: percent,
			RemainingPercent: remain(percent), ResetAt: resetAt,
			Kind: WindowOK, ObservedAt: now})
	}
	return parserResult(rows, nil, "cursor", "period-usage", now)
}

// Grok reports two different things from two different endpoints. The weekly
// credit window is what actually gates prompting; the legacy monthly pool is a
// dollar allowance. Substituting one for the other would publish a number
// nobody measured for that period.
func parseGrok(body []byte, now int64) ([]Reading, error) {
	objBody, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "xai", "grok-credits", now)
	}
	rows := []Reading{}
	config := obj(objBody["config"])
	period := obj(config["currentPeriod"])
	if config == nil || period == nil {
		return parserResult(rows, nil, "xai", "grok-credits", now)
	}
	periodType, _ := str(period["type"])
	if periodType != "USAGE_PERIOD_TYPE_WEEKLY" {
		return parserResult(rows, nil, "xai", "grok-credits", now)
	}
	percent := num(config["creditUsagePercent"])
	if percent == nil {
		return parserResult(rows, nil, "xai", "grok-credits", now)
	}
	rows = append(rows, Reading{Provider: "xai", Endpoint: "grok-credits",
		WindowID: weeklyID, Label: weeklyLabel, UsedPercent: percent,
		RemainingPercent: remain(percent), ResetAt: instant(period["end"]),
		Kind: WindowOK, ObservedAt: now})
	return parserResult(rows, nil, "xai", "grok-credits", now)
}

func parseGrokBilling(body []byte, now int64) ([]Reading, error) {
	objBody, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "xai", "grok-billing", now)
	}
	rows := []Reading{}
	config := obj(objBody["config"])
	if config == nil {
		return parserResult(rows, nil, "xai", "grok-billing", now)
	}
	used := num(obj(config["used"])["val"])
	limit := num(obj(config["monthlyLimit"])["val"])
	if used == nil && limit == nil {
		return parserResult(rows, nil, "xai", "grok-billing", now)
	}
	row := Reading{Provider: "xai", Endpoint: "grok-billing",
		WindowID: monthlyID, Label: monthlyLabel,
		ResetAt: instant(config["billingPeriodEnd"]), Kind: WindowOK, ObservedAt: now}
	// A limit of zero is not a limit of nothing used: it publishes no percentage
	// rather than dividing into it.
	if used != nil && limit != nil && *limit > 0 {
		pct := *used * 100 / *limit
		row.UsedPercent = &pct
		row.RemainingPercent = remain(&pct)
	}
	rows = append(rows, row)
	return parserResult(rows, nil, "xai", "grok-billing", now)
}

// Devin CLI's read-only GetUserStatus reports remaining plan quota. Daily and
// weekly stay independent; an absent field is not zero and daily never fills
// weekly. A vendor-hidden daily quota is marked hidden, not dropped silently.
func devinReset(v any) *int64 {
	var n *float64
	switch v.(type) {
	case float64, json.Number:
		n = num(v)
	default:
		if s, ok := str(v); ok {
			trimmed := strings.TrimSpace(s)
			if isNumericString(trimmed) {
				if f, err := strconv.ParseFloat(trimmed, 64); err == nil {
					n = &f
				}
			}
		}
	}
	if n == nil {
		return nil
	}
	ms := *n * 1000
	if ms <= 0 || ms > 8.64e15 {
		return nil
	}
	out := int64(ms)
	return &out
}

func parseDevin(body []byte, now int64) ([]Reading, error) {
	objBody, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "devin", "user-status", now)
	}
	rows := []Reading{}
	plan := obj(obj(objBody["userStatus"])["planStatus"])
	if plan == nil {
		return parserResult(rows, nil, "devin", "user-status", now)
	}
	for _, w := range []struct{ period, id, label string }{
		{"daily", "short", "24시간"},
		{"weekly", weeklyID, weeklyLabel},
	} {
		if w.period == "daily" && obj(plan["planInfo"])["hideDailyQuota"] == true {
			rows = append(rows, Reading{Provider: "devin", Endpoint: "user-status",
				WindowID: w.id, Label: w.label, Hidden: true, Kind: WindowOK, ObservedAt: now})
			continue
		}
		remaining := num(plan[w.period+"QuotaRemainingPercent"])
		if remaining == nil || *remaining < 0 || *remaining > 100 {
			continue
		}
		pct := 100 - *remaining
		rows = append(rows, Reading{Provider: "devin", Endpoint: "user-status",
			WindowID: w.id, Label: w.label, UsedPercent: &pct,
			RemainingPercent: remain(&pct), ResetAt: devinReset(plan[w.period+"QuotaResetAtUnix"]),
			Kind: WindowOK, ObservedAt: now})
	}
	return parserResult(rows, nil, "devin", "user-status", now)
}
