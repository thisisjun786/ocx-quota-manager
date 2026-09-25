package runtime

import (
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
)

func TestAttachDirectStatusReportsWorstEndpointAndSoonestRetry(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	providers := []contract.Provider{{ID: "openai", Accounts: []contract.Account{{ID: "a"}, {ID: "b"}, {ID: "quiet"}}}}
	attachDirectStatus(providers, []collect.Outcome{
		{Provider: "openai", Account: "a", Endpoint: "e1", Status: "ok", LastAttemptAt: 1, NextAttemptAt: 5_000},
		{Provider: "openai", Account: "a", Endpoint: "e2", Status: "rate_limited", LastAttemptAt: 2, NextAttemptAt: 3_000},
		{Provider: "openai", Account: "b", Endpoint: "e1", Status: "unauthorized", LastAttemptAt: 2, NextAttemptAt: 9_000},
	}, now)
	a := providers[0].Accounts[0].DirectQuota.(map[string]any)
	if a["status"] != "partial" || *a["nextAttemptAt"].(*string) != *iso(3_000) {
		t.Fatalf("mixed endpoints: %+v", a)
	}
	b := providers[0].Accounts[1]
	if b.DirectQuota.(map[string]any)["status"] != "unauthorized" || b.Refresh.(map[string]any)["status"] != "delayed" {
		t.Fatalf("failed account: %+v %+v", b.DirectQuota, b.Refresh)
	}
	if providers[0].Accounts[2].DirectQuota != nil {
		t.Fatal("an account without direct reads must not claim a status")
	}
}
