package runtime

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

type gapFinding struct {
	Model       string `json:"model"`
	Reason      string `json:"reason"`
	FirstSeenAt int64  `json:"firstSeenAt"`
	LastSeenAt  int64  `json:"lastSeenAt"`
	ResolvedAt  *int64 `json:"resolvedAt"`
	Occurrences int    `json:"occurrences"`
	Recurrences int    `json:"recurrences"`
}
type gapChange struct {
	At     int64  `json:"at"`
	Model  string `json:"model"`
	Reason string `json:"reason"`
	Change string `json:"change"`
}
type gapProvider struct {
	Since     int64                  `json:"since"`
	Readings  int                    `json:"readings"`
	SeenAt    *int64                 `json:"seenAt"`
	Findings  map[string]*gapFinding `json:"findings"`
	Confirmed map[string]int64       `json:"confirmed"`
	Changes   []gapChange            `json:"changes"`
}
type gapState struct {
	LastAttemptAt *int64                  `json:"lastAttemptAt"`
	LastSuccessAt *int64                  `json:"lastSuccessAt"`
	FailureSince  *int64                  `json:"failureSince"`
	Providers     map[string]*gapProvider `json:"providers"`
}

func readGaps(hist interface{ Meta(string) (any, bool) }) gapState {
	state := gapState{Providers: map[string]*gapProvider{}}
	if hist == nil {
		return state
	}
	raw, ok := hist.Meta("priceGapsV1")
	if !ok {
		return state
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return state
	}
	if json.Unmarshal(data, &state) != nil || state.Providers == nil {
		state.Providers = map[string]*gapProvider{}
	}
	return state
}
func gapReasons(price map[string]any, requests, unpriced int) []string {
	reasons := []string{}
	if price == nil {
		if unpriced > 0 {
			return []string{"price-missing"}
		}
		return reasons
	}
	status, _ := price["status"].(string)
	if status == "unpriced" {
		return []string{"price-missing"}
	}
	if unpriced > 0 {
		reasons = append(reasons, "unpriced-usage")
	}
	if requests > 0 {
		if rates, ok := price["rates"].(map[string]any); ok && (rates["input"] == nil || rates["output"] == nil) {
			reasons = append(reasons, "rate-missing")
		}
	}
	if price["sourceUrl"] == nil {
		reasons = append(reasons, "source-missing")
	}
	if price["checkedAt"] == nil {
		reasons = append(reasons, "checked-at-missing")
	}
	if status == "local-catalog" {
		if conditions, ok := price["conditions"].([]string); !ok || len(conditions) == 0 {
			reasons = append(reasons, "condition-missing")
		}
	}
	if price["conflict"] != nil {
		reasons = append(reasons, "price-conflict")
	}
	return reasons
}

// gapViews keeps the last computed per-provider views. The durable state only
// advances every five minutes (as in the Node collector), so recomputing the
// same views on every 10-second cycle only spends CPU.
var gapViews struct {
	sync.Mutex
	at    int64
	views map[string]any
}

func attachPriceGaps(providers []contract.Provider, usage []store.Usage, priced []calc.AppliedPrice, hist interface{ Meta(string) (any, bool) }, now time.Time) (map[string]any, error) {
	state := readGaps(hist)
	at := now.UnixMilli()
	due := state.LastAttemptAt == nil || at-*state.LastAttemptAt >= 5*60*1000
	gapViews.Lock()
	if !due && gapViews.views != nil && state.LastAttemptAt != nil && gapViews.at == *state.LastAttemptAt {
		for i := range providers {
			if v, ok := gapViews.views[providers[i].ID]; ok {
				providers[i].Analytics.(map[string]any)["priceGaps"] = v
			}
		}
		gapViews.Unlock()
		return gapSummary(state), nil
	}
	gapViews.Unlock()
	defer func() {
		if state.LastAttemptAt == nil {
			return
		}
		views := map[string]any{}
		for i := range providers {
			if v, ok := providers[i].Analytics.(map[string]any)["priceGaps"]; ok {
				views[providers[i].ID] = v
			}
		}
		gapViews.Lock()
		gapViews.at, gapViews.views = *state.LastAttemptAt, views
		gapViews.Unlock()
	}()
	if due && hist != nil {
		state.LastAttemptAt = &at
		state.LastSuccessAt = &at
		state.FailureSince = nil
	}
	for i := range providers {
		p := &providers[i]
		analytics := p.Analytics.(map[string]any)
		prices, _ := analytics["modelPrices"].([]map[string]any)
		byPrice := map[string]map[string]any{}
		for _, price := range prices {
			if name, ok := price["model"].(string); ok {
				byPrice[name] = price
			}
		}
		type tally struct {
			requests, unpriced, priced int
			tokens, unpricedTokens     float64
		}
		counts := map[string]*tally{}
		for j, u := range usage {
			if u.Provider != p.ID || u.Model == nil || u.At > at {
				continue
			}
			v := counts[*u.Model]
			if v == nil {
				v = &tally{}
				counts[*u.Model] = v
			}
			v.requests++
			if u.Tokens != nil {
				v.tokens += *u.Tokens
			}
			// A call without token counts cannot be priced by any rate; it is a
			// reporting gap, not a price gap.
			if priced[j].USD != nil {
				v.priced++
			}
			if priced[j].USD == nil && u.Input != nil && u.Output != nil && *u.Input+*u.Output > 0 {
				v.unpriced++
				if u.Tokens != nil {
					v.unpricedTokens += *u.Tokens
				}
			}
		}
		entry := state.Providers[p.ID]
		if due && hist != nil {
			if entry == nil {
				entry = &gapProvider{Since: at, Findings: map[string]*gapFinding{}, Confirmed: map[string]int64{}, Changes: []gapChange{}}
				state.Providers[p.ID] = entry
			}
			if entry.Findings == nil {
				entry.Findings = map[string]*gapFinding{}
			}
			if entry.Confirmed == nil {
				entry.Confirmed = map[string]int64{}
			}
			entry.SeenAt = &at
			entry.Readings++
		}
		models := []map[string]any{}
		flagged := map[string]bool{}
		active := map[string]bool{}
		for _, configured := range p.SupportedModels {
			if _, ok := byPrice[configured]; !ok {
				if c := counts[configured]; c == nil || c.priced == 0 {
					byPrice[configured] = map[string]any{"model": configured, "status": "unpriced"}
				}
			}
		}
		for name, price := range byPrice {
			c := counts[name]
			if c == nil {
				c = &tally{}
			}
			reasons := gapReasons(price, c.requests, c.unpriced)
			if len(reasons) == 0 {
				if due && entry != nil {
					entry.Confirmed[name] = at
				}
				continue
			}
			flagged[name] = true
			findings := []map[string]any{}
			for _, reason := range reasons {
				key := p.ID + "\x00" + name + "\x00" + reason
				active[key] = true
				var known *gapFinding
				if entry != nil {
					known = entry.Findings[key]
				}
				if due && entry != nil {
					if known == nil {
						known = &gapFinding{Model: name, Reason: reason, FirstSeenAt: at, LastSeenAt: at, Occurrences: 1}
						entry.Findings[key] = known
						if entry.Readings > 1 {
							entry.Changes = append(entry.Changes, gapChange{at, name, reason, "opened"})
						}
					} else {
						known.LastSeenAt = at
						known.Occurrences++
						if known.ResolvedAt != nil {
							known.ResolvedAt = nil
							known.Recurrences++
							entry.Changes = append(entry.Changes, gapChange{at, name, reason, "recurred"})
						}
					}
				}
				f := map[string]any{"key": key, "reason": reason, "detail": nil, "items": nil, "pricedModel": nil, "state": "untracked", "recurred": false, "firstSeenAt": nil, "lastSeenAt": nil, "occurrences": 0, "recurrences": 0}
				if known != nil {
					f["state"] = "open"
					f["recurred"] = known.Recurrences > 0
					f["firstSeenAt"] = rosterStamp(known.FirstSeenAt)
					f["lastSeenAt"] = rosterStamp(known.LastSeenAt)
					f["occurrences"] = known.Occurrences
					f["recurrences"] = known.Recurrences
				}
				findings = append(findings, f)
			}
			models = append(models, map[string]any{"model": name, "sources": []string{}, "priceStatus": price["status"], "pricedModel": nil, "requests": c.requests, "unpricedRequests": c.unpriced, "tokens": c.tokens, "rosterState": nil, "lastConfirmedAt": nil, "periods": nil, "carriedFindings": []any{}, "findings": findings})
		}
		if due && entry != nil {
			for key, f := range entry.Findings {
				if active[key] || f.ResolvedAt != nil || byPrice[f.Model] == nil {
					continue
				}
				f.ResolvedAt = &at
				entry.Changes = append(entry.Changes, gapChange{at, f.Model, f.Reason, "resolved"})
			}
			if len(entry.Changes) > 100 {
				entry.Changes = entry.Changes[len(entry.Changes)-100:]
			}
		}
		sort.Slice(models, func(i, j int) bool {
			a, b := models[i]["requests"].(int), models[j]["requests"].(int)
			if a != b {
				return a > b
			}
			return models[i]["model"].(string) < models[j]["model"].(string)
		})
		periods := map[string]any{}
		modelPeriods := map[string]map[string]any{}
		for name := range flagged {
			modelPeriods[name] = map[string]any{}
		}
		for _, period := range []struct {
			key   string
			hours int64
		}{{"oneHour", 1}, {"fiveHour", 5}, {"twentyFourHour", 24}, {"weekly", 168}, {"monthly", 720}} {
			from := at - period.hours*3600000
			bucket := map[string]any{"activeModels": 0, "requests": 0, "tokens": float64(0), "unpricedRequests": 0, "unpricedTokens": float64(0), "unpricedUnsizedRequests": 0, "unnamedModelRequests": 0, "unnamedModelUnpricedRequests": 0, "unnamedModelUnpricedTokens": float64(0), "withheldModelRequests": 0, "withheldModelUnpricedRequests": 0, "withheldModelUnpricedTokens": float64(0), "startedAt": rosterStamp(from), "endedAt": rosterStamp(at), "hours": period.hours}
			for name := range flagged {
				modelPeriods[name][period.key] = map[string]any{"requests": 0, "tokens": float64(0), "unpricedRequests": 0, "unpricedTokens": float64(0), "unpricedUnsizedRequests": 0, "startedAt": rosterStamp(from), "endedAt": rosterStamp(at), "hours": period.hours}
			}
			seen := map[string]bool{}
			for j, u := range usage {
				if u.Provider != p.ID || u.At <= from || u.At > at {
					continue
				}
				if u.Model == nil {
					bucket["unnamedModelRequests"] = bucket["unnamedModelRequests"].(int) + 1
					continue
				}
				name := *u.Model
				if !flagged[name] {
					continue
				}
				seen[name] = true
				b := modelPeriods[name][period.key].(map[string]any)
				for _, v := range []map[string]any{b, bucket} {
					v["requests"] = v["requests"].(int) + 1
					if u.Tokens != nil {
						v["tokens"] = v["tokens"].(float64) + *u.Tokens
					}
					if priced[j].USD == nil {
						v["unpricedRequests"] = v["unpricedRequests"].(int) + 1
						if u.Tokens != nil {
							v["unpricedTokens"] = v["unpricedTokens"].(float64) + *u.Tokens
						} else {
							v["unpricedUnsizedRequests"] = v["unpricedUnsizedRequests"].(int) + 1
						}
					}
				}
			}
			bucket["activeModels"] = len(seen)
			periods[period.key] = bucket
		}
		for _, m := range models {
			m["periods"] = modelPeriods[m["model"].(string)]
		}
		resolved := []map[string]any{}
		changes := []map[string]any{}
		if entry != nil {
			for key, f := range entry.Findings {
				if f.ResolvedAt != nil && !active[key] {
					resolved = append(resolved, map[string]any{"key": key, "model": f.Model, "reason": f.Reason, "firstSeenAt": rosterStamp(f.FirstSeenAt), "lastSeenAt": rosterStamp(f.LastSeenAt), "resolvedAt": rosterISO(f.ResolvedAt), "occurrences": f.Occurrences, "recurrences": f.Recurrences})
				}
			}
			sort.Slice(resolved, func(i, j int) bool { return resolved[i]["key"].(string) < resolved[j]["key"].(string) })
			if len(resolved) > 20 {
				resolved = resolved[:20]
			}
			for j := len(entry.Changes) - 1; j >= 0 && len(changes) < 20; j-- {
				c := entry.Changes[j]
				changes = append(changes, map[string]any{"at": rosterStamp(c.At), "model": c.Model, "reason": c.Reason, "change": c.Change})
			}
		}
		status := "ok"
		since := any(nil)
		readings := 0
		if entry == nil {
			status = "collecting"
		} else {
			since = rosterStamp(entry.Since)
			readings = entry.Readings
		}
		analytics["priceGaps"] = map[string]any{"status": status, "since": since, "readings": readings, "modelsNeedingPriceCheck": len(models), "models": models, "carriedModels": []any{}, "resolved": resolved, "changes": changes, "confirmedNewModels": []any{}, "retiredModels": []any{}, "periods": periods, "modelPeriodImpact": modelPeriods}
	}
	if due && hist != nil {
		writer, ok := hist.(interface{ SetMeta(string, any) error })
		if ok {
			if err := writer.SetMeta("priceGapsV1", state); err != nil {
				return nil, fmt.Errorf("save price gaps: %w", err)
			}
		}
	}
	return gapSummary(state), nil
}

func gapSummary(state gapState) map[string]any {
	status := "ok"
	if state.LastSuccessAt == nil {
		status = "collecting"
	}
	return map[string]any{"status": status, "lastAttemptAt": rosterISO(state.LastAttemptAt), "lastSuccessAt": rosterISO(state.LastSuccessAt), "failureSince": rosterISO(state.FailureSince), "catalogStatus": nil, "modelListStatus": nil, "resolutionBlocked": false, "unreportedProviders": []string{}}
}
