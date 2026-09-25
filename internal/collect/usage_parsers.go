package collect

// Ports of src/opencode-go-quota.mjs and src/command-code-quota.mjs: the two
// billing surfaces that publish several named windows in one response.

// OpenCode Go reports three window percentages on its own usage surface. The
// response carries percentages and nothing else; no used or limit is derived.
func parseOpenCode(body []byte, now int64) ([]Reading, error) {
	objBody, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "opencode-go", "usage", now)
	}
	usage := obj(objBody["usage"])
	rows := []Reading{}
	if usage == nil {
		return parserResult(rows, nil, "opencode-go", "usage", now)
	}
	for _, w := range []struct{ key, id, label string }{
		{"rolling", fiveHourID, fiveHourLabel},
		{"weekly", weeklyID, weeklyLabel},
		{"monthly", monthlyID, monthlyLabel},
	} {
		window := obj(usage[w.key])
		if window == nil {
			continue
		}
		// A window the provider does not call ok is one it is not reporting,
		// not a window at zero.
		if status, ok := str(window["status"]); ok && status != "ok" {
			continue
		}
		percent := num(window["percent"])
		if percent == nil || *percent < 0 {
			continue
		}
		rows = append(rows, Reading{Provider: "opencode-go", Endpoint: "usage",
			WindowID: w.id, Label: w.label, UsedPercent: percent,
			RemainingPercent: remain(percent), ResetAt: instant(window["resetsAt"]),
			Kind: WindowOK, ObservedAt: now})
	}
	return parserResult(rows, nil, "opencode-go", "usage", now)
}

// Command Code publishes its own rolling windows on the billing surface the
// CLI usage view reads. Only windowLimits is read; the credit pools beside it
// are a different quantity with a different denominator.
func parseCommandCode(body []byte, now int64) ([]Reading, error) {
	objBody, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "command-code", "credits", now)
	}
	rows := []Reading{}
	bodyMap := objBody
	if data := obj(objBody["data"]); data != nil {
		bodyMap = data
	}
	limits := obj(bodyMap["windowLimits"])
	if limits == nil {
		return parserResult(rows, nil, "command-code", "credits", now)
	}
	for _, w := range []struct{ key, id, label string }{
		{"fiveHour", fiveHourID, fiveHourLabel},
		{"weekly", weeklyID, weeklyLabel},
	} {
		window := obj(limits[w.key])
		if window == nil {
			continue
		}
		used := num(window["used"])
		cap := num(window["cap"])
		// A reading needs both halves of its own pair. One without the other
		// is not a ratio.
		if used == nil || cap == nil || *used < 0 {
			continue
		}
		var pct *float64
		if *cap > 0 {
			v := *used * 100 / *cap
			pct = &v
		}
		rows = append(rows, Reading{Provider: "command-code", Endpoint: "credits",
			WindowID: w.id, Label: w.label, UsedPercent: pct,
			RemainingPercent: remain(pct), ResetAt: instant(window["resetAt"]),
			Kind: WindowOK, ObservedAt: now})
	}
	return parserResult(rows, nil, "command-code", "credits", now)
}
