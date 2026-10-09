package runtime

import "github.com/thisisjun786/ocx-quota-manager/internal/store"

const ollamaCacheRate = 0.9

// This is the user's reference-cost scenario, not measured cache usage or a
// historical invoice. Copy the store's shared rows before projecting it.
func applyOllamaCacheAssumption(rows []store.Usage) []store.Usage {
	var projected []store.Usage
	for i, row := range rows {
		if row.Provider != "ollama-cloud" {
			continue
		}
		if projected == nil {
			projected = append([]store.Usage(nil), rows...)
		}
		u := &projected[i]
		u.USD, u.NoCacheUSD = nil, nil
		u.CacheEstimated, u.EstimatedCachedTokens = false, 0
		unknown := store.UnknownInputBasis
		u.Basis = &unknown
		if row.Model == nil || row.Input == nil || row.Output == nil ||
			!validTokenCount(*row.Input) || !validTokenCount(*row.Output) ||
			(row.Basis != nil && *row.Basis == store.UnknownInputBasis) {
			continue
		}
		rate, ok := store.ModelPriceEvidence(row.Provider, *row.Model, row.At)
		if !ok || rate.Status != "official" || rate.Conflict != nil ||
			rate.Rates[0] == nil || rate.Rates[1] == nil || rate.Rates[2] == nil {
			continue
		}
		input, output, cached := *rate.Rates[0], *rate.Rates[1], *rate.Rates[2]
		if !validTokenCount(input) || !validTokenCount(output) || !validTokenCount(cached) {
			continue
		}
		usd := (*row.Input*((1-ollamaCacheRate)*input+ollamaCacheRate*cached) + *row.Output*output) / 1e6
		noCache := (*row.Input*input + *row.Output*output) / 1e6
		if !validTokenCount(usd) || !validTokenCount(noCache) {
			continue
		}
		estimated := "local-catalog"
		u.USD, u.NoCacheUSD, u.Basis = &usd, &noCache, &estimated
		u.CacheEstimated = true
		u.EstimatedCachedTokens = *row.Input * ollamaCacheRate
	}
	if projected != nil {
		return projected
	}
	return rows
}
