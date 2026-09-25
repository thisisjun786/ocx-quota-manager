package collect

func ollamaAdapter() Adapter {
	return adapter{"ollama-cloud", "usage", "ollama.com", "/api/usage", "GET", parseOllama}
}
func parseOllama(body []byte, now int64) ([]Reading, error) {
	obj, err := parseObject(body)
	if err != nil {
		return nil, err
	}
	limits, _ := obj["limits"].(map[string]any)
	out := []Reading{}
	for _, w := range [][3]string{{"session", "five-hour", "5시간"}, {"weekly", "weekly", "주간"}, {"monthly", "monthly", "월간"}} {
		v, _ := limits[w[0]].(map[string]any)
		fraction := num(v["usage"])
		if fraction == nil || *fraction < 0 {
			continue
		}
		used := *fraction * 100
		models := map[string]int64{}
		list, _ := v["models"].([]any)
		for _, item := range list {
			m, _ := item.(map[string]any)
			name, _ := m["name"].(string)
			count := num(m["request_count"])
			if name == "" || len(name) > 200 || count == nil || *count < 0 || *count != float64(int64(*count)) {
				continue
			}
			models[name] = int64(*count)
		}
		f := *fraction
		out = append(out, Reading{Provider: "ollama-cloud", Endpoint: "usage", WindowID: w[1], Label: w[2], UsedPercent: &used, RemainingPercent: remain(&used), Kind: WindowOK, ObservedAt: now, ModelRequests: models, Fraction: &f})
	}
	return out, nil
}
