package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"testing"
	"time"
)

func TestKimiCachedObservationEntersPeriodRecommendationOnce(t *testing.T) {
	now := int64(1800000000000)
	h := openProbeStore(t)
	rt := New(nil, h, nil)
	epoch := int64(7)
	p := []contract.Provider{{ID: "kimi", Name: "Kimi", Enabled: true, SupportedModels: []string{"k3[1m]"}, Accounts: []contract.Account{{ID: "a", Status: "ok", UpdatedAt: repairPtr(time.UnixMilli(now).UTC().Format(time.RFC3339Nano)), Windows: []contract.Window{{ID: "weekly", RemainingPercent: repairPtr(100.0), ResetAt: repairPtr(time.UnixMilli(now + 168*3600000).UTC().Format(time.RFC3339Nano))}}}}}}
	epochs := map[string]int64{"kimi\x00a": epoch}
	for i := 0; i < 4; i++ {
		at := now + int64(i)*600000
		p[0].Accounts[0].UpdatedAt = repairPtr(time.UnixMilli(at).UTC().Format(time.RFC3339Nano))
		p[0].Accounts[0].Windows[0].RemainingPercent = repairPtr(100.0 - float64(i)*10)
		if err := rt.persistLocalObservations(p, epochs, at); err != nil {
			t.Fatal(err)
		}
		if err := rt.persistLocalObservations(p, epochs, at); err != nil {
			t.Fatal(err)
		}
	}
	obs, err := h.ListObservations()
	if err != nil || len(obs) != 3 {
		t.Fatalf("cache reread counted: %d %v", len(obs), err)
	}
	_, providers, err := attachAnalytics(p, h, time.UnixMilli(now+1800000), "absent")
	if err != nil {
		t.Fatal(err)
	}
	recs := providers[0].Analytics.(map[string]any)["quotaRecommendations"].(map[string]any)
	hour := recs["oneHour"].(map[string]any)
	if n, ok := hour["recommendedAccounts"].(*int); !ok || n == nil || *n != 34 {
		t.Fatalf("kimi recommendation %v", hour)
	}
	prices := providers[0].Analytics.(map[string]any)["modelPrices"].([]map[string]any)
	if len(prices) != 1 || prices[0]["status"] != "ocx-provided" {
		t.Fatalf("kimi price missing %v", prices)
	}
}
