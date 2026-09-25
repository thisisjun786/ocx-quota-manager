package runtime

import (
	"context"
	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestKimiDirectCyclesPopulateRecommendation(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1800000000000)}
	home := writeProbeHome(t, map[string]string{"kimi": "synthetic"})
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"providers":{"kimi":{"authMode":"oauth","baseUrl":"https://api.kimi.com/coding/v1","models":["k3[1m]"]}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	h := openProbeStore(t)
	f := &collect.Fake{Responses: []transport.Response{
		{Status: 200, Body: []byte(`{"usage":{"limit":100,"used":0,"resetAt":1800500000000}}`)},
		{Status: 200, Body: []byte(`{"usage":{"limit":100,"used":10,"resetAt":1800500000000}}`)},
	}}
	rt := New(clk, h, f)
	rt.Home = home
	rt.Direct = []string{"kimi"}
	rt.cycle(context.Background())
	rt.cycle(context.Background())
	clk.Set(clk.Now().Add(10 * time.Minute))
	rt.cycle(context.Background())
	obs, err := h.ListObservations()
	if err != nil || len(obs) != 2 {
		t.Fatalf("observations %d %v calls %d", len(obs), err, f.CallCount())
	}
	if obs[0].Epoch == nil || obs[1].Epoch == nil || *obs[0].Epoch != *obs[1].Epoch {
		t.Fatal("identity lost")
	}
	snap := rt.Snapshot()
	p := snap.Providers[0]
	rec := p.Analytics.(map[string]any)["quotaRecommendations"].(map[string]any)["oneHour"].(map[string]any)
	n, ok := rec["recommendedAccounts"].(*int)
	if !ok || n == nil || *n != 17 {
		t.Fatalf("rec %v", rec)
	}
	if p.Accounts[0].Status != "ok" {
		t.Fatal(p.Accounts[0].Status)
	}
}
