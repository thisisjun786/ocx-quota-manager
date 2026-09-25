package store

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConditionalPriceUsesRequestSelectors(t *testing.T) {
	e := Evidence{Provider: "openai", Model: "gpt-5.6-sol", Status: "official", SourceURL: cachePtr("https://developers.openai.com/api/docs/pricing"), Rates: [4]*float64{cachePtr(4.0), cachePtr(20.0), cachePtr(.4), cachePtr(5.0)}, TierMultiplier: cachePtr(1.0), Conditions: []string{"long-context", "service-tier-discount", "service-tier-priority"}}
	long := e
	long.Rates = [4]*float64{cachePtr(8.0), cachePtr(30.0), cachePtr(.8), cachePtr(10.0)}
	for _, tc := range []struct {
		name  string
		input float64
		tier  string
		want  float64
	}{{"base", 1000, "default", .00528}, {"long", 300000, "default", 2.40156}, {"priority", 1000, "priority", .01056}, {"flex", 1000, "flex", .00264}} {
		t.Run(tc.name, func(t *testing.T) {
			row := map[string]any{"responseServiceTier": tc.tier, "usage": map[string]any{"inputTokens": tc.input, "outputTokens": 100.0, "cachedInputTokens": 200.0}}
			q := quoteIngest(e.Provider, e.Model, 1800000000000, row, []Evidence{e, long})
			if q.usd == nil || math.Abs(*q.usd-tc.want) > 1e-9 {
				t.Fatalf("got %v want %g", q.usd, tc.want)
			}
		})
	}
}

func TestConditionalReplayRepairsUnknownKeepsSettledAndExcluded(t *testing.T) {
	h := openTemp(t)
	at := int64(1800000000000)
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	rows := []map[string]any{}
	for _, id := range []string{"unknown", "settled", "excluded"} {
		stamp := at
		if id == "excluded" {
			stamp = at - 1000
		}
		rows = append(rows, map[string]any{"requestId": id, "timestamp": stamp, "provider": "openai", "model": "gpt-5.6-sol", "usage": map[string]any{"inputTokens": 1000, "outputTokens": 100, "cachedInputTokens": 200}})
	}
	var body []byte
	for _, r := range rows {
		b, _ := json.Marshal(r)
		body = append(body, append(b, '\n')...)
	}
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	h.SetMeta("usageCursor", map[string]any{"ino": statIno(info), "offset": len(body)})
	h.SetMeta("historyResetAt", at)
	for _, id := range []string{"unknown", "settled"} {
		var usd *float64
		if id == "settled" {
			usd = cachePtr(99.0)
		}
		h.InsertUsage(Usage{ID: attemptID(id, 0), At: at, Provider: "openai", Model: cachePtr("gpt-5.6-sol"), Input: cachePtr(1000.0), Output: cachePtr(100.0), Cached: cachePtr(200.0), Tokens: cachePtr(1100.0), USD: usd, Basis: cachePtr("unknown")})
	}
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	got, err := h.ListUsage()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("excluded history resurrected: %d", len(got))
	}
	for _, u := range got {
		want := .00528
		if u.ID == attemptID("settled", 0) {
			want = 99
		}
		if u.USD == nil || math.Abs(*u.USD-want) > 1e-9 {
			t.Fatalf("amount %v want %g", u.USD, want)
		}
	}
	var links int
	h.db.QueryRow("SELECT count(*) FROM usage_prices").Scan(&links)
	if links != 1 {
		t.Fatalf("links %d", links)
	}
	if n, err := h.IngestJSONL(path, at); err != nil || n != 0 {
		t.Fatalf("repeat ingest %d %v", n, err)
	}
}

func TestConditionalPricePeakAndUnknownTier(t *testing.T) {
	row := map[string]any{"usage": map[string]any{"inputTokens": 1000.0, "outputTokens": 100.0, "cachedInputTokens": 200.0}}
	for _, tc := range []struct {
		at   string
		want float64
	}{{"2026-09-22T00:00:00Z", .0001806}, {"2026-09-22T02:00:00Z", .0003606}, {"2026-09-26T02:00:00Z", .0001806}} {
		stamp, _ := time.Parse(time.RFC3339, tc.at)
		q := quoteIngest("command-code", "deepseek/deepseek-v4.1-flash", stamp.UnixMilli(), row, nil)
		if q.usd == nil || math.Abs(*q.usd-tc.want) > 1e-12 {
			t.Fatalf("%s amount %v want %g", tc.at, q.usd, tc.want)
		}
	}
	row["requestedServiceTier"] = "priority"
	if q := quoteIngest("openai", "gpt-5.6-sol", 1800000000000, row, nil); q.usd != nil {
		t.Fatal("requested tier mistaken for applied")
	}
	row["responseServiceTier"] = "default"
	if q := quoteIngest("openai", "gpt-5.6-sol", 1800000000000, row, nil); q.usd == nil {
		t.Fatal("response precedence lost")
	}
}

func TestKimiContextVariantPricesWithoutBorrowingAnotherProvider(t *testing.T) {
	row := map[string]any{"usage": map[string]any{"inputTokens": 1000.0, "outputTokens": 100.0, "cachedInputTokens": 200.0}}
	q := quoteIngest("kimi", "k3[1m]", 1800000000000, row, nil)
	if q.usd == nil || math.Abs(*q.usd-.00396) > 1e-12 || q.basis != "local-catalog" {
		t.Fatalf("kimi quote %+v", q)
	}
	if q := quoteIngest("unrelated-provider", "k3[1m]", 1800000000000, row, nil); q.usd != nil {
		t.Fatal("borrowed tariff")
	}
	row["usage"].(map[string]any)["cacheCreationInputTokens"] = 100.0
	if q := quoteIngest("kimi", "k3[1m]", 1800000000000, row, nil); q.usd != nil {
		t.Fatal("invented cache-write price")
	}
}

func TestSettledReplayDoesNotInventEvidenceAndAliasReasonSurvives(t *testing.T) {
	h := openTemp(t)
	at := int64(1800000000000)
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	h.InsertUsage(Usage{ID: attemptID("settled", 0), Provider: "openai", At: at, Model: cachePtr("gpt-5.6-sol"), Input: cachePtr(1000.0), Output: cachePtr(100.0), Tokens: cachePtr(1100.0), USD: cachePtr(99.0)})
	if err := os.WriteFile(path, []byte(`{"requestId":"settled","timestamp":1800000000000,"provider":"openai","model":"gpt-5.6-sol","usage":{"inputTokens":1000,"outputTokens":100}}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	evidence, err := h.ListEvidence()
	if err != nil || len(evidence) != 0 {
		t.Fatalf("unlinked evidence %+v %v", evidence, err)
	}
	q, ok := conditionalEvidence("openai", "gpt-daybreak-blue-latest", at, 0, nil)
	if !ok || q.Reason == nil || *q.Reason == "" {
		t.Fatal("alias provenance lost")
	}
}

func TestIncompleteFirstTailDoesNotPublishObservedThrough(t *testing.T) {
	h := openTemp(t)
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	if err := os.WriteFile(path, []byte(`{"requestId":"incomplete"`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.IngestJSONL(path, 1800000000000); err != nil {
		t.Fatal(err)
	}
	if through, ok := h.Meta("usageObservedThrough"); ok && through != nil {
		t.Fatalf("unread tail counted %v", through)
	}
}
