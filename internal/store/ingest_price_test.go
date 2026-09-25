package store

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func cachePtr[T any](x T) *T { return &x }
func TestIngestClaudeCacheValuationAndReplay(t *testing.T) {
	h := openTemp(t)
	at := int64(1800000000000)
	eid, err := h.InsertEvidence(Evidence{Provider: "anthropic", Model: "m", Status: "official", SourceURL: cachePtr(claudePriceSource), Rates: [4]*float64{cachePtr(10.0), cachePtr(50.0), cachePtr(.25), cachePtr(12.5)}, Conditions: []string{"cache-write-assumed"}, FirstRevision: "test", FirstSeenAt: at})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.SetMeta("claudeCacheAssumption", map[string]any{"ttl": "1h", "from": at}); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "usage.jsonl")
	row := map[string]any{"timestamp": at, "requestId": "cache", "provider": "anthropic", "model": "m", "usage": map[string]any{"inputTokens": 1000, "outputTokens": 100, "cacheReadInputTokens": 200, "cacheCreationInputTokens": 300}}
	raw, _ := json.Marshal(row)
	raw = append(raw, '\n')
	os.WriteFile(log, raw, 0600)
	if _, err = h.IngestJSONL(log, at); err != nil {
		t.Fatal(err)
	}
	// 500*10 + 100*50 + 200*.25 + 300*12.5 = .0138 base; 1h .01605.
	var base, hour float64
	var link int64
	if err = h.db.QueryRow(`SELECT u.usd,c.oneHourUsd,p.evidence FROM usage u JOIN claude_cache_costs c ON c.id=u.id JOIN usage_prices p ON p.id=u.id`).Scan(&base, &hour, &link); err != nil {
		t.Fatal(err)
	}
	if math.Abs(base-.0138) > 1e-12 || math.Abs(hour-.01605) > 1e-12 || link != eid {
		t.Fatalf("base=%g hour=%g evidence=%d", base, hour, link)
	}
	rows, err := h.ListUsage()
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].USD == nil || math.Abs(*rows[0].USD-hour) > 1e-12 {
		t.Fatal("1h view not applied", rows)
	}
	// Force replay with a mismatching shape: neither the settled quote nor sidecar/link may change.
	row["usage"] = map[string]any{"inputTokens": 100000, "outputTokens": 10000, "cacheCreationInputTokens": 10000}
	raw, _ = json.Marshal(row)
	os.WriteFile(log, append(raw, '\n'), 0600)
	h.SetMeta("usageCursor", nil)
	if _, err = h.IngestJSONL(log, at); err != nil {
		t.Fatal(err)
	}
	var kept float64
	h.db.QueryRow(`SELECT usd FROM usage`).Scan(&kept)
	if kept != base {
		t.Fatal("settled USD overwritten")
	}
	var n int
	h.db.QueryRow(`SELECT count(*) FROM claude_cache_costs`).Scan(&n)
	if n != 1 {
		t.Fatal("duplicate sidecar")
	}
}
func TestIngestPricingRejectsUnprovenSelectors(t *testing.T) {
	at := int64(1800000000000)
	e := Evidence{Provider: "anthropic", Model: "m", Status: "official", SourceURL: cachePtr(claudePriceSource), Rates: [4]*float64{cachePtr(10.0), cachePtr(50.0), cachePtr(.25), cachePtr(12.5)}, Conditions: []string{"cache-write-assumed"}}
	for _, test := range []struct {
		name string
		edit func(map[string]any, *Evidence)
	}{
		{"priority", func(r map[string]any, e *Evidence) { r["responseServiceTier"] = "priority" }},
		{"unknown-write", func(r map[string]any, e *Evidence) { r["usage"].(map[string]any)["cacheCreationInputTokens"] = "300" }},
		{"overflow", func(r map[string]any, e *Evidence) {
			r["usage"].(map[string]any)["cacheCreationInputTokens"] = float64(2000)
		}},
		{"unknown-rate", func(r map[string]any, e *Evidence) { e.Rates[3] = nil }},
		{"peak", func(r map[string]any, e *Evidence) { e.Conditions = []string{"peak-hours"} }},
		{"future", func(r map[string]any, e *Evidence) { e.EffectiveFrom = cachePtr("2030-01-01T00:00:00Z") }},
		{"unreported", func(r map[string]any, e *Evidence) { r["usageStatus"] = "unreported" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := map[string]any{"usage": map[string]any{"inputTokens": float64(1000), "outputTokens": float64(100), "cacheCreationInputTokens": float64(300)}}
			copy := e
			test.edit(r, &copy)
			q := quoteIngest("anthropic", "m", at, r, []Evidence{copy})
			if q.usd != nil || q.basis != UnknownInputBasis {
				t.Fatal("unsafe price", q)
			}
		})
	}
}

func TestUnknownRatesRemainRepriceableAndProvidedBasis(t *testing.T) {
	row := map[string]any{"usage": map[string]any{"inputTokens": float64(1000), "outputTokens": float64(100)}}
	q := quoteIngest("devin", "m", 1800000000000, row, nil)
	if q.usd != nil || q.basis != "unknown" {
		t.Fatal("missing tariff is not lost input", q)
	}
	e := Evidence{Provider: "devin", Model: "m", Status: "ocx-provided", Rates: [4]*float64{cachePtr(1.0), cachePtr(2.0)}}
	q = quoteIngest("devin", "m", 1800000000000, row, []Evidence{e})
	if q.usd == nil || q.basis != "local-catalog" {
		t.Fatal("provided tariff", q)
	}
	for raw, want := range map[string]string{"openai-pabcdef": "openai", "anthropic-main": "anthropic", "chatgpt-pabcdef": "openai", "openai-multi": "openai", "ollama-cloud": "ollama-cloud"} {
		if got := usageProvider(raw); got != want {
			t.Fatalf("%s => %s", raw, got)
		}
	}
}

func TestIngestParentTierAndCanonicalProvider(t *testing.T) {
	h := openTemp(t)
	at := int64(1800000000000)
	h.InsertEvidence(Evidence{Provider: "openai", Model: "m", Status: "official", Rates: [4]*float64{cachePtr(1.0), cachePtr(2.0)}, FirstRevision: "test", FirstSeenAt: at})
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	lines := []map[string]any{
		{"requestId": "safe", "timestamp": at, "provider": "openai-pabcdef", "model": "m", "usage": map[string]any{"inputTokens": 1000, "outputTokens": 100}},
		{"requestId": "priority", "timestamp": at, "provider": "openai-main", "model": "m", "responseServiceTier": "priority", "tierOutcome": map[string]any{}, "usage": map[string]any{"inputTokens": 1000, "outputTokens": 100}},
	}
	var body []byte
	for _, r := range lines {
		b, _ := json.Marshal(r)
		body = append(body, append(b, '\n')...)
	}
	os.WriteFile(path, body, 0600)
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	rows, err := h.ListUsage()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatal(len(rows))
	}
	for _, r := range rows {
		if r.Provider != "openai" {
			t.Fatal(r.Provider)
		}
		if r.ID == attemptID("priority", 0) && (r.USD != nil || *r.Basis != UnknownInputBasis) {
			t.Fatal("parent tier lost", r)
		}
		if r.ID == attemptID("safe", 0) && r.USD == nil {
			t.Fatal("canonical tariff missing", r)
		}
	}
}
