package runtime

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

func TestClaudeDuplicateHistoryExcludedFromSnapshot(t *testing.T) {
	// Given two logins for one UUID and overlapping historical observations.
	now := time.UnixMilli(1_800_000_000_000).UTC()
	home := t.TempDir()
	native := filepath.Join(home, ".claude")
	if err := os.Mkdir(native, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"config.json":               `{"providers":{"anthropic":{}}}`,
		"auth.json":                 `{"anthropic":{"accounts":[{"id":"ocx-account","credential":{"access":"OCX_TOKEN","accountId":"physical"}}]}}`,
		".claude.json":              `{"oauthAccount":{"accountUuid":"physical"}}`,
		".claude/.credentials.json": `{"claudeAiOauth":{"accessToken":"NATIVE_TOKEN"}}`,
	} {
		if err := os.WriteFile(filepath.Join(home, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	hist := openProbeStore(t)
	reset := now.Add(24 * time.Hour).UnixMilli()
	for _, account := range []string{"ocx-account", "claude-native"} {
		if _, err := hist.EpochForIdentity("anthropic", account, "credential_account_id", repairPtr(sha256Hex("qm-epoch-v1\x00physical")), now.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		for i, used := range []float64{10, 20} {
			if err := hist.InsertObservation(store.Observation{
				Provider: "anthropic", Account: account, Window: "weekly",
				At: now.Add(time.Duration(i-1) * 10 * time.Minute).UnixMilli(), Reset: &reset,
				Basis: "ok", ObservedPercent: used, Epoch: repairPtr(int64(1)),
				LimitState: "missing", WindowSemantics: "fixed_reset", Source: repairPtr("test"),
				SourceVersion: repairPtr("1"), Method: repairPtr("reported_percent"), ScopeKey: repairPtr("all"),
				Unit: repairPtr("percent"), PrecisionEvidence: "unknown", Reconciliation: "unverified", UsedAccumulation: "unknown",
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	fake := &collect.Fake{}
	fake.SetHost("api.anthropic.com", transport.Response{Status: 200, Body: []byte(`{"seven_day":{"utilization":20,"resets_at":"2027-01-16T08:00:00Z"}}`)}, nil)
	rt := New(clock.Fixed{T: now}, hist, fake)
	rt.Home, rt.ClaudeHome, rt.Direct = home, native, []string{"anthropic"}
	srv := startProbeHTTP(t, rt)

	// When a collection cycle is read through the actual snapshot endpoint.
	rt.cycle(context.Background())
	snap := getProbeSnapshot(t, srv)

	// Then one account and one 10pp rise are counted, without deleting history.
	if len(fake.Calls) != 1 || len(snap.Providers) != 1 || len(snap.Providers[0].Accounts) != 1 {
		t.Fatalf("calls=%d providers=%+v", len(fake.Calls), snap.Providers)
	}
	p := snap.Providers[0]
	if p.Accounts[0].ID != "ocx-account" {
		t.Fatalf("canonical ID = %s", p.Accounts[0].ID)
	}
	analytics := repairMap(t, p.Analytics)
	consumption := repairMap(t, repairMap(t, analytics["quotaConsumption"])["oneHour"])
	if consumption["accounts"] != float64(1) || consumption["deltaPp"] != float64(10) {
		t.Fatalf("consumption = %+v", consumption)
	}
	series := repairMap(t, analytics["quotaSeries"])
	if labels := repairMap(t, series["accounts"]); len(labels) != 1 || labels["ocx-account"] == nil {
		t.Fatalf("series accounts = %+v", labels)
	}
	observations, err := hist.ListObservations()
	if err != nil {
		t.Fatal(err)
	}
	nativeRows := 0
	for _, row := range observations {
		if row.Account == "claude-native" {
			nativeRows++
		}
	}
	if nativeRows != 2 {
		t.Fatalf("stored native history changed: %d", nativeRows)
	}
}
