package runtime

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/httpserver"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

const (
	openaiHost    = "chatgpt.com"
	anthropicHost = "api.anthropic.com"
	probeSecret   = "sk-test-openai-secret"
)

func TestProbeHealthyProviderSurvivesOtherOutage(t *testing.T) {
	clk := &clock.Var{T: time.Date(2027, 1, 15, 8, 0, 0, 0, time.UTC)}
	fake := &collect.Fake{}
	home := writeProbeHome(t, map[string]string{
		"openai":    probeSecret,
		"anthropic": "sk-test-anthropic-secret",
	})
	hist := openProbeStore(t)
	rt := New(clk, hist, fake)
	rt.Home = home
	rt.Direct = []string{"openai", "anthropic"}
	srv := startProbeHTTP(t, rt)

	// First cycle: OpenAI transport fails, Anthropic reports 40% used.
	fake.SetHost(openaiHost, transport.Response{}, errors.New("refused"))
	fake.SetHost(anthropicHost, transport.Response{Status: 200, Body: []byte(`{"five_hour":{"utilization":40}}`)}, nil)
	rt.cycle(context.Background())
	first := getProbeSnapshot(t, srv)
	assertIsolatedOutage(t, first, false)
	assertNoSecret(t, first)
	if n := countObservations(t, hist.DB()); n != 1 {
		t.Fatalf("first cycle observations=%d want 1 (anthropic only)", n)
	}
	if zeros := countZeroObservations(t, hist.DB()); zeros != 0 {
		t.Fatalf("first cycle stored %d zero-percent rows", zeros)
	}

	// Success for both on the next scheduled refresh, then OpenAI fails again.
	clk.Set(clk.Now().Add(2 * time.Minute))
	fake.SetHost(openaiHost, transport.Response{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":10,"limit_window_seconds":604800}}}`)}, nil)
	rt.cycle(context.Background())
	okSnap := getProbeSnapshot(t, srv)
	openaiOK := findAccount(t, okSnap, "openai", "key:default")
	if openaiOK.Status != "ok" || len(openaiOK.Windows) != 1 || openaiOK.Windows[0].RemainingPercent == nil || *openaiOK.Windows[0].RemainingPercent != 90 {
		t.Fatalf("openai success %+v", openaiOK)
	}
	if n := countObservations(t, hist.DB()); n != 3 {
		t.Fatalf("after success observations=%d want 3", n)
	}

	clk.Set(clk.Now().Add(2 * time.Minute))
	fake.SetHost(openaiHost, transport.Response{}, errors.New("refused"))
	rt.cycle(context.Background())
	after := getProbeSnapshot(t, srv)
	assertIsolatedOutage(t, after, true)
	openai := findAccount(t, after, "openai", "key:default")
	if openai.Windows[0].Stale == nil || !*openai.Windows[0].Stale {
		t.Fatal("last-good openai window must be stale")
	}
	if openai.UpdatedAt == nil || *openai.UpdatedAt == "" {
		t.Fatal("last-good observation time must stay")
	}
	if n := countObservations(t, hist.DB()); n != 4 {
		t.Fatalf("after fail observations=%d want 4 (anthropic again, no openai 0)", n)
	}
	if zeros := countZeroObservations(t, hist.DB()); zeros != 0 {
		t.Fatalf("stored %d zero-percent rows after later fail", zeros)
	}

	clk.Set(clk.Now().Add(time.Hour))
	later := getProbeSnapshot(t, srv)
	openaiLater := findAccount(t, later, "openai", "key:default")
	if openaiLater.UpdatedAt == nil || *openaiLater.UpdatedAt != *openai.UpdatedAt {
		t.Fatalf("original observation time drifted %v → %v", openai.UpdatedAt, openaiLater.UpdatedAt)
	}
	if openaiLater.Windows[0].Stale == nil || !*openaiLater.Windows[0].Stale {
		t.Fatal("stale must remain as time passes")
	}
}

func TestProbeUnknownIsNotStoredAsZero(t *testing.T) {
	cases := []struct {
		name   string
		host   func(*collect.Fake)
		direct []string
		want   int
		zeros  int
	}{
		{
			name: "transport-error",
			host: func(f *collect.Fake) {
				f.SetHost(openaiHost, transport.Response{}, errors.New("refused"))
			},
			direct: []string{"openai"},
		},
		{
			name: "429",
			host: func(f *collect.Fake) {
				f.SetHost(openaiHost, transport.Response{Status: 429, Headers: http.Header{"Retry-After": []string{"120"}}}, nil)
			},
			direct: []string{"openai"},
		},
		{
			name: "403",
			host: func(f *collect.Fake) {
				f.SetHost(openaiHost, transport.Response{Status: 403}, nil)
			},
			direct: []string{"openai"},
		},
		{
			name: "invalid-json",
			host: func(f *collect.Fake) {
				f.SetHost(openaiHost, transport.Response{Status: 200, Body: []byte(`not-json`)}, nil)
			},
			direct: []string{"openai"},
		},
		{
			name: "empty-success",
			host: func(f *collect.Fake) {
				f.SetHost(openaiHost, transport.Response{Status: 200, Body: []byte(`{}`)}, nil)
			},
			direct: []string{"openai"},
		},
		{
			name:   "unobserved",
			host:   func(*collect.Fake) {},
			direct: nil,
		},
		{
			name: "measured-zero",
			host: func(f *collect.Fake) {
				f.SetHost(openaiHost, transport.Response{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":0,"limit_window_seconds":604800}}}`)}, nil)
			},
			direct: []string{"openai"},
			want:   1,
			zeros:  1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clk := &clock.Var{T: time.Date(2027, 1, 15, 8, 0, 0, 0, time.UTC)}
			fake := &collect.Fake{}
			tc.host(fake)
			hist := openProbeStore(t)
			rt := New(clk, hist, fake)
			rt.Home = writeProbeHome(t, map[string]string{"openai": probeSecret})
			rt.Direct = tc.direct
			srv := startProbeHTTP(t, rt)
			rt.cycle(context.Background())
			snap := getProbeSnapshot(t, srv)
			assertNoSecret(t, snap)
			if snap.SchemaVersion != 1 {
				t.Fatalf("schema %d", snap.SchemaVersion)
			}
			got := countObservations(t, hist.DB())
			zeros := countZeroObservations(t, hist.DB())
			if got != tc.want {
				t.Fatalf("observations=%d want %d", got, tc.want)
			}
			if zeros != tc.zeros {
				t.Fatalf("zero-percent rows=%d want %d", zeros, tc.zeros)
			}
			if tc.want == 1 {
				openai := findAccount(t, snap, "openai", "key:default")
				if openai.Windows[0].RemainingPercent == nil || *openai.Windows[0].RemainingPercent != 100 {
					t.Fatalf("measured 0 used must publish 100 remaining, %+v", openai)
				}
			}
		})
	}
}

func writeProbeHome(t *testing.T, keys map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	providers := map[string]any{}
	auth := map[string]any{}
	config := map[string]any{"providers": providers}
	for id, key := range keys {
		providers[id] = map[string]any{}
		if id == "openai" {
			config["codexAccounts"] = []any{map[string]any{"id": "key:default"}}
			creds, _ := json.Marshal(map[string]any{"key:default": map[string]any{"credential": map[string]any{"accessToken": key, "chatgptAccountId": "account"}}})
			if err := os.WriteFile(filepath.Join(dir, "codex-accounts.json"), creds, 0600); err != nil {
				t.Fatal(err)
			}
		} else {
			auth[id] = map[string]any{"accounts": []any{map[string]any{"id": "key:default", "credential": map[string]any{"access": key, "accountId": "account"}}}}
		}
	}
	raw, _ := json.Marshal(config)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(auth)
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func openProbeStore(t *testing.T) *store.History {
	t.Helper()
	h, err := store.Open(t.TempDir(), store.OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

func startProbeHTTP(t *testing.T, rt *Runtime) *httpserver.Server {
	t.Helper()
	var last error
	for port := 19100; port < 19140; port++ {
		s, err := httpserver.New(httpserver.Options{Host: "127.0.0.1", Port: port, Snapshot: rt.Snapshot})
		if err != nil {
			last = err
			continue
		}
		if err := s.Listen(); err != nil {
			last = err
			_ = s.Close()
			continue
		}
		t.Cleanup(func() { _ = s.Close() })
		return s
	}
	t.Fatalf("listen: %v", last)
	return nil
}

func getProbeSnapshot(t *testing.T, s *httpserver.Server) contract.Snapshot {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, "http://"+s.Addr()+"/api/v1/snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = s.Addr()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("snapshot %d %s", res.StatusCode, body)
	}
	var snap contract.Snapshot
	if err := json.NewDecoder(res.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	return snap
}

func assertIsolatedOutage(t *testing.T, snap contract.Snapshot, openaiHasLastGood bool) {
	t.Helper()
	if snap.SchemaVersion != 1 {
		t.Fatalf("schema %d", snap.SchemaVersion)
	}
	anthropic := findAccount(t, snap, "anthropic", "key:default")
	if anthropic.Status != "ok" || len(anthropic.Windows) != 1 {
		t.Fatalf("anthropic %+v", anthropic)
	}
	if anthropic.Windows[0].ID != "five-hour" || anthropic.Windows[0].RemainingPercent == nil || *anthropic.Windows[0].RemainingPercent != 60 {
		t.Fatalf("anthropic remaining %+v", anthropic.Windows[0])
	}
	if anthropic.Windows[0].Stale != nil && *anthropic.Windows[0].Stale {
		t.Fatal("healthy anthropic must not be stale")
	}
	openai := findAccount(t, snap, "openai", "key:default")
	if openaiHasLastGood {
		if openai.Status != "stale" || len(openai.Windows) != 1 || openai.Windows[0].RemainingPercent == nil || *openai.Windows[0].RemainingPercent != 90 {
			t.Fatalf("openai last-good %+v", openai)
		}
		return
	}
	if openai.Status != "stale" && openai.Status != "unavailable" {
		t.Fatalf("openai first fail status %s", openai.Status)
	}
	for _, w := range openai.Windows {
		if w.RemainingPercent != nil && *w.RemainingPercent == 100 && (w.Stale == nil || !*w.Stale) {
			t.Fatalf("unknown openai must not look like a measured 0%% %+v", w)
		}
		if w.ID == "" {
			t.Fatal("empty window id leaked into snapshot")
		}
	}
}

func findAccount(t *testing.T, snap contract.Snapshot, provider, account string) contract.Account {
	t.Helper()
	for _, p := range snap.Providers {
		if p.ID != provider {
			continue
		}
		for _, a := range p.Accounts {
			if a.ID == account {
				return a
			}
		}
	}
	t.Fatalf("missing %s/%s in %+v", provider, account, snap.Providers)
	return contract.Account{}
}

func countObservations(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM quota_observations").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func countZeroObservations(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM quota_observations WHERE observedPercent=0").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func assertNoSecret(t *testing.T, snap contract.Snapshot) {
	t.Helper()
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(probeSecret)) || bytes.Contains(raw, []byte("sk-test-anthropic-secret")) {
		t.Fatal("secret leaked into public snapshot")
	}
}

func TestProbeCooldownDoesNotCreateObservations(t *testing.T) {
	clk := &clock.Var{T: time.Date(2027, 1, 15, 8, 0, 0, 0, time.UTC)}
	f := &collect.Fake{}
	f.SetHost(anthropicHost, transport.Response{Status: 200, Body: []byte(`{"five_hour":{"utilization":40}}`)}, nil)
	hist := openProbeStore(t)
	rt := New(clk, hist, f)
	rt.Home = writeProbeHome(t, map[string]string{"anthropic": "synthetic-token"})
	rt.Direct = []string{"anthropic"}
	rt.cycle(context.Background())
	for i := 0; i < 11; i++ {
		clk.Set(clk.Now().Add(10 * time.Second))
		rt.cycle(context.Background())
	}
	if f.CallCount() != 1 || countObservations(t, hist.DB()) != 1 {
		t.Fatalf("cooldown duplicated requests or observations: %d/%d", f.CallCount(), countObservations(t, hist.DB()))
	}
	clk.Set(clk.Now().Add(10 * time.Second))
	rt.cycle(context.Background())
	if f.CallCount() != 2 || countObservations(t, hist.DB()) != 2 {
		t.Fatal("scheduled collection did not resume")
	}
}
