package runtime

import (
	"encoding/json"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
)

// Direct-read outcomes are kept in meta so a restart keeps each account's
// back-off and last status instead of retrying a refused credential at once.
const directOutcomesKey = "directOutcomesV1"

func (rt *Runtime) restoreDirectOutcomes() {
	if rt.Store == nil || rt.sched == nil {
		return
	}
	raw, ok := rt.Store.Meta(directOutcomesKey)
	if !ok || raw == nil {
		return
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return
	}
	var prior []collect.Outcome
	if json.Unmarshal(b, &prior) == nil {
		rt.sched.Restore(prior)
	}
}

func (rt *Runtime) persistDirectOutcomes(outcomes []collect.Outcome) error {
	if rt.Store == nil || len(outcomes) == 0 {
		return nil
	}
	return rt.Store.SetMeta(directOutcomesKey, outcomes)
}

func iso(ms int64) *string {
	if ms <= 0 {
		return nil
	}
	s := time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
	return &s
}

// attachDirectStatus sets account.refresh and account.directQuota from the
// outcomes of every endpoint read for that account. The worst endpoint wins
// the status; the next attempt is the soonest one.
func attachDirectStatus(providers []contract.Provider, outcomes []collect.Outcome, now time.Time) {
	type acc struct{ p, a string }
	by := map[acc][]collect.Outcome{}
	for _, o := range outcomes {
		by[acc{o.Provider, o.Account}] = append(by[acc{o.Provider, o.Account}], o)
	}
	for i := range providers {
		for j := range providers[i].Accounts {
			a := &providers[i].Accounts[j]
			list := by[acc{providers[i].ID, a.ID}]
			if len(list) == 0 {
				continue
			}
			status, last, next := "ok", int64(0), int64(0)
			okCount := 0
			for _, o := range list {
				if o.Status == "ok" {
					okCount++
				} else if status == "ok" || status == "partial" {
					status = o.Status
				}
				if o.LastAttemptAt > last {
					last = o.LastAttemptAt
				}
				if o.NextAttemptAt > 0 && (next == 0 || o.NextAttemptAt < next) {
					next = o.NextAttemptAt
				}
			}
			if status != "ok" && okCount > 0 {
				status = "partial"
			}
			dq := map[string]any{"status": status, "reason": nil, "nextAttemptAt": iso(next)}
			a.DirectQuota = dq
			refresh := "ok"
			if status != "ok" {
				refresh = "delayed"
			}
			a.Refresh = map[string]any{"status": refresh, "lastAttemptAt": iso(last), "nextAttemptAt": iso(next)}
		}
	}
}
