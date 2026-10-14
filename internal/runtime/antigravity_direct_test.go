package runtime

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

func writeAgyToken(t *testing.T, gemini, access string) {
	t.Helper()
	dir := filepath.Join(gemini, "antigravity-cli")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	enc := base64.RawURLEncoding
	id := enc.EncodeToString([]byte(`{}`)) + "." + enc.EncodeToString([]byte(`{"sub":"1001"}`)) + ".sig"
	body := `{"token":{"access_token":"` + access + `","token_type":"Bearer","refresh_token":"r","expiry":"2026-10-14T20:49:19+09:00"},"auth_method":"consumer","id_token":"` + id + `"}`
	if err := os.WriteFile(filepath.Join(dir, "antigravity-oauth-token"), []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func agySummary(gemini5h float64) []byte {
	return []byte(`{"groups":[
	 {"displayName":"Gemini Models","buckets":[
	  {"bucketId":"gemini-weekly","window":"weekly","resetTime":"2027-01-21T05:47:03Z","remainingFraction":0.85},
	  {"bucketId":"gemini-5h","window":"5h","resetTime":"2027-01-15T15:47:03Z","remainingFraction":` + strconv.FormatFloat(gemini5h, 'f', -1, 64) + `}]},
	 {"displayName":"Claude and GPT models","buckets":[
	  {"bucketId":"3p-weekly","window":"weekly","resetTime":"2027-01-21T11:39:16Z","remainingFraction":1},
	  {"bucketId":"3p-5h","window":"5h","resetTime":"2027-01-15T16:39:16Z","remainingFraction":1}]}]}`)
}

func TestAntigravityQuotaTakesTheDirectPath(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1800000000000)}
	gemini := t.TempDir()
	writeAgyToken(t, gemini, "access-1")
	h := openProbeStore(t)
	f := &collect.Fake{Responses: []transport.Response{
		{Status: 200, Body: agySummary(0.9)},
		{Status: 200, Body: agySummary(0.8)},
	}}
	rt := New(clk, h, f)
	rt.Home = t.TempDir()
	rt.GeminiHome = gemini
	rt.Direct = []string{"antigravity"}
	rt.cycle(context.Background())
	// agy renews its access token; the account and its history continue.
	writeAgyToken(t, gemini, "access-2")
	clk.Set(clk.Now().Add(30 * time.Second))
	rt.cycle(context.Background())
	clk.Set(clk.Now().Add(5 * time.Minute))
	rt.cycle(context.Background())
	if f.CallCount() != 2 || f.Calls[1].Headers["Authorization"] != "Bearer access-2" {
		t.Fatalf("calls %d", f.CallCount())
	}
	obs, err := h.ListObservations()
	if err != nil || len(obs) != 8 {
		t.Fatalf("observations %d %v", len(obs), err)
	}
	scopes := map[string]string{}
	for _, o := range obs {
		if o.Provider != "antigravity" || o.Account != "antigravity-cli" || o.Source == nil || *o.Source != "antigravity/quota-summary" || *o.Method != "reported_percent" || o.Epoch == nil || *o.Epoch != *obs[0].Epoch {
			t.Fatalf("%+v", o)
		}
		scopes[o.Window] = *o.ScopeKey
		started := o.Window == "gemini-five-hour" || o.Window == "gemini-weekly"
		if started != (o.Reset != nil && o.CycleKey != nil && o.WindowSemantics == "fixed_reset") {
			t.Fatalf("reset contract %+v", o)
		}
	}
	if len(scopes) != 4 || scopes["gemini-five-hour"] != "gemini" || scopes["gemini-weekly"] != "gemini" || scopes["3p-five-hour"] != "3p" || scopes["3p-weekly"] != "3p" {
		t.Fatalf("scopes %v", scopes)
	}
	if last := obs[len(obs)-1]; last.Window != "3p-weekly" || last.ObservedPercent != 0 {
		t.Fatalf("%+v", last)
	}
	snap := rt.Snapshot()
	if snap.Analytics.(map[string]any)["status"] != "ok" {
		t.Fatalf("analytics %v", snap.Analytics.(map[string]any)["status"])
	}
	var found bool
	for _, p := range snap.Providers {
		if p.ID != "antigravity" {
			continue
		}
		found = true
		a := p.Accounts[0]
		if a.Status != "ok" || len(a.Windows) != 4 || a.DirectQuota.(map[string]any)["status"] != "ok" {
			t.Fatalf("%+v", a)
		}
		for _, w := range a.Windows {
			if w.UsageScope == nil || w.RemainingPercent == nil || w.Analytics == nil {
				t.Fatalf("%+v", w)
			}
		}
		if _, ok := p.Analytics.(map[string]any)["quotaRecommendations"]; !ok {
			t.Fatal("provider analytics missing")
		}
	}
	if !found {
		t.Fatal("antigravity not published")
	}
	// A removed login is an account to sign in again, not a failed collection.
	if err := os.Remove(filepath.Join(gemini, "antigravity-cli", "antigravity-oauth-token")); err != nil {
		t.Fatal(err)
	}
	clk.Set(clk.Now().Add(5 * time.Minute))
	rt.cycle(context.Background())
	snap = rt.Snapshot()
	if snap.Analytics.(map[string]any)["status"] != "ok" || f.CallCount() != 2 {
		t.Fatalf("status %v calls %d", snap.Analytics.(map[string]any)["status"], f.CallCount())
	}
	for _, p := range snap.Providers {
		if p.ID == "antigravity" && p.Accounts[0].Status != "reauth" {
			t.Fatalf("%+v", p.Accounts[0])
		}
	}
}
