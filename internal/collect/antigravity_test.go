package collect

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

// The shape retrieveUserQuotaSummary returned for a real account (values
// rounded): Gemini in use, Claude and GPT untouched.
const antigravitySummary = `{
  "groups": [
    {"buckets": [
      {"bucketId": "gemini-weekly", "displayName": "Weekly Limit Remaining", "window": "weekly",
       "resetTime": "2026-10-21T05:47:03Z", "remainingFraction": 0.85},
      {"bucketId": "gemini-5h", "displayName": "Five Hour Limit Remaining", "window": "5h",
       "resetTime": "2026-10-14T15:47:03Z", "remainingFraction": 0.8625}
     ], "displayName": "Gemini Models", "description": "Models within this group: Gemini Flash, Gemini Pro"},
    {"buckets": [
      {"bucketId": "3p-weekly", "displayName": "Weekly Limit Remaining", "window": "weekly",
       "resetTime": "2026-10-21T11:39:16Z", "remainingFraction": 1},
      {"bucketId": "3p-5h", "displayName": "Five Hour Limit Remaining", "window": "5h",
       "resetTime": "2026-10-14T16:39:16Z", "remainingFraction": 1}
     ], "displayName": "Claude and GPT models"}
  ],
  "description": "Within each group, models share a weekly limit and a 5-hour limit."
}`

func TestParseAntigravityKeepsFourGroupWindows(t *testing.T) {
	now := int64(1792000000000)
	rows, err := parseAntigravity([]byte(antigravitySummary), now)
	if err != nil || len(rows) != 4 {
		t.Fatalf("%v %+v", err, rows)
	}
	want := []struct {
		id, scope, label string
		used             float64
		reset            string
	}{
		{"gemini-five-hour", "gemini", "Gemini Models 5시간", 13.75, "2026-10-14T15:47:03Z"},
		{"gemini-weekly", "gemini", "Gemini Models 주간", 15, "2026-10-21T05:47:03Z"},
		{"3p-five-hour", "3p", "Claude and GPT models 5시간", 0, ""},
		{"3p-weekly", "3p", "Claude and GPT models 주간", 0, ""},
	}
	for i, w := range want {
		r := rows[i]
		if r.Provider != "antigravity" || r.Endpoint != "quota-summary" || r.WindowID != w.id || r.Scope != w.scope || r.Label != w.label || r.Kind != WindowOK || r.ObservedAt != now {
			t.Fatalf("row %d: %+v", i, r)
		}
		if r.UsedPercent == nil || r.RemainingPercent == nil || abs(*r.UsedPercent-w.used) > 1e-9 || abs(*r.RemainingPercent-(100-w.used)) > 1e-9 {
			t.Fatalf("row %d percent: %+v", i, r)
		}
		if w.reset == "" {
			// An untouched bucket's reset moves with every read.
			if r.ResetAt != nil {
				t.Fatalf("row %d: rolling reset kept %d", i, *r.ResetAt)
			}
			continue
		}
		at, _ := time.Parse(time.RFC3339, w.reset)
		if r.ResetAt == nil || *r.ResetAt != at.UnixMilli() {
			t.Fatalf("row %d reset: %+v", i, r.ResetAt)
		}
	}
}

func TestParseAntigravityShapes(t *testing.T) {
	now := int64(1792000000000)
	rows, _ := parseAntigravity([]byte(`{"buckets":[
		{"bucketId":"gemini-5h","window":"5h","remainingFraction":0,"resetTime":"2026-10-14T15:47:03Z"},
		{"bucketId":"gemini-daily","window":"daily","remainingFraction":0.5},
		{"bucketId":"3p-weekly","window":"weekly","remainingAmount":"40"},
		{"bucketId":"3p-5h","window":"5h","remainingFraction":0.2,"disabled":true},
		{"bucketId":"x-5h","window":"5h","remainingFraction":1.5}
	]}`), now)
	if len(rows) != 2 || rows[0].WindowID != "gemini-five-hour" || *rows[0].UsedPercent != 100 || rows[0].ResetAt == nil {
		t.Fatalf("%+v", rows)
	}
	if rows[1].WindowID != "gemini-daily" || rows[1].Scope != "gemini" || rows[1].Label != "daily" {
		t.Fatalf("%+v", rows[1])
	}
	rows, _ = parseAntigravity([]byte(`{"groups":[{"displayName":"Claude and GPT models","buckets":[{"bucketId":"other","window":"weekly","remainingFraction":0.5}]}]}`), now)
	if len(rows) != 1 || rows[0].WindowID != "claude-and-gpt-models-weekly" || rows[0].Scope != "claude-and-gpt-models" {
		t.Fatalf("group fallback %+v", rows)
	}
	for body, kind := range map[string]WindowKind{`{}`: WindowEmpty, `[]`: WindowInvalid, `not json`: WindowInvalid} {
		rows, err := parseAntigravity([]byte(body), now)
		if err != nil || len(rows) != 1 || rows[0].Kind != kind || rows[0].Provider != "antigravity" {
			t.Fatalf("%s: %+v %v", body, rows, err)
		}
	}
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func agyIDToken(sub string) string {
	enc := base64.RawURLEncoding
	return enc.EncodeToString([]byte(`{"alg":"none"}`)) + "." + enc.EncodeToString([]byte(`{"sub":"`+sub+`","email":"someone@example.com"}`)) + ".sig"
}

func writeAgyLogin(t *testing.T, body string) string {
	t.Helper()
	gemini := t.TempDir()
	dir := filepath.Join(gemini, "antigravity-cli")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if body != "" {
		if err := os.WriteFile(filepath.Join(dir, "antigravity-oauth-token"), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return gemini
}

func agyLogin(access string) string {
	return `{"token":{"access_token":"` + access + `","token_type":"Bearer","refresh_token":"refresh-secret","expiry":"2026-10-14T20:49:19+09:00"},"auth_method":"consumer","id_token":"` + agyIDToken("1001") + `"}`
}

func antigravityAccount(t *testing.T, local Local) (found bool, status string, active bool) {
	t.Helper()
	for _, p := range local.Providers {
		if p.ID != "antigravity" {
			continue
		}
		if p.Name != "Antigravity" || len(p.Accounts) != 1 || p.Accounts[0].ID != "antigravity-cli" {
			t.Fatalf("provider %+v", p)
		}
		return true, p.Accounts[0].Status, p.Accounts[0].Active != nil && *p.Accounts[0].Active
	}
	return false, "", false
}

func TestAntigravityLoginIsALocalCLIBinding(t *testing.T) {
	now := time.UnixMilli(1792000000000)
	gemini := writeAgyLogin(t, agyLogin("access-secret"))
	local, err := Reader{Home: t.TempDir(), GeminiHome: gemini, Direct: []string{"antigravity"}}.LoadLocal(now)
	if err != nil {
		t.Fatal(err)
	}
	if local.Files["antigravityCLI"] != FileOK || len(local.Warnings) != 0 {
		t.Fatalf("%v %v", local.Files, local.Warnings)
	}
	if len(local.Bindings) != 1 {
		t.Fatalf("%+v", local.Bindings)
	}
	b := local.Bindings[0]
	if b.Provider != "antigravity" || b.AccountID != "antigravity-cli" || b.Kind != KindOAuth || b.Token != "access-secret" || b.Source != "antigravityCLI" || b.BaseStatus != "native" || !b.Enabled {
		t.Fatalf("%+v", b)
	}
	if b.AccountRef == nil || *b.AccountRef != "1001" {
		t.Fatal("account reference must be the id token subject")
	}
	if !allowedCredential(b) {
		t.Fatal("local CLI login refused")
	}
	if found, status, active := antigravityAccount(t, local); !found || status != "unavailable" || !active {
		t.Fatalf("account %v %s %v", found, status, active)
	}
}

func TestAntigravityLoginIsReadOnlyWhenOptedIn(t *testing.T) {
	gemini := writeAgyLogin(t, agyLogin("access-secret"))
	var opened []string
	read := func(path string) ([]byte, error) {
		opened = append(opened, path)
		return os.ReadFile(path)
	}
	local, err := Reader{Home: t.TempDir(), GeminiHome: gemini, Direct: []string{"kimi"}, ReadFile: read}.LoadLocal(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range opened {
		if strings.HasPrefix(path, gemini) {
			t.Fatalf("read %s without opt-in", path)
		}
	}
	if found, _, _ := antigravityAccount(t, local); found || len(local.Bindings) != 0 {
		t.Fatalf("published without opt-in: %+v", local.Providers)
	}
}

func TestAntigravityMissingOrBrokenLoginNeedsReauth(t *testing.T) {
	for name, tc := range map[string]struct {
		body    string
		state   FileState
		warning bool
	}{
		"missing":   {"", FileMissing, false},
		"malformed": {`{"token":`, FileMalformed, true},
		"no token":  {`{"token":{"refresh_token":"r"}}`, FileMalformed, true},
	} {
		t.Run(name, func(t *testing.T) {
			gemini := writeAgyLogin(t, tc.body)
			local, err := Reader{Home: t.TempDir(), GeminiHome: gemini, Direct: []string{"antigravity"}}.LoadLocal(time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if local.Files["antigravityCLI"] != tc.state || len(local.Bindings) != 0 {
				t.Fatalf("%v %+v", local.Files, local.Bindings)
			}
			if tc.warning != (len(local.Warnings) == 1) || (tc.warning && !strings.Contains(local.Warnings[0], "Antigravity CLI")) {
				t.Fatalf("warnings %v", local.Warnings)
			}
			if found, status, _ := antigravityAccount(t, local); !found || status != "reauth" {
				t.Fatalf("account %v %s", found, status)
			}
		})
	}
}

func TestAntigravityRidesTheSchedulerCadence(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1792000000000)}
	f := &Fake{Responses: []transport.Response{
		{Status: 200, Body: []byte(antigravitySummary)},
		{Status: 401, Body: []byte(`{"error":{"code":401}}`)},
	}}
	s := NewScheduler(clk, f)
	gemini := writeAgyLogin(t, agyLogin("access-secret"))
	local, err := Reader{Home: t.TempDir(), GeminiHome: gemini, Direct: []string{"antigravity"}}.LoadLocal(clk.Now())
	if err != nil {
		t.Fatal(err)
	}
	rows := s.Collect(context.Background(), local.Bindings, []string{"antigravity"})
	if len(rows) != 4 || f.CallCount() != 1 {
		t.Fatalf("%d rows %d calls", len(rows), f.CallCount())
	}
	req := f.Calls[0]
	if req.Host != "daily-cloudcode-pa.googleapis.com" || req.Path != "/v1internal:retrieveUserQuotaSummary" || req.Method != "POST" || string(req.Body) != "{}" {
		t.Fatalf("%+v", req)
	}
	if req.Headers["Authorization"] != "Bearer access-secret" || !strings.HasPrefix(req.Headers["User-Agent"], "antigravity/") || req.Headers["Content-Type"] != "application/json" {
		t.Fatalf("headers %v", req.Headers)
	}
	for _, r := range rows {
		if r.Account != "antigravity-cli" || r.StartedAt == 0 {
			t.Fatalf("%+v", r)
		}
	}
	// The 30-second cycle reuses the reading until the five-minute floor passes.
	clk.Set(clk.Now().Add(4 * time.Minute))
	if rows := s.Collect(context.Background(), local.Bindings, []string{"antigravity"}); f.CallCount() != 1 || len(rows) != 4 || !rows[0].Cached {
		t.Fatalf("polled early: %d calls", f.CallCount())
	}
	clk.Set(clk.Now().Add(time.Minute))
	s.Collect(context.Background(), local.Bindings, []string{"antigravity"})
	outcomes := s.Outcomes()
	if f.CallCount() != 2 || len(outcomes) != 1 || outcomes[0].Status != "unauthorized" {
		t.Fatalf("%d calls %+v", f.CallCount(), outcomes)
	}
	if wait := time.UnixMilli(outcomes[0].NextAttemptAt).Sub(clk.Now()); wait != 30*time.Minute {
		t.Fatalf("auth cooldown %v", wait)
	}
}
