package runtime

import (
	"math"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

type usageAccount struct{ provider, account string }
type usagePeriodResult struct {
	top       map[string]any
	providers map[string]map[string]any
	accounts  map[usageAccount]map[string]any
}
type usageSum struct {
	requests, priced, unknown, unsized, cacheEstimated, local int
	usd, tokens, input, output, cached, unknownTokens         float64
	noCache, estimatedCached                                  float64
	noCacheKnown                                              bool
}

func (s *usageSum) add(u store.Usage, p calc.AppliedPrice) {
	s.requests++
	if u.Tokens != nil {
		s.tokens += *u.Tokens
	}
	if u.Input != nil {
		s.input += *u.Input
	}
	if u.Output != nil {
		s.output += *u.Output
	}
	if u.Cached != nil {
		s.cached += *u.Cached
	}
	if p.USD == nil {
		s.unknown++
		if u.Tokens != nil && *u.Tokens > 0 {
			s.unknownTokens += *u.Tokens
		} else {
			s.unsized++
		}
	} else {
		s.priced++
		s.usd += *p.USD
		if p.Origin != calc.OriginStored || (u.Basis != nil && *u.Basis == "local-catalog") {
			s.local++
		}
	}
	if u.NoCacheUSD != nil {
		s.noCache += *u.NoCacheUSD
		s.noCacheKnown = true
	}
	s.estimatedCached += u.EstimatedCachedTokens
	if p.CacheGuess || u.CacheEstimated {
		s.cacheEstimated++
	}
}
func (s usageSum) amount() *float64 {
	if s.priced == 0 {
		return nil
	}
	v := s.usd
	return &v
}
func (s usageSum) dto(hours, logHours float64, observed *float64, now int64) map[string]any {
	var noCache *float64
	if s.noCacheKnown {
		noCache = &s.noCache
	}
	return map[string]any{
		"hours": hours, "startedAt": time.UnixMilli(now - int64(hours*calc.HourMs)).UTC().Format(time.RFC3339Nano), "endedAt": time.UnixMilli(now).UTC().Format(time.RFC3339Nano),
		"logCoverageHours": logHours, "observedCoverageHours": observed,
		"requests": s.requests, "pricedRequests": s.priced, "apiUsd": s.amount(), "unknownPriceRequests": s.unknown,
		"unknownPriceTokens": s.unknownTokens, "unknownPriceUnsizedRequests": s.unsized,
		"cacheEstimatedRequests": s.cacheEstimated, "localPriceRequests": s.local,
		"tokens": s.tokens, "inputTokens": s.input, "outputTokens": s.output, "cachedTokens": s.cached,
		"noCacheApiUsd": noCache, "estimatedCachedTokens": s.estimatedCached,
	}
}
func observedUsageHours(hist usageStore, now int64, hours float64) *float64 {
	if hist == nil {
		return nil
	}
	number := func(key string) (float64, bool) {
		v, ok := hist.Meta(key)
		if !ok {
			return 0, false
		}
		switch n := v.(type) {
		case float64:
			return n, !math.IsNaN(n) && !math.IsInf(n, 0)
		case int64:
			return float64(n), true
		case int:
			return float64(n), true
		}
		return 0, false
	}
	since, ok := number("usageObservedSince")
	if !ok {
		return nil
	}
	through, ok := number("usageObservedThrough")
	if !ok {
		return nil
	}
	for _, key := range []string{"historyResetAt", "usageExcludedBefore"} {
		if n, ok := number(key); ok {
			since = math.Max(since, n)
		}
	}
	span := math.Max(0, math.Min(float64(now), through)-math.Max(float64(now)-hours*calc.HourMs, since)) / calc.HourMs
	return &span
}

// One pass per horizon; account membership never guesses a missing identity.
func buildUsagePeriods(rows []store.Usage, prices []calc.AppliedPrice, providers []contract.Provider, hist usageStore, now int64) usagePeriodResult {
	result := usagePeriodResult{top: map[string]any{}, providers: map[string]map[string]any{}, accounts: map[usageAccount]map[string]any{}}
	listed := map[usageAccount]bool{}
	for _, p := range providers {
		result.providers[p.ID] = map[string]any{}
		for _, a := range p.Accounts {
			key := usageAccount{p.ID, a.ID}
			listed[key] = true
			result.accounts[key] = map[string]any{}
		}
	}
	earliest := now
	hasPast := false
	for _, u := range rows {
		if u.At <= now && (!hasPast || u.At < earliest) {
			earliest = u.At
			hasPast = true
		}
	}
	for key, hours := range calc.PeriodHours {
		var total usageSum
		perProvider := map[string]*usageSum{}
		perAccount := map[usageAccount]*usageSum{}
		partitions := map[string][3]*usageSum{}
		for _, p := range providers {
			perProvider[p.ID] = &usageSum{}
			partitions[p.ID] = [3]*usageSum{{}, {}, {}}
		}
		for a := range listed {
			perAccount[a] = &usageSum{}
		}
		for i, u := range rows {
			if u.At <= now-int64(hours*calc.HourMs) || u.At > now {
				continue
			}
			price := prices[i]
			total.add(u, price)
			if p := perProvider[u.Provider]; p != nil {
				p.add(u, price)
				part := partitions[u.Provider]
				bucket := 2
				if u.Account != nil {
					a := usageAccount{u.Provider, *u.Account}
					bucket = 1
					if listed[a] {
						bucket = 0
						perAccount[a].add(u, price)
					}
				}
				part[bucket].add(u, price)
			}
		}
		logHours := 0.0
		if hasPast {
			logHours = math.Min(hours, float64(now-earliest)/calc.HourMs)
		}
		observed := observedUsageHours(hist, now, hours)
		result.top[key] = total.dto(hours, logHours, observed, now)
		for id, p := range perProvider {
			dto := p.dto(hours, logHours, observed, now)
			for j, prefix := range []string{"listedAccount", "unlistedAccount", "unattributed"} {
				part := partitions[id][j]
				dto[prefix+"Requests"] = part.requests
				dto[prefix+"Tokens"] = part.tokens
				dto[prefix+"ApiUsd"] = part.amount()
			}
			result.providers[id][key] = dto
		}
		for a, s := range perAccount {
			result.accounts[a][key] = s.dto(hours, logHours, observed, now)
		}
	}
	return result
}
