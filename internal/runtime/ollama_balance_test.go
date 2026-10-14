package runtime

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

const (
	ollamaProbeFirst = `{"included":{
		"session":{"remaining_percent":76.9,"resets_at":"2026-10-07T23:00:00Z"},
		"weekly":{"remaining_percent":83.4,"resets_at":"2026-10-12T00:00:00Z"}
	},"purchased":{"balance_usd":11.22}}`
	ollamaProbeSecond = `{"included":{
		"session":{"remaining_percent":74.5,"resets_at":"2026-10-07T23:00:00Z"},
		"weekly":{"remaining_percent":83.1,"resets_at":"2026-10-12T00:00:00Z"}
	},"purchased":{"balance_usd":11.22}}`
)

func ollamaBalanceProbeHome(t *testing.T, providers map[string]any) string {
	t.Helper()
	dir := t.TempDir()
	cfg, err := json.Marshal(map[string]any{"providers": providers})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), cfg, 0600); err != nil {
		t.Fatal(err)
	}
	auth, _ := json.Marshal(map[string]any{})
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), auth, 0600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestOllamaCollectGateNeedsUsableBinding(t *testing.T) {
	on := collect.Binding{Provider: "ollama-cloud", AccountID: "key:a", Kind: collect.KindKey,
		Token: "synthetic-ollama-key", Enabled: true}
	off := on
	off.AccountID = "key:b"
	off.Token = "synthetic-off"
	off.Enabled = false
	tokenless := on
	tokenless.AccountID = "key:c"
	tokenless.Token = ""
	other := collect.Binding{Provider: "openai", AccountID: "key:d", Kind: collect.KindOAuth,
		Token: "synthetic-openai", Enabled: true}
	if !ollamaCollectAllowed([]collect.Binding{on}) {
		t.Fatal("usable ollama binding must enable the balance poll")
	}
	if ollamaCollectAllowed([]collect.Binding{off}) || ollamaCollectAllowed([]collect.Binding{tokenless}) || ollamaCollectAllowed([]collect.Binding{other}) || ollamaCollectAllowed(nil) {
		t.Fatal("disabled, tokenless, or unrelated bindings must not enable the balance poll")
	}
}

func TestOllamaBalanceWindowsReachRuntime(t *testing.T) {
	clk := &clock.Var{T: time.Date(2026, 10, 7, 20, 0, 0, 0, time.UTC)}
	fake := &collect.Fake{HostResponses: map[string]transport.Response{
		"ollama.com": {Status: 200, Body: []byte(ollamaProbeFirst)},
	}}
	rt := New(clk, openProbeStore(t), fake)
	rt.Home = ollamaBalanceProbeHome(t, map[string]any{
		"ollama-cloud": map[string]any{"apiKey": "sk-synthetic-ollama"},
	})
	rt.Direct = []string{}
	rt.cycle(context.Background())

	if len(fake.Calls) != 1 || fake.Calls[0].Path != "/api/balance" {
		t.Fatalf("balance endpoint not polled: %+v", fake.Calls)
	}
	acc := findAccount(t, rt.Snapshot(), "ollama-cloud", "key:default")
	if acc.Status != "ok" || len(acc.Windows) != 2 {
		t.Fatalf("account %+v", acc)
	}
	sess := acc.Windows[0]
	if sess.ID != "five-hour" || sess.RemainingPercent == nil || math.Abs(*sess.RemainingPercent-76.9) > 1e-9 {
		t.Fatalf("session window %+v", sess)
	}
	if sess.ResetAt == nil || *sess.ResetAt != "2026-10-07T23:00:00Z" {
		t.Fatalf("session reset %v", sess.ResetAt)
	}
	week := acc.Windows[1]
	if week.ID != "weekly" || week.RemainingPercent == nil || math.Abs(*week.RemainingPercent-83.4) > 1e-9 {
		t.Fatalf("weekly window %+v", week)
	}

	fake.SetHost("ollama.com", transport.Response{Status: 200, Body: []byte(ollamaProbeSecond)}, nil)
	clk.Set(clk.Now().Add(6 * time.Minute))
	rt.cycle(context.Background())
	acc2 := findAccount(t, rt.Snapshot(), "ollama-cloud", "key:default")
	sess2 := acc2.Windows[0]
	if sess2.RemainingPercent == nil || math.Abs(*sess2.RemainingPercent-74.5) > 1e-9 {
		t.Fatalf("second session window %+v", sess2)
	}
	analytics, ok := sess2.Analytics.(map[string]any)
	if !ok {
		t.Fatalf("analytics %+v", sess2.Analytics)
	}
	periods, ok := analytics["consumptionPeriods"].(map[string]any)
	if !ok {
		t.Fatalf("consumption %v", analytics["consumptionPeriods"])
	}
	hour, ok := periods[calc.PeriodOneHour].(map[string]any)
	if !ok {
		t.Fatalf("one-hour period %v", periods)
	}
	d, _ := hour["deltaPp"].(*float64)
	if d == nil || math.Abs(*d-2.4) > 1e-6 {
		t.Fatalf("one-hour delta %v", hour["deltaPp"])
	}
	h, ok := acc2.Ollama.(map[string]any)
	if !ok {
		t.Fatalf("ollama payload %v", acc2.Ollama)
	}
	if n := h["observations"]; n != 2 {
		t.Fatalf("observations %v", n)
	}
	windows := h["windows"].([]map[string]any)
	models := windows[0]["models"].([]ollamaModel)
	if len(models) != 0 {
		t.Fatalf("fabricated model counters %+v", models)
	}
	if windows[0]["capacityApiUsd"] != nil {
		t.Fatalf("capacity %v", windows[0]["capacityApiUsd"])
	}
}

func TestOllamaBalanceUnusableCredentialStaysLocal(t *testing.T) {
	clk := &clock.Var{T: time.Date(2026, 10, 7, 20, 0, 0, 0, time.UTC)}
	fake := &collect.Fake{}
	rt := New(clk, openProbeStore(t), fake)
	rt.Direct = []string{}
	rt.Home = ollamaBalanceProbeHome(t, map[string]any{
		"ollama-cloud": map[string]any{"disabled": true, "apiKey": "sk-synthetic-ollama"},
	})
	rt.cycle(context.Background())
	if len(fake.Calls) != 0 {
		t.Fatalf("disabled credential sent %d requests", len(fake.Calls))
	}
	rt.Home = ollamaBalanceProbeHome(t, map[string]any{
		"ollama-cloud": map[string]any{},
	})
	rt.cycle(context.Background())
	if len(fake.Calls) != 0 {
		t.Fatalf("missing credential sent %d requests", len(fake.Calls))
	}
	rt.Home = ollamaBalanceProbeHome(t, map[string]any{})
	rt.cycle(context.Background())
	if len(fake.Calls) != 0 {
		t.Fatalf("no binding sent %d requests", len(fake.Calls))
	}
}
