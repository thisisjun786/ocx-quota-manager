package runtime

import "github.com/thisisjun786/ocx-quota-manager/internal/contract"

// Last-good maps are immutable after publish. Copy the status overlay, and
// associate nested analytics by ID while preserving the newly collected quota.
func retainAnalysis(previous contract.Snapshot, providers []contract.Provider) (map[string]any, []contract.Provider) {
	analytics := map[string]any{"lastCollectedAt": nil}
	if old, ok := previous.Analytics.(map[string]any); ok {
		for k, v := range old {
			analytics[k] = v
		}
	}
	analytics["status"] = "error"
	analytics["usageStale"] = true
	oldProviders := map[string]contract.Provider{}
	for _, p := range previous.Providers {
		oldProviders[p.ID] = p
	}
	changed := len(previous.Providers) != len(providers)
	for i := range providers {
		p := &providers[i]
		old, ok := oldProviders[p.ID]
		if !ok {
			changed = true
			continue
		}
		providerChanged := len(p.Accounts) != len(old.Accounts)
		p.Analytics = old.Analytics
		accounts := map[string]contract.Account{}
		for _, a := range old.Accounts {
			accounts[a.ID] = a
		}
		for j := range p.Accounts {
			a := &p.Accounts[j]
			prior, ok := accounts[a.ID]
			if !ok {
				providerChanged = true
				continue
			}
			accountChanged := false
			matched := false
			a.Analytics = prior.Analytics
			windows := map[string]contract.Window{}
			for _, w := range prior.Windows {
				windows[w.ID] = w
			}
			for k := range a.Windows {
				w := &a.Windows[k]
				if prior, ok := windows[w.ID]; ok {
					matched = true
					if sameEpoch(prior.IdentityEpoch, w.IdentityEpoch) {
						w.Analytics = prior.Analytics
					} else {
						accountChanged = true
					}
				}
			}
			if !matched {
				for _, w := range prior.Windows {
					if w.IdentityEpoch != nil {
						accountChanged = true
					}
				}
			}
			if accountChanged {
				a.Analytics = nil
				for k := range a.Windows {
					a.Windows[k].Analytics = nil
				}
				providerChanged = true
			}
		}
		if providerChanged {
			p.Analytics = nil
			changed = true
		}
	}
	if changed {
		for _, key := range []string{"quotaRecommendations", "forecast", "coverage", "subscriptionRecommendation"} {
			delete(analytics, key)
		}
	}
	return analytics, providers
}

func sameEpoch(a, b *int64) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
