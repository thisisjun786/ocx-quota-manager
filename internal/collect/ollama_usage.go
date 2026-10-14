package collect

import "math"

// Ollama Cloud publishes its included-quota windows on /api/balance, which
// reads with the same Bearer API key as the retired /api/usage surface.
// remaining_percent is the provider-reported remaining share in [0,100]; the
// used side and the stored fraction are derived only from it. The purchased
// USD balance on the same response is a separate credit quantity and never
// becomes a percentage window. Per-model request counters do not exist on
// this surface, so none are fabricated.
func ollamaAdapter() Adapter {
	return adapter{"ollama-cloud", "balance", "ollama.com", "/api/balance", "GET", parseOllama}
}

func parseOllama(body []byte, now int64) ([]Reading, error) {
	objBody, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "ollama-cloud", "balance", now)
	}
	included := obj(objBody["included"])
	rows := []Reading{}
	if included == nil {
		return parserResult(rows, nil, "ollama-cloud", "balance", now)
	}
	for _, w := range []struct{ key, id, label string }{
		{"session", "five-hour", "5시간"},
		{"weekly", "weekly", "주간"},
	} {
		window := obj(included[w.key])
		if window == nil {
			continue
		}
		// A share outside [0,100] is malformed, not a window at a boundary;
		// percent 0 (fully used) is published like any other in-range value.
		remaining := num(window["remaining_percent"])
		if remaining == nil || *remaining < 0 || *remaining > 100 || math.IsNaN(*remaining) || math.IsInf(*remaining, 0) {
			continue
		}
		used := 100 - *remaining
		fraction := used / 100
		rows = append(rows, Reading{Provider: "ollama-cloud", Endpoint: "balance",
			WindowID: w.id, Label: w.label, UsedPercent: &used, RemainingPercent: remaining,
			ResetAt: instant(window["resets_at"]), Kind: WindowOK, ObservedAt: now, Fraction: &fraction})
	}
	return parserResult(rows, nil, "ollama-cloud", "balance", now)
}
