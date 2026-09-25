package runtime

import (
	"encoding/json"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"slices"
	"sort"
	"time"
)

type rosterModel struct {
	FirstSeenAt    int64    `json:"firstSeenAt"`
	LastListedAt   *int64   `json:"lastListedAt"`
	LastObservedAt *int64   `json:"lastObservedAt"`
	RemovedAt      *int64   `json:"removedAt"`
	Listed         bool     `json:"listed"`
	Sources        []string `json:"sources"`
}
type rosterChange struct {
	At     int64  `json:"at"`
	Model  string `json:"model"`
	Change string `json:"change"`
}
type rosterProvider struct {
	BaselineAt     int64                   `json:"baselineAt"`
	Baselined      bool                    `json:"baselined"`
	ListedReadings int                     `json:"listedReadings"`
	SeenAt         *int64                  `json:"seenAt"`
	ListedAt       *int64                  `json:"listedAt"`
	SuspectSince   *int64                  `json:"suspectSince"`
	Models         map[string]*rosterModel `json:"models"`
	Changes        []rosterChange          `json:"changes"`
}
type rosterState struct {
	LastAttemptAt *int64                     `json:"lastAttemptAt"`
	LastSuccessAt *int64                     `json:"lastSuccessAt"`
	FailureSince  *int64                     `json:"failureSince"`
	Providers     map[string]*rosterProvider `json:"providers"`
}

func rosterRead(hist interface{ Meta(string) (any, bool) }) rosterState {
	state := rosterState{Providers: map[string]*rosterProvider{}}
	if hist == nil {
		return state
	}
	raw, ok := hist.Meta("modelRosterV1")
	if !ok {
		return state
	}
	// Meta JSON is decoded into generic maps by the store. Re-encode only at this
	// persistence boundary; the typed record preserves the Node writer's schema.
	data, err := json.Marshal(raw)
	if err != nil {
		return state
	}
	if json.Unmarshal(data, &state) != nil || state.Providers == nil {
		state.Providers = map[string]*rosterProvider{}
	}
	return state
}
func rosterISO(at *int64) any {
	if at == nil || *at <= 0 {
		return nil
	}
	return time.UnixMilli(*at).UTC().Format(time.RFC3339Nano)
}
func rosterStamp(at int64) any { return rosterISO(&at) }
func recordRoster(providers []contract.Provider, rows []store.Usage, hist interface{ Meta(string) (any, bool) }, now time.Time) error {
	if hist == nil {
		return nil
	}
	writer, ok := hist.(interface{ SetMeta(string, any) error })
	if !ok {
		return nil
	}
	state := rosterRead(hist)
	at := now.UnixMilli()
	state.LastAttemptAt = &at
	state.LastSuccessAt = &at
	state.FailureSince = nil
	observed := map[string]map[string]bool{}
	for _, u := range rows {
		if u.Model != nil && *u.Model != "" && u.At <= at {
			if observed[u.Provider] == nil {
				observed[u.Provider] = map[string]bool{}
			}
			observed[u.Provider][*u.Model] = true
		}
	}
	for _, p := range providers {
		entry := state.Providers[p.ID]
		if entry == nil {
			entry = &rosterProvider{BaselineAt: at, Models: map[string]*rosterModel{}, Changes: []rosterChange{}}
			state.Providers[p.ID] = entry
		}
		if entry.Models == nil {
			entry.Models = map[string]*rosterModel{}
		}
		baseline := !entry.Baselined
		first := entry.SeenAt == nil
		entry.SeenAt = &at
		listed := map[string]bool{}
		for _, name := range p.SupportedModels {
			if name != "" {
				listed[name] = true
			}
		}
		// Empty lists are not proof of removal: a config parse can project to empty.
		if len(listed) > 0 {
			entry.Baselined = true
			entry.ListedReadings++
			entry.ListedAt = &at
			entry.SuspectSince = nil
			for name := range listed {
				m := entry.Models[name]
				if m == nil {
					m = &rosterModel{FirstSeenAt: at, Sources: []string{"ocx-config"}}
					entry.Models[name] = m
					if !baseline {
						entry.Changes = append(entry.Changes, rosterChange{at, name, "added"})
					}
				} else if !m.Listed && !baseline {
					change := "added"
					if m.RemovedAt != nil {
						change = "returned"
					}
					entry.Changes = append(entry.Changes, rosterChange{at, name, change})
				}
				m.Listed = true
				m.LastListedAt = &at
				m.RemovedAt = nil
				if !slices.Contains(m.Sources, "ocx-config") {
					m.Sources = append([]string{"ocx-config"}, m.Sources...)
				}
			}
			for name, m := range entry.Models {
				if m.Listed && !listed[name] {
					m.Listed = false
					m.RemovedAt = &at
					entry.Changes = append(entry.Changes, rosterChange{at, name, "removed"})
				}
			}
		}
		for name := range observed[p.ID] {
			m := entry.Models[name]
			if m == nil {
				m = &rosterModel{FirstSeenAt: at, Sources: []string{"observed"}}
				entry.Models[name] = m
				if !first {
					entry.Changes = append(entry.Changes, rosterChange{at, name, "observed"})
				}
			}
			m.LastObservedAt = &at
			if !slices.Contains(m.Sources, "observed") {
				m.Sources = append(m.Sources, "observed")
			}
		}
		if len(entry.Changes) > 100 {
			entry.Changes = entry.Changes[len(entry.Changes)-100:]
		}
	}
	return writer.SetMeta("modelRosterV1", state)
}
func attachRoster(providers []contract.Provider, hist interface{ Meta(string) (any, bool) }) map[string]any {
	state := rosterRead(hist)
	present := map[string]bool{}
	for i := range providers {
		p := &providers[i]
		present[p.ID] = true
		entry := state.Providers[p.ID]
		view := map[string]any{"status": "unknown", "baselineAt": nil, "listedAt": nil, "suspectSince": nil, "listedCount": 0, "knownCount": 0, "models": []map[string]any{}, "changes": []map[string]any{}}
		if entry != nil {
			status := "ok"
			if state.LastSuccessAt == nil || entry.SeenAt == nil || *entry.SeenAt != *state.LastSuccessAt {
				status = "absent"
			} else if !entry.Baselined {
				status = "unknown"
			} else if entry.SuspectSince != nil {
				status = "suspect"
			} else if entry.ListedReadings <= 1 {
				status = "baseline"
			}
			names := make([]string, 0, len(entry.Models))
			for name := range entry.Models {
				names = append(names, name)
			}
			sort.Strings(names)
			models := []map[string]any{}
			listed := 0
			for _, name := range names {
				m := entry.Models[name]
				if m == nil {
					continue
				}
				s := "observed-only"
				if m.Listed {
					s = "listed"
					listed++
				} else if m.RemovedAt != nil {
					s = "removed"
				}
				models = append(models, map[string]any{"model": name, "state": s, "sources": m.Sources, "firstSeenAt": rosterStamp(m.FirstSeenAt), "lastListedAt": rosterISO(m.LastListedAt), "lastObservedAt": rosterISO(m.LastObservedAt), "removedAt": rosterISO(m.RemovedAt)})
			}
			changes := []map[string]any{}
			for j := len(entry.Changes) - 1; j >= 0 && len(changes) < 20; j-- {
				c := entry.Changes[j]
				changes = append(changes, map[string]any{"at": rosterStamp(c.At), "model": c.Model, "change": c.Change})
			}
			view = map[string]any{"status": status, "baselineAt": rosterStamp(entry.BaselineAt), "listedAt": rosterISO(entry.ListedAt), "suspectSince": rosterISO(entry.SuspectSince), "listedCount": listed, "knownCount": len(models), "models": models, "changes": changes}
		}
		p.Analytics.(map[string]any)["modelRoster"] = view
	}
	absent := []string{}
	for id, entry := range state.Providers {
		if !present[id] || (entry.SeenAt != nil && state.LastSuccessAt != nil && *entry.SeenAt != *state.LastSuccessAt) {
			absent = append(absent, id)
		}
	}
	sort.Strings(absent)
	status := "ok"
	if state.FailureSince != nil {
		status = "failed"
	} else if state.LastSuccessAt == nil {
		status = "collecting"
	}
	return map[string]any{"status": status, "lastAttemptAt": rosterISO(state.LastAttemptAt), "lastSuccessAt": rosterISO(state.LastSuccessAt), "failureSince": rosterISO(state.FailureSince), "absentProviders": absent}
}
