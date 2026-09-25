package collect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
)

const fixtureNowMS = int64(1800000000000)

func writeSnapshotFixture(t *testing.T) (home, native string) {
	t.Helper()
	home = t.TempDir()
	native = filepath.Join(home, "native")
	if err := os.Mkdir(native, 0o700); err != nil {
		t.Fatal(err)
	}
	sum := sha256.New()
	sum.Write([]byte("opencodex-main-quota-v1\x00physical"))
	hash := hex.EncodeToString(sum.Sum(nil))
	now := fixtureNowMS
	files := map[string]any{
		"auth.json": map[string]any{
			"anthropic": map[string]any{
				"activeAccountId": "a1",
				"accounts": []any{
					map[string]any{"id": "a1", "credential": map[string]any{"access": "SECRET_SENTINEL", "email": "person@example.com"}},
					map[string]any{"id": "a2", "credential": map[string]any{"access": "SECRET_SENTINEL"}},
				},
			},
		},
		"codex-accounts.json": map[string]any{
			"pool1":   map[string]any{"credential": map[string]any{"accessToken": "SECRET_SENTINEL"}},
			"deleted": map[string]any{"deletedAt": now},
		},
		"codex-quota-cache.json": map[string]any{
			"version": 1,
			"quotas": map[string]any{
				"pool1":   map[string]any{"updatedAt": now, "weeklyPercent": 80, "weeklyResetAt": float64(now)/1000 + 3600},
				"deleted": map[string]any{"weeklyPercent": 10},
			},
			"mainPolicyQuota": map[string]any{
				"identityKey": hash,
				"quota":       map[string]any{"updatedAt": now, "weeklyPercent": 0},
			},
		},
		"provider-account-quota-cache.json": map[string]any{
			"version": 1,
			"rows": map[string]any{
				"anthropic\x00a1": map[string]any{"updatedAt": now, "fiveHourPercent": 100, "fiveHourResetAt": now + 3600000},
				"anthropic\x00a2": map[string]any{"updatedAt": now - 7*3600000, "weeklyPercent": 23},
			},
		},
	}
	config := `{"providers":{"openai":{},"anthropic":{},"ollama-cloud":{"apiKey":"SECRET_SENTINEL","apiKeyPool":[{"id":"k1","key":"SECRET_SENTINEL"}]}},"codexAccounts":[{"id":"pool1","email":"someone@example.com","plan":"pro"}],"activeCodexAccountId":"pool1"}`
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, value := range files {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, name), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(native, "auth.json"), []byte(`{"tokens":{"account_id":"physical","access_token":"SECRET_SENTINEL"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return home, native
}

func loadFixture(t *testing.T) Local {
	t.Helper()
	home, native := writeSnapshotFixture(t)
	now := time.UnixMilli(fixtureNowMS).UTC()
	local, err := (Reader{Home: home, CodexHome: native}).LoadLocal(now)
	if err != nil {
		t.Fatal(err)
	}
	return local
}

func TestLocalSnapshotFixtureMatchesIndependentValues(t *testing.T) {
	local := loadFixture(t)
	if len(local.Providers) != 3 {
		t.Fatalf("providers %d %+v", len(local.Providers), providerIDs(local))
	}
	openai, anthropic, ollama := local.Providers[0], local.Providers[1], local.Providers[2]
	if openai.ID != "openai" || anthropic.ID != "anthropic" || ollama.ID != "ollama-cloud" {
		t.Fatalf("order %+v", providerIDs(local))
	}
	if len(openai.Accounts) != 2 {
		t.Fatalf("openai accounts %+v", openai.Accounts)
	}
	if openai.Accounts[0].ID != "__main__" || len(openai.Accounts[0].Windows) == 0 || openai.Accounts[0].Windows[0].RemainingPercent == nil || *openai.Accounts[0].Windows[0].RemainingPercent != 100 {
		t.Fatalf("main %+v", openai.Accounts[0])
	}
	if openai.Accounts[1].ID != "pool1" || openai.Accounts[1].Windows[0].RemainingPercent == nil || *openai.Accounts[1].Windows[0].RemainingPercent != 20 {
		t.Fatalf("pool %+v", openai.Accounts[1])
	}
	if openai.Accounts[1].Active == nil || !*openai.Accounts[1].Active {
		t.Fatal("pool1 must be active")
	}
	if openai.Accounts[1].Windows[0].ResetAt == nil || *openai.Accounts[1].Windows[0].ResetAt != "2027-01-15T09:00:00.000Z" {
		t.Fatalf("pool reset %v", openai.Accounts[1].Windows[0].ResetAt)
	}
	if anthropic.Accounts[0].Windows[0].ResetAt == nil || *anthropic.Accounts[0].Windows[0].ResetAt != "2027-01-15T09:00:00.000Z" {
		t.Fatalf("claude reset %v", anthropic.Accounts[0].Windows[0].ResetAt)
	}
	if anthropic.Accounts[0].Windows[0].RemainingPercent == nil || *anthropic.Accounts[0].Windows[0].RemainingPercent != 0 {
		t.Fatalf("claude remaining %+v", anthropic.Accounts[0])
	}
	if anthropic.Accounts[1].Status != "stale" {
		t.Fatalf("a2 %s", anthropic.Accounts[1].Status)
	}
	if len(ollama.Accounts) != 1 || ollama.Accounts[0].Status != "unavailable" {
		t.Fatalf("ollama %+v", ollama.Accounts)
	}
	raw, _ := json.Marshal(local.Providers)
	if containsStr(string(raw), "SECRET_SENTINEL") || containsStr(string(raw), "someone@example.com") {
		t.Fatalf("secret leaked %s", raw)
	}
}

func TestMainIdentityMismatchNeverReadsAliasCache(t *testing.T) {
	home, native := writeSnapshotFixture(t)
	q := readJSON(t, filepath.Join(home, "codex-quota-cache.json"))
	mp, _ := q["mainPolicyQuota"].(map[string]any)
	mp["identityKey"] = "wrong"
	quotas, _ := q["quotas"].(map[string]any)
	quotas["__main__"] = map[string]any{"updatedAt": fixtureNowMS, "weeklyPercent": 77}
	writeJSON(t, filepath.Join(home, "codex-quota-cache.json"), q)
	local, err := (Reader{Home: home, CodexHome: native}).LoadLocal(time.UnixMilli(fixtureNowMS).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if local.Providers[0].Accounts[0].Status != "unavailable" {
		t.Fatalf("%+v", local.Providers[0].Accounts[0])
	}
}

func TestMissingPoolCredentialsAreReauth(t *testing.T) {
	home, native := writeSnapshotFixture(t)
	writeJSON(t, filepath.Join(home, "codex-accounts.json"), map[string]any{})
	local, err := (Reader{Home: home, CodexHome: native}).LoadLocal(time.UnixMilli(fixtureNowMS).UTC())
	if err != nil {
		t.Fatal(err)
	}
	pool := local.Providers[0].Accounts[1]
	if pool.Status != "reauth" || len(pool.Windows) != 0 {
		t.Fatalf("%+v", pool)
	}
}

func TestNativeOnlyRosterWithoutConfig(t *testing.T) {
	home, native := writeSnapshotFixture(t)
	if err := os.Remove(filepath.Join(home, "config.json")); err != nil {
		t.Fatal(err)
	}
	local, err := (Reader{Home: home, CodexHome: native}).LoadLocal(time.UnixMilli(fixtureNowMS).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if local.Files["ocxConfig"] != FileMissing {
		t.Fatalf("%s", local.Files["ocxConfig"])
	}
	var openai *struct{ ID string }
	_ = openai
	found := false
	for _, p := range local.Providers {
		if p.ID == "openai" {
			found = true
			if got := []string{p.Accounts[0].ID, p.Accounts[1].ID}; got[0] != "__main__" || got[1] != "pool1" {
				if len(p.Accounts) != 2 {
					t.Fatalf("accounts %+v", p.Accounts)
				}
			}
		}
	}
	if !found {
		t.Fatal("openai missing")
	}
}

func TestMergeDirectDoesNotDuplicateWindows(t *testing.T) {
	now := time.UnixMilli(fixtureNowMS).UTC()
	remain := 20.0
	stale := false
	iso := now.Format(time.RFC3339Nano)
	base := []contract.Provider{{
		ID: "openai", Name: "OpenAI", Enabled: true,
		Accounts: []contract.Account{{
			ID: "pool1", Label: "pool", Status: "ok", UpdatedAt: &iso,
			Windows: []contract.Window{{ID: "weekly", Label: "주간", RemainingPercent: &remain, Stale: &stale}},
		}},
	}}
	used := 80.0
	rows := []Reading{{
		Provider: "openai", Account: "pool1", WindowID: "weekly", Label: "주간",
		UsedPercent: &used, RemainingPercent: &remain, Kind: WindowOK, ObservedAt: fixtureNowMS,
	}}
	out := MergeDirect(base, rows, now)
	if len(out) != 1 || len(out[0].Accounts) != 1 || len(out[0].Accounts[0].Windows) != 1 {
		t.Fatalf("duplicated %+v", out)
	}
	if out[0].Accounts[0].Windows[0].ID != "weekly" {
		t.Fatalf("%+v", out[0].Accounts[0].Windows)
	}
}

func TestDisabledProviderStaysOnRoster(t *testing.T) {
	home, native := writeSnapshotFixture(t)
	cfg := readJSON(t, filepath.Join(home, "config.json"))
	providers, _ := cfg["providers"].(map[string]any)
	anth, _ := providers["anthropic"].(map[string]any)
	anth["disabled"] = true
	providers["anthropic"] = anth
	writeJSON(t, filepath.Join(home, "config.json"), cfg)
	local, err := (Reader{Home: home, CodexHome: native}).LoadLocal(time.UnixMilli(fixtureNowMS).UTC())
	if err != nil {
		t.Fatal(err)
	}
	var anthP bool
	for _, p := range local.Providers {
		if p.ID == "anthropic" {
			anthP = true
			if p.Enabled {
				t.Fatal("disabled provider must stay listed and not enabled")
			}
			if len(p.Accounts) == 0 {
				t.Fatal("disabled must keep roster")
			}
		}
	}
	if !anthP {
		t.Fatal("disabled anthropic dropped")
	}
}

func TestProviderDisableBlocksEveryCredentialSource(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("disabled=%t", disabled), func(t *testing.T) {
			home, native := writeSnapshotFixture(t)
			cfg := readJSON(t, filepath.Join(home, "config.json"))
			providers := cfg["providers"].(map[string]any)
			for _, id := range []string{"openai", "anthropic", "ollama-cloud"} {
				p := providers[id].(map[string]any)
				p["disabled"] = disabled
				p["apiKey"] = "SYNTHETIC_KEY"
				p["apiKeyPool"] = []any{map[string]any{"id": "pool-key", "key": "SYNTHETIC_POOL"}}
			}
			writeJSON(t, filepath.Join(home, "config.json"), cfg)
			writeJSON(t, filepath.Join(native, ".credentials.json"), map[string]any{
				"claudeAiOauth": map[string]any{"accessToken": "SYNTHETIC_NATIVE"},
			})
			now := time.UnixMilli(fixtureNowMS).UTC()
			local, err := (Reader{Home: home, CodexHome: native, ClaudeHome: native}).LoadLocal(now)
			if err != nil {
				t.Fatal(err)
			}
			seen := map[string]bool{}
			for _, b := range local.Bindings {
				seen[b.Source] = true
				if b.Enabled == disabled {
					t.Errorf("%s/%s source %s enabled=%t", b.Provider, b.AccountID, b.Source, b.Enabled)
				}
			}
			for _, source := range []string{"codexAuth", "claudeCredentials", "ocxConfig", "ocxAuth", "ocxCodexAccounts"} {
				if !seen[source] {
					t.Errorf("fixture failed to exercise %s: %+v", source, seen)
				}
			}
			if len(local.Providers) != 3 {
				t.Fatalf("roster lost: %d", len(local.Providers))
			}
			for _, p := range local.Providers {
				if p.Enabled == disabled || len(p.Accounts) == 0 {
					t.Errorf("roster state %s", p.ID)
				}
			}
			fake := &Fake{}
			NewScheduler(clock.Fixed{T: now}, fake).Collect(context.Background(), local.Bindings, []string{"openai", "anthropic", "ollama-cloud"})
			if disabled && len(fake.Calls) != 0 {
				t.Errorf("disabled credentials sent in %d external requests", len(fake.Calls))
			}
			if !disabled && len(fake.Calls) == 0 {
				t.Fatal("enabled control made no request")
			}
		})
	}
}

func providerIDs(local Local) []string {
	out := make([]string, len(local.Providers))
	for i, p := range local.Providers {
		out[i] = p.ID
	}
	return out
}

func containsStr(s, n string) bool {
	return len(n) > 0 && (s == n || len(s) >= len(n) && (func() bool {
		for i := 0; i+len(n) <= len(s); i++ {
			if s[i:i+len(n)] == n {
				return true
			}
		}
		return false
	})())
}

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatal(err)
	}
	return obj
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestDisabledProviderAliasesMakeNoRequests(t *testing.T) {
	for _, alias := range []string{"chatgpt", "openai-multi"} {
		t.Run(alias, func(t *testing.T) {
			home := t.TempDir()
			writeJSON(t, filepath.Join(home, "config.json"), map[string]any{"providers": map[string]any{alias: map[string]any{"disabled": true}, "openai": map[string]any{"apiKey": "SYNTHETIC_ENABLED"}}})
			writeJSON(t, filepath.Join(home, "auth.json"), map[string]any{alias: map[string]any{"accounts": []any{map[string]any{"id": "alias-account", "credential": map[string]any{"access": "SYNTHETIC_DISABLED"}}}}})
			now := time.UnixMilli(fixtureNowMS)
			local, err := (Reader{Home: home}).LoadLocal(now)
			if err != nil {
				t.Fatal(err)
			}
			seen := false
			for _, b := range local.Bindings {
				if b.AccountID == "alias-account" {
					seen = true
					if b.Enabled {
						t.Error("disabled alias enabled after normalization")
					}
				}
			}
			if !seen {
				t.Fatal("alias binding not exercised")
			}
			fake := &Fake{}
			NewScheduler(clock.Fixed{T: now}, fake).Collect(context.Background(), local.Bindings, []string{"openai"})
			if len(fake.Calls) != 0 {
				t.Fatalf("disabled alias and API key must not call OAuth quota, got %d", len(fake.Calls))
			}
		})
	}
}

func TestAliasPreservesRelayBaseAndDisabled(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		home := t.TempDir()
		config := fmt.Sprintf(`{"providers":{"chatgpt":{"baseUrl":"https://relay.example/v1","disabled":%t}}}`, disabled)
		if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(config), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"chatgpt":{"accounts":[{"id":"a","credential":{"access":"synthetic","accountId":"physical"}}]}}`), 0600); err != nil {
			t.Fatal(err)
		}
		local, err := (Reader{Home: home}).LoadLocal(time.UnixMilli(fixtureNowMS))
		if err != nil {
			t.Fatal(err)
		}
		if len(local.Bindings) != 1 || local.Bindings[0].BaseURL != "https://relay.example/v1" || local.Bindings[0].Enabled == disabled {
			t.Fatal("alias lost original configuration")
		}
		f := &Fake{}
		NewScheduler(clock.System{}, f).Collect(context.Background(), local.Bindings, []string{"openai"})
		if f.CallCount() != 0 {
			t.Fatal("relay token sent to canonical provider")
		}
	}
}

func TestHiddenDirectWindowRemovesCachedProjection(t *testing.T) {
	remain := float64(80)
	now := time.UnixMilli(fixtureNowMS)
	base := []contract.Provider{{ID: "devin", Accounts: []contract.Account{{ID: "a", Status: "ok", Windows: []contract.Window{{ID: "short", RemainingPercent: &remain}, {ID: "weekly", RemainingPercent: &remain}}}}}}
	rows := []Reading{{Provider: "devin", Account: "a", WindowID: "short", Hidden: true, Kind: WindowOK, ObservedAt: fixtureNowMS}, {Provider: "devin", Account: "a", WindowID: "weekly", RemainingPercent: &remain, Kind: WindowOK, ObservedAt: fixtureNowMS}}
	out := MergeDirect(base, rows, now)
	if len(out[0].Accounts[0].Windows) != 1 || out[0].Accounts[0].Windows[0].ID != "weekly" {
		t.Fatal("hidden daily limit survived")
	}
	if len(base[0].Accounts[0].Windows) != 2 {
		t.Fatal("mutated input cache")
	}
}
