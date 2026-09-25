package store

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestAppliedFastTierPricesAtPriorityRate(t *testing.T) {
	row := map[string]any{"responseServiceTier": "default",
		"tierOutcome": map[string]any{"canonical": "priority", "wireValue": "priority", "fastOutcome": "applied", "responseServiceTier": "default"},
		"usage":       map[string]any{"inputTokens": 1000.0, "outputTokens": 100.0, "cachedInputTokens": 800.0}}
	q := quoteIngest("openai", "gpt-6-sol", 1800000000000, row, nil)
	want := (200*2 + 800*0.2 + 100*10) / 1e6 * 2
	if q.usd == nil || math.Abs(*q.usd-want) > 1e-12 {
		t.Fatalf("applied fast priced %v want %v", q.usd, want)
	}
	row["tierOutcome"].(map[string]any)["fastOutcome"] = "not-requested"
	delete(row["tierOutcome"].(map[string]any), "canonical")
	delete(row["tierOutcome"].(map[string]any), "wireValue")
	q = quoteIngest("openai", "gpt-6-sol", 1800000000000, row, nil)
	if q.usd == nil || math.Abs(*q.usd-want/2) > 1e-12 {
		t.Fatalf("standard priced %v want %v", q.usd, want/2)
	}
}

func TestNewTariffsPriceFastGrokAndKimiHighspeed(t *testing.T) {
	row := map[string]any{"usage": map[string]any{"inputTokens": 1000.0, "outputTokens": 100.0, "cachedInputTokens": 0.0}}
	if q := quoteIngest("xai", "grok-4.7-build-fast", 1800000000000, row, nil); q.usd == nil || math.Abs(*q.usd-(1000*4+100*12)/1e6) > 1e-12 {
		t.Fatalf("grok fast %+v", q)
	}
	if q := quoteIngest("kimi", "kimi-for-coding-highspeed", 1800000000000, row, nil); q.usd == nil || math.Abs(*q.usd-(1000*1.9+100*8)/1e6) > 1e-12 {
		t.Fatalf("kimi highspeed %+v", q)
	}
}

func TestTariffRevisionRepricesOnlyChangedRows(t *testing.T) {
	h := openTemp(t)
	at := int64(1800000000000)
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	fast := map[string]any{"canonical": "priority", "wireValue": "priority", "fastOutcome": "applied"}
	var body []byte
	for _, r := range []map[string]any{
		{"requestId": "fast", "timestamp": at, "provider": "openai", "model": "gpt-5.6-sol", "tierOutcome": fast,
			"usage": map[string]any{"inputTokens": 1000, "outputTokens": 100, "cachedInputTokens": 0}},
		{"requestId": "plain", "timestamp": at, "provider": "openai", "model": "gpt-5.6-sol",
			"usage": map[string]any{"inputTokens": 1000, "outputTokens": 100, "cachedInputTokens": 0}},
	} {
		b, _ := json.Marshal(r)
		body = append(body, append(b, '\n')...)
	}
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	// Simulate amounts stored by an earlier generation that ignored the fast tier.
	for _, id := range []string{"fast", "plain"} {
		if _, err := h.DB().Exec("UPDATE usage SET usd=0.001 WHERE id=?", attemptID(id, 0)); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.SetMeta("tariffRevision", "older"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	rows, _ := h.ListUsage()
	by := map[string]float64{}
	for _, u := range rows {
		by[u.ID] = *u.USD
	}
	if want := (1000*4 + 100*20) / 1e6 * 2; math.Abs(by[attemptID("fast", 0)]-want) > 1e-12 {
		t.Fatalf("fast row not repriced: %v want %v", by[attemptID("fast", 0)], want)
	}
	if by[attemptID("plain", 0)] != 0.001 {
		t.Fatalf("an unrelated settled amount changed: %v", by[attemptID("plain", 0)])
	}
	if v, _ := h.Meta("tariffRevision"); v != TariffRevision {
		t.Fatalf("revision not recorded: %v", v)
	}
}
