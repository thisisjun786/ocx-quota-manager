package runtime

import (
	"math"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func TestPriceUsageValuesAnthropicNativeWithAnthropicEvidence(t *testing.T) {
	at := int64(1800000000000)
	rates := [4]*float64{repairPtr(5.0), repairPtr(25.0), repairPtr(.5), repairPtr(6.25)}
	// Evidence named after the alias itself must not value it either.
	evidence := []store.Evidence{{Provider: "anthropic", Model: "claude-opus-5-5", Status: "official", Rates: rates},
		{Provider: "anthropic", Model: "ocx-claude-native--gpt-6.1-sol", Status: "official", Rates: rates}}
	row := func(provider, basis, model string) store.Usage {
		return store.Usage{Provider: provider, Model: repairPtr(model), At: at, Input: repairPtr(1000.0), Output: repairPtr(100.0), Cached: repairPtr(200.0), Basis: repairPtr(basis)}
	}
	got, unknown := priceUsage([]store.Usage{
		row("anthropic", "unknown", "claude-opus-5-5"),
		row("anthropic-native", "unknown", "claude-opus-5-5"),
		row("anthropic-native", store.UnknownInputBasis, "claude-opus-5-5"),
		row("anthropic-native", "unknown", "ocx-claude-native--gpt-6.1-sol"),
		row("anthropic-apikey", "unknown", "claude-opus-5-5"),
		row("anthropic", "unknown", "ocx-claude-native--gpt-6.1-sol"),
	}, evidence, at)
	want := (800*5.0 + 100*25 + 200*.5) / 1e6
	for i := 0; i < 2; i++ {
		if got[i].USD == nil || math.Abs(*got[i].USD-want) > 1e-12 {
			t.Fatalf("row %d: %v want %g", i, got[i].USD, want)
		}
	}
	for i := 2; i < 6; i++ {
		if got[i].USD != nil || !got[i].UnknownPrice {
			t.Fatalf("row %d priced: %+v", i, got[i])
		}
	}
	if unknown != 4 {
		t.Fatalf("unknown=%d", unknown)
	}
}

func TestBreakdownKeepsAnthropicNativeSeparate(t *testing.T) {
	now := int64(1_800_000_000_000)
	account := "a1"
	opus := "claude-opus-5-5"
	usd := func(v float64) *float64 { return &v }
	rows := []store.Usage{
		{ID: "pool", At: now - calc.HourMs, Provider: "anthropic", Account: &account, Model: &opus, Tokens: usd(10)},
		{ID: "native", At: now - 2*calc.HourMs, Provider: "anthropic-native", Model: &opus, Tokens: usd(20)},
	}
	prices := []calc.AppliedPrice{{USD: usd(1)}, {USD: usd(2)}}
	providers := []contract.Provider{{ID: "anthropic", Name: "Anthropic", Accounts: []contract.Account{{ID: "a1", Label: "me@x"}}}}
	out := costBreakdown(rows, prices, providers, now, time.UTC)
	day := out["periods"].(map[string]any)["day"].(costPeriod)
	if day.Total.APIUsd != 3 || len(day.Providers) != 2 {
		t.Fatalf("providers %+v", day.Providers)
	}
	by := map[string]costRow{}
	for _, r := range day.Providers {
		by[r.Provider] = r
	}
	a, n := by["anthropic"], by["anthropic-native"]
	if a.APIUsd != 1 || a.Requests != 1 || a.PriceProvider != "" || a.Configured == nil || !*a.Configured {
		t.Fatalf("anthropic row %+v", a)
	}
	if n.APIUsd != 2 || n.Requests != 1 || n.PriceProvider != "anthropic" || n.Configured != nil || n.Name != "Claude Code 로그인 (OCX 경유)" {
		t.Fatalf("anthropic-native row %+v", n)
	}
	for _, m := range day.Models {
		want := ""
		if m.Provider == "anthropic-native" {
			want = "anthropic"
		}
		if m.PriceProvider != want {
			t.Fatalf("model row %+v", m)
		}
	}
	if len(day.Models) != 2 {
		t.Fatalf("models %+v", day.Models)
	}
	for _, r := range day.Accounts {
		if r.Provider == "anthropic-native" && r.Name != "계정 미확인" {
			t.Fatalf("account row %+v", r)
		}
		if r.Provider == "anthropic" && r.APIUsd != 1 {
			t.Fatalf("anthropic account rows absorbed native usage: %+v", r)
		}
	}
	if removed := out["removedProviders"].([]removedProvider); len(removed) != 0 {
		t.Fatalf("routing label reported as removed: %+v", removed)
	}
	roster := accountRoster(providers, rows, prices, now)
	if len(roster) != 1 || roster[0].Week.APIUsd != 1 || roster[0].Week.Requests != 1 {
		t.Fatalf("roster %+v", roster)
	}
	// A roster name wins over the fallback label.
	named := append([]contract.Provider{}, providers...)
	named = append(named, contract.Provider{ID: "anthropic-native", Name: "Native"})
	out = costBreakdown(rows, prices, named, now, time.UTC)
	for _, r := range out["periods"].(map[string]any)["day"].(costPeriod).Providers {
		if r.Provider == "anthropic-native" && (r.Name != "Native" || r.Configured != nil || r.PriceProvider != "anthropic") {
			t.Fatalf("named routing row %+v", r)
		}
	}
}
