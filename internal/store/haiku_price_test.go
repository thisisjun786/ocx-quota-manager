package store

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
)

func TestHaiku55PromptBoundaryAndCachePrices(t *testing.T) {
	// Official USD/MTok, checked 2026-10-08:
	// https://platform.claude.com/docs/en/models/haiku-5-5/overview
	for _, stamp := range []string{"2026-10-08T00:00:00Z", "2026-10-08T02:00:00Z"} {
		at, err := time.Parse(time.RFC3339, stamp)
		if err != nil {
			t.Fatal(err)
		}
		for _, tc := range []struct {
			name               string
			input, read, write float64
			want, hour         float64
		}{
			{"below", 99999, 0, 0, .0104999, 0},
			{"boundary", 100000, 0, 0, .0105, 0},
			{"above", 100001, 0, 0, .0525005, 0},
			{"cached-boundary", 100000, 90000, 9000, .002625, .0033},
			{"cached-above", 100001, 90000, 9000, .0131255, .0165005},
		} {
			t.Run(stamp+"/"+tc.name, func(t *testing.T) {
				row := map[string]any{"usage": map[string]any{"inputTokens": tc.input, "outputTokens": 1000.0, "cacheReadInputTokens": tc.read, "cacheCreationInputTokens": tc.write}}
				q := quoteIngest("anthropic", "claude-haiku-5-5", at.UnixMilli(), row, nil)
				if q.usd == nil || math.Abs(*q.usd-tc.want) > 1e-12 {
					t.Fatalf("amount %v want %g", q.usd, tc.want)
				}
				if tc.write > 0 && (q.hour == nil || math.Abs(*q.hour-tc.hour) > 1e-12) {
					t.Fatalf("1h amount %v want %g", q.hour, tc.hour)
				}
				if q.resolved == nil || q.resolved.Status != "official" || q.resolved.SourceURL == nil || *q.resolved.SourceURL != claudePriceSource || q.resolved.CheckedAt == nil || *q.resolved.CheckedAt != "2026-10-08" {
					t.Fatalf("missing official evidence: %+v", q.resolved)
				}
			})
		}
	}
}

func TestHaiku55RosterAndUnknownSelectors(t *testing.T) {
	at := int64(1800000000000)
	e, ok := ModelPriceEvidence("anthropic", "claude-haiku-5-5", at)
	if !ok || e.Rates[0] == nil || *e.Rates[0] != .1 || e.Rates[1] == nil || *e.Rates[1] != .5 {
		t.Fatalf("roster quote %+v", e)
	}
	row := map[string]any{"usage": map[string]any{"inputTokens": 1000.0, "outputTokens": 100.0}}
	for _, tier := range []string{"priority", "fast", "flex", "batch", "unknown"} {
		row["responseServiceTier"] = tier
		if q := quoteIngest("anthropic", "claude-haiku-5-5", at, row, nil); q.usd != nil {
			t.Fatalf("unproven tier %s priced", tier)
		}
	}
	delete(row, "responseServiceTier")
	for _, pair := range [][2]string{{"other-provider", "claude-haiku-5-5"}, {"anthropic", "claude-haiku-4-5"}, {"anthropic", "claude-haiku-5-5-unknown"}} {
		if q := quoteIngest(pair[0], pair[1], at, row, nil); q.usd != nil {
			t.Fatalf("borrowed Haiku 5.5 tariff for %v", pair)
		}
	}
}

func TestHaiku55NativeClaudeCountsCacheInPrompt(t *testing.T) {
	h := openTemp(t)
	line := []byte(`{"type":"assistant","timestamp":"2026-10-08T00:00:00Z","requestId":"req_haiku55synthetic0001","message":{"id":"haiku-native","model":"claude-haiku-5-5","usage":{"input_tokens":1001,"output_tokens":1000,"cache_read_input_tokens":90000,"cache_creation_input_tokens":9000,"cache_creation":{"ephemeral_1h_input_tokens":4000}}}}`)
	parsed := nativeusage.ParseLine("claude", line, &nativeusage.State{})
	if parsed.Event == nil || parsed.Event.Input != 100001 {
		t.Fatalf("prompt normalization: %+v", parsed)
	}
	e := *parsed.Event
	for i := 0; i < 2; i++ {
		if err := h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
			t.Fatal(err)
		}
	}
	v, err := h.NativeUsage()
	// 1001*.5 + 1000*2.5 + 90000*.05 + 5000*.625 + 4000*1.
	if err != nil || len(v.Rows) != 1 || v.Rows[0].USD == nil || math.Abs(*v.Rows[0].USD-.0146255) > 1e-12 {
		t.Fatalf("native valuation %+v, %v", v, err)
	}
}

func TestHaiku55ReplayFillsUnknownWithoutRestatingSettled(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	at := int64(1800000000000)
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	var body []byte
	for _, id := range []string{"unknown", "settled", "excluded", "old-fast"} {
		provider, model := "anthropic", "claude-haiku-5-5"
		if id == "old-fast" {
			provider, model = "openai", "gpt-6-sol"
		}
		stamp := at
		if id == "excluded" {
			stamp--
		}
		r := map[string]any{"requestId": id, "timestamp": stamp, "provider": provider, "model": model,
			"usage": map[string]any{"inputTokens": 100000, "outputTokens": 1000, "cacheReadInputTokens": 90000, "cacheCreationInputTokens": 9000}}
		if id == "old-fast" {
			r["tierOutcome"] = map[string]any{"canonical": "priority", "fastOutcome": "applied"}
		}
		b, err := json.Marshal(r)
		if err != nil {
			t.Fatal(err)
		}
		body = append(body, append(b, '\n')...)
		if id == "excluded" {
			continue
		}
		var usd *float64
		if id != "unknown" {
			usd = cachePtr(99.0)
		}
		if err := h.InsertUsage(Usage{ID: attemptID(id, 0), At: at, Provider: provider, Model: &model, Input: cachePtr(100000.0), Output: cachePtr(1000.0), Cached: cachePtr(90000.0), Tokens: cachePtr(101000.0), USD: usd}); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]any{
		"usageCursor":            map[string]any{"ino": statIno(info), "offset": len(body)},
		"conditionalPriceReplay": "v1", "tariffRevision": "2026-09-26-gpt6-grok47fast-kimihs-fastapplied", "historyResetAt": at,
	} {
		if err := h.SetMeta(key, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h, err = Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for i := 0; i < 2; i++ {
		n, err := h.IngestJSONL(path, at)
		if err != nil {
			t.Fatal(err)
		}
		if i == 1 && n != 0 {
			t.Fatalf("completed replay ran again: %d rows", n)
		}
		rows, err := h.ListUsage()
		if err != nil || len(rows) != 3 {
			t.Fatalf("history changed: %d rows, %v", len(rows), err)
		}
		for _, u := range rows {
			want := 99.0
			if u.ID == attemptID("unknown", 0) {
				want = .002625
			}
			if u.USD == nil || math.Abs(*u.USD-want) > 1e-12 {
				t.Fatalf("%s: amount %v want %g", u.ID, u.USD, want)
			}
		}
		var links int
		if err := h.db.QueryRow("SELECT count(*) FROM usage_prices").Scan(&links); err != nil || links != 1 {
			t.Fatalf("evidence links=%d: %v", links, err)
		}
	}
}
