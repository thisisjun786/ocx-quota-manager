package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func TestProbeRosterWithoutDirectMakesNoNetwork(t *testing.T) {
	home, native := writeRuntimeFixture(t)
	fake := &collect.Fake{}
	clk := &clock.Var{T: time.UnixMilli(1800000000000).UTC()}
	hist, err := store.Open(t.TempDir(), store.OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = hist.Close() })
	rt := New(clk, hist, fake)
	rt.Home = home
	rt.CodexHome = native
	rt.Direct = nil
	srv := startProbeHTTP(t, rt)
	rt.cycle(context.Background())
	if len(fake.Calls) != 0 {
		t.Fatalf("direct disabled must not call transport, calls=%d", len(fake.Calls))
	}
	snap := getProbeSnapshot(t, srv)
	if snap.SchemaVersion != 1 || len(snap.Providers) != 3 {
		t.Fatalf("providers %d %+v", len(snap.Providers), snap.Providers)
	}
	raw, _ := json.Marshal(snap)
	if bytes.Contains(raw, []byte("SECRET_SENTINEL")) || bytes.Contains(raw, []byte("someone@example.com")) {
		t.Fatal("secret leaked")
	}
	openai := findAccount(t, snap, "openai", "__main__")
	if openai.Windows[0].RemainingPercent == nil || *openai.Windows[0].RemainingPercent != 100 {
		t.Fatalf("main %+v", openai)
	}
	pool := findAccount(t, snap, "openai", "pool1")
	if pool.Windows[0].RemainingPercent == nil || *pool.Windows[0].RemainingPercent != 20 {
		t.Fatalf("pool %+v", pool)
	}
	claude := findAccount(t, snap, "anthropic", "a1")
	if claude.Windows[0].RemainingPercent == nil || *claude.Windows[0].RemainingPercent != 0 {
		t.Fatalf("claude %+v", claude)
	}
	if n := countObservations(t, hist.DB()); n != 0 {
		t.Fatalf("cache-only cycle stored %d observations", n)
	}
}

func writeRuntimeFixture(t *testing.T) (home, native string) {
	t.Helper()
	home = t.TempDir()
	native = filepath.Join(home, "native")
	if err := os.Mkdir(native, 0o700); err != nil {
		t.Fatal(err)
	}
	now := int64(1800000000000)
	config := `{"providers":{"openai":{},"anthropic":{},"ollama-cloud":{"apiKey":"SECRET_SENTINEL","apiKeyPool":[{"id":"k1","key":"SECRET_SENTINEL"}]}},"codexAccounts":[{"id":"pool1","email":"someone@example.com","plan":"pro"}],"activeCodexAccountId":"pool1"}`
	mustWrite(t, filepath.Join(home, "config.json"), config)
	mustWrite(t, filepath.Join(home, "auth.json"), `{"anthropic":{"activeAccountId":"a1","accounts":[{"id":"a1","credential":{"access":"SECRET_SENTINEL","email":"person@example.com"}},{"id":"a2","credential":{"access":"SECRET_SENTINEL"}}]}}`)
	mustWrite(t, filepath.Join(home, "codex-accounts.json"), `{"pool1":{"credential":{"accessToken":"SECRET_SENTINEL"}},"deleted":{"deletedAt":1800000000000}}`)
	sum := sha256Hex("opencodex-main-quota-v1\x00physical")
	mustWrite(t, filepath.Join(home, "codex-quota-cache.json"), `{
		"version":1,
		"quotas":{"pool1":{"updatedAt":1800000000000,"weeklyPercent":80,"weeklyResetAt":1800003600},"deleted":{"weeklyPercent":10}},
		"mainPolicyQuota":{"identityKey":"`+sum+`","quota":{"updatedAt":1800000000000,"weeklyPercent":0}}
	}`)
	mustWrite(t, filepath.Join(home, "provider-account-quota-cache.json"), `{
		"version":1,
		"rows":{"anthropic\u0000a1":{"updatedAt":1800000000000,"fiveHourPercent":100,"fiveHourResetAt":1800003600000},"anthropic\u0000a2":{"updatedAt":`+strconv.FormatInt(now-7*3600000, 10)+`,"weeklyPercent":23}}
	}`)
	mustWrite(t, filepath.Join(native, "auth.json"), `{"tokens":{"account_id":"physical","access_token":"SECRET_SENTINEL"}}`)
	return home, native
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
