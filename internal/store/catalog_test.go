package store

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

const catalogFixture = `{"anthropic":{"models":{"claude-new":{"id":"claude-new","cost":{"input":4,"output":20,"cache_read":0.2,"cache_write":5}}}},
"openai":{"models":{"gpt-new":{"id":"gpt-new","cost":{"input":2,"output":10,"cache_read":0.2,"tiers":[{"input":4,"output":15,"cache_read":0.4,"tier":{"type":"context","size":272000}}]}}}}}`

func TestCatalogPricesModelsTheSourceTableLacks(t *testing.T) {
	c, err := ParseCatalog([]byte(catalogFixture))
	if err != nil {
		t.Fatal(err)
	}
	row := func(input float64) map[string]any {
		return map[string]any{"usage": map[string]any{"inputTokens": input, "outputTokens": 100.0, "cachedInputTokens": 0.0}}
	}
	q := quoteIngest("openai", "gpt-new", 1800000000000, row(1000), nil, c)
	if q.usd == nil || math.Abs(*q.usd-(1000*2+100*10)/1e6) > 1e-12 || q.basis != "local-catalog" {
		t.Fatalf("base tier %+v", q)
	}
	q = quoteIngest("openai", "gpt-new", 1800000000000, row(300000), nil, c)
	if q.usd == nil || math.Abs(*q.usd-(300000*4+100*15)/1e6) > 1e-12 {
		t.Fatalf("context tier %+v", q)
	}
	if q := quoteIngest("openai", "gpt-other", 1800000000000, row(1000), nil, c); q.usd != nil {
		t.Fatalf("a model the catalog lacks stays unknown %+v", q)
	}
	// A priority request cannot be priced from a default-tier catalog row.
	pr := row(1000)
	pr["responseServiceTier"] = "priority"
	if q := quoteIngest("openai", "gpt-new", 1800000000000, pr, nil, c); q.usd != nil {
		t.Fatalf("tiered request priced from catalog %+v", q)
	}
}

func TestCatalogReplayFillsUnknownAndKeepsSettled(t *testing.T) {
	h := openTemp(t)
	at := int64(1800000000000)
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	var body []byte
	for _, id := range []string{"unknown", "settled"} {
		b, _ := json.Marshal(map[string]any{"requestId": id, "timestamp": at, "provider": "anthropic", "model": "claude-new",
			"usage": map[string]any{"inputTokens": 1000, "outputTokens": 100, "cacheReadInputTokens": 200}})
		body = append(body, append(b, '\n')...)
	}
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	// First ingest without a catalog: both rows unknown.
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	if _, err := h.DB().Exec("UPDATE usage SET usd=99, basis='official' WHERE id=?", attemptID("settled", 0)); err != nil {
		t.Fatal(err)
	}
	c, err := ParseCatalog([]byte(catalogFixture))
	if err != nil {
		t.Fatal(err)
	}
	h.SetCatalog(c)
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	got, err := h.ListUsage()
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Usage{}
	for _, u := range got {
		by[u.ID] = u
	}
	u := by[attemptID("unknown", 0)]
	want := (800*4 + 100*20 + 200*0.2) / 1e6
	if u.USD == nil || math.Abs(*u.USD-want) > 1e-12 || u.Basis == nil || *u.Basis != "local-catalog" {
		t.Fatalf("replay did not fill the unknown row: %+v", u)
	}
	if s := by[attemptID("settled", 0)]; s.USD == nil || *s.USD != 99 {
		t.Fatalf("settled amount changed: %+v", s)
	}
	// Same catalog again: no second replay (cursor stays at the end).
	if n, err := h.IngestJSONL(path, at); err != nil || n != 0 {
		t.Fatalf("unchanged catalog replayed %d rows: %v", n, err)
	}
}
