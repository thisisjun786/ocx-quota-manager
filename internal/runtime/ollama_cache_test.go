package runtime

import (
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func TestOllamaFixedCache90AcrossAnalyticsAndNativeCosts(t *testing.T) {
	now := time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)
	h := openProbeStore(t)
	u := store.Usage{ID: "ollama-cache", At: now.UnixMilli(), Provider: "ollama-cloud", Model: repairPtr("glm-5.3"), Input: repairPtr(1e6), Output: repairPtr(1e5), Cached: repairPtr(123.0), Tokens: repairPtr(1.1e6), USD: repairPtr(999.0), Basis: repairPtr("official")}
	if err := h.InsertUsage(u); err != nil {
		t.Fatal(err)
	}
	before, err := h.ListUsage()
	if err != nil {
		t.Fatal(err)
	}
	providers := []contract.Provider{{ID: "ollama-cloud", Name: "Ollama Cloud", Enabled: true, SupportedModels: []string{"glm-5.3"}}}
	for i := 0; i < 2; i++ {
		a, p, err := attachAnalytics(providers, h, now, "ok")
		if err != nil {
			t.Fatal(err)
		}
		for _, bag := range []any{a, p[0].Analytics} {
			period := repairPeriod(t, bag, "oneHour")
			// 1M*(10%*$1.40 + 90%*$0.26) + 100k*$4.40 = $0.814.
			if got := period["apiUsd"]; got == nil || math.Abs(got.(float64)-.814) > 1e-12 {
				t.Fatalf("period cost %v", got)
			}
			if period["cacheEstimatedRequests"] != float64(1) || period["estimatedCachedTokens"] != 900000.0 || period["cachedTokens"] != 123.0 {
				t.Fatal("estimated/measured cache mixed", period)
			}
			if got := period["noCacheApiUsd"]; got == nil || math.Abs(got.(float64)-1.84) > 1e-12 {
				t.Fatalf("no-cache cost %v", got)
			}
		}
		assumption := repairMap(t, p[0].Analytics)["cacheAssumption"].(map[string]any)
		if assumption["appliedRate"] != .9 || assumption["basis"] != "user-fixed" {
			t.Fatal(assumption)
		}
		rt := &Runtime{Store: h, NativeEnabled: true}
		if err := rt.attachNativeCosts(a, p, now); err != nil {
			t.Fatal(err)
		}
		costs := repairMap(t, a["costs"])["periods"].(map[string]any)["day"].(map[string]any)
		total := costs["total"].(map[string]any)
		if got := total["apiUsd"]; got == nil || math.Abs(got.(float64)-.814) > 1e-12 {
			t.Fatal("native combined cost differs", total)
		}
	}
	after, err := h.ListUsage()
	if err != nil || !reflect.DeepEqual(before, after) || *after[0].USD != 999 || *after[0].Cached != 123 {
		t.Fatal("stored usage mutated", after, err)
	}
}

func TestOllamaFixedCachePeakBoundariesAndUnknowns(t *testing.T) {
	for _, tc := range []struct {
		stamp, model string
		want         *float64
	}{
		{"2026-10-08T11:59:59Z", "deepseek-v4.1-flash", repairPtr(.0777)},
		{"2026-10-08T12:00:00Z", "deepseek-v4.1-flash", repairPtr(.1554)},
		{"2026-10-08T17:59:59Z", "deepseek-v4.1-flash", repairPtr(.1554)},
		{"2026-10-08T18:00:00Z", "deepseek-v4.1-flash", repairPtr(.0777)},
		{"2026-10-10T13:00:00Z", "deepseek-v4.1-flash", repairPtr(.0777)},
		{"2026-10-08T00:00:00Z", "glm-5.3-flash", repairPtr(.092)},
		{"2026-10-08T00:00:00Z", "kimi-k3", repairPtr(2.07)},
		{"2026-10-08T00:00:00Z", "deepseek-v4-pro", repairPtr(.2838)},
		{"2026-10-08T12:00:00Z", "deepseek-v4-pro", repairPtr(.5676)},
		{"2026-10-08T00:00:00Z", "gemma4", repairPtr(.099)},
		{"2026-10-08T00:00:00Z", "glm-5.2", repairPtr(.814)},
		{"2026-10-08T00:00:00Z", "gpt-oss:120b", repairPtr(.0876)},
		{"2026-10-08T00:00:00Z", "gpt-oss:20b", repairPtr(.0685)},
		{"2026-10-08T00:00:00Z", "kimi-k2.7-code", repairPtr(.666)},
		{"2026-10-08T00:00:00Z", "kimi-k2.6", repairPtr(.639)},
		{"2026-10-08T00:00:00Z", "minimax-m3", repairPtr(.408)},
		{"2026-10-08T00:00:00Z", "minimax-m2.7", repairPtr(.204)},
		{"2026-10-08T00:00:00Z", "mistral-large-4", repairPtr(.34)},
		{"2026-10-08T00:00:00Z", "nemotron-3-nano", nil},
		{"2026-10-08T00:00:00Z", "nemotron-3-super", repairPtr(.0165)},
		{"2026-10-08T00:00:00Z", "nemotron-3-ultra", repairPtr(.13)},
		{"2026-10-08T00:00:00Z", "mistral-large-3", nil},
		{"2026-10-08T00:00:00Z", "unlisted-model", nil},
	} {
		t.Run(tc.stamp+tc.model, func(t *testing.T) {
			at, err := time.Parse(time.RFC3339, tc.stamp)
			if err != nil {
				t.Fatal(err)
			}
			h := openProbeStore(t)
			if err := h.InsertUsage(store.Usage{ID: "price", At: at.UnixMilli(), Provider: "ollama-cloud", Model: &tc.model, Input: repairPtr(1e6), Output: repairPtr(1e5), Cached: repairPtr(0.0), USD: repairPtr(99.0)}); err != nil {
				t.Fatal(err)
			}
			in, err := loadAnalysisInput(nil, h, at, "ok")
			if err != nil {
				t.Fatal(err)
			}
			got := in.priced[0].USD
			if tc.want == nil {
				if got != nil {
					t.Fatal("invented price", *got)
				}
			} else if got == nil || math.Abs(*got-*tc.want) > 1e-12 {
				t.Fatalf("got %v want %g", got, *tc.want)
			}
		})
	}
}

func TestOllamaFixedCachePreservesMissingSelectorsAndOtherProviders(t *testing.T) {
	now := time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name     string
		provider string
		input    *float64
		basis    *string
		want     *float64
	}{
		{"missing-input", "ollama-cloud", nil, nil, nil},
		{"lost-tier-or-write", "ollama-cloud", repairPtr(1e6), repairPtr(store.UnknownInputBasis), nil},
		{"other-provider", "anthropic", repairPtr(1e6), nil, repairPtr(99.0)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := openProbeStore(t)
			if err := h.InsertUsage(store.Usage{ID: "row", At: now.UnixMilli(), Provider: tc.provider, Model: repairPtr("glm-5.3"), Input: tc.input, Output: repairPtr(1e5), USD: repairPtr(99.0), Basis: tc.basis}); err != nil {
				t.Fatal(err)
			}
			in, err := loadAnalysisInput(nil, h, now, "ok")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(in.priced[0].USD, tc.want) {
				t.Fatal("unexpected price", in.priced[0])
			}
		})
	}
}
