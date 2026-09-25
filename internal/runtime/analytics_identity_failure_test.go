package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"testing"
)

func TestRetainAnalysisDropsReplacedIdentityAndProviderAggregate(t *testing.T) {
	oldE, newE := int64(1), int64(2)
	old := contract.Snapshot{Analytics: map[string]any{"quotaRecommendations": "old"}, Providers: []contract.Provider{{ID: "p", Analytics: map[string]any{"quotaRecommendations": "old"}, Accounts: []contract.Account{{ID: "a", Analytics: map[string]any{"old": true}, Windows: []contract.Window{{ID: "weekly", IdentityEpoch: &oldE, Analytics: map[string]any{"capacityApiUsd": 100}}}}}}}}
	for _, epoch := range []*int64{&newE, nil} {
		current := []contract.Provider{{ID: "p", Accounts: []contract.Account{{ID: "a", Windows: []contract.Window{{ID: "weekly", IdentityEpoch: epoch}}}}}}
		top, got := retainAnalysis(old, current)
		if got[0].Analytics != nil || got[0].Accounts[0].Analytics != nil || got[0].Accounts[0].Windows[0].Analytics != nil || top["quotaRecommendations"] != nil {
			t.Fatal("old identity analytics leaked", got, top)
		}
	}
}
