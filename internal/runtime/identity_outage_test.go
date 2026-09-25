package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"testing"
	"time"
)

func TestLastGoodOutageKeepsItsIdentity(t *testing.T) {
	now := int64(1800000000000)
	reset := now + 86400000
	row := collect.Reading{Provider: "anthropic", Account: "a", WindowID: "weekly", Kind: collect.WindowFailed, ObservedAt: now, RemainingPercent: repairPtr(60.0), ResetAt: &reset}
	providers := []contract.Provider{{ID: "anthropic", Accounts: []contract.Account{{ID: "a", Status: "stale", UpdatedAt: repairPtr(time.UnixMilli(now).UTC().Format(time.RFC3339Nano)), Windows: []contract.Window{{ID: "weekly", RemainingPercent: repairPtr(60.0), ResetAt: repairPtr(time.UnixMilli(reset).UTC().Format(time.RFC3339Nano))}}}}}}
	applyReadingEpochs(providers, []collect.Reading{row}, map[string]int64{"anthropic\x00a": 6})
	if providers[0].Accounts[0].Windows[0].IdentityEpoch == nil {
		t.Fatal("last-good reading lost its identity on outage")
	}
}
