package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"time"
)

type localObservation struct {
	epoch int64
	at    int64
}

// Providers without a direct adapter still have real OCX quota observations.
// Observe source timestamps, never collector ticks. The first cached reading
// after a binding change is only a baseline; a newer source reading is required
// before it can belong to that binding.
func (rt *Runtime) persistLocalObservations(providers []contract.Provider, epochs map[string]int64, now int64) error {
	if rt.Store == nil {
		return nil
	}
	if rt.localObservations == nil {
		rt.localObservations = map[string]localObservation{}
	}
	for pi := range providers {
		p := &providers[pi]
		directEnabled := false
		for _, id := range rt.Direct {
			if id == p.ID {
				directEnabled = true
			}
		}
		if collect.IsRegisteredDirect(p.ID) && directEnabled {
			continue
		}
		for ai := range p.Accounts {
			a := &p.Accounts[ai]
			epoch, ok := epochs[p.ID+"\x00"+a.ID]
			if !ok || a.UpdatedAt == nil || a.Status == "reauth" || a.Status == "paused" {
				continue
			}
			at, err := time.Parse(time.RFC3339Nano, *a.UpdatedAt)
			if err != nil || at.UnixMilli() > now || now-at.UnixMilli() > 15*60*1000 {
				continue
			}
			for wi := range a.Windows {
				w := &a.Windows[wi]
				if w.Stale != nil && *w.Stale || w.ResetAt == nil || w.RemainingPercent == nil {
					continue
				}
				reset, err := time.Parse(time.RFC3339Nano, *w.ResetAt)
				if err != nil || reset.UnixMilli() <= at.UnixMilli() {
					continue
				}
				key := p.ID + "\x00" + a.ID + "\x00" + w.ID
				previous, exists := rt.localObservations[key]
				if !exists || previous.epoch != epoch {
					rt.localObservations[key] = localObservation{epoch, at.UnixMilli()}
					continue
				}
				if at.UnixMilli() < previous.at {
					continue
				}
				if at.UnixMilli() == previous.at {
					if previous.at > 0 {
						e := epoch
						w.IdentityEpoch = &e
					}
					continue
				}
				e := epoch
				w.IdentityEpoch = &e
				used := 100 - *w.RemainingPercent
				resetMS := reset.UnixMilli()
				source, version, method, scope, unit := "ocx-quota-cache", "1", "reported_percent", "all", "percent"
				if err := rt.Store.InsertObservation(store.Observation{Provider: p.ID, Account: a.ID, Window: w.ID, At: at.UnixMilli(), Epoch: &e, Basis: "ok", ReportedPercent: &used, ObservedPercent: used, Reset: &resetMS, WindowSemantics: "fixed_reset", LimitState: "missing", Source: &source, SourceVersion: &version, Method: &method, ScopeKey: &scope, Unit: &unit, PrecisionEvidence: "unknown", Reconciliation: "unverified", UsedAccumulation: "unknown"}); err != nil {
					return err
				}
				rt.localObservations[key] = localObservation{epoch, at.UnixMilli()}
			}
		}
	}
	return nil
}
