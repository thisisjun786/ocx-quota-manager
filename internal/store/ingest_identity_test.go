package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLogIdentityRequiresUnambiguousLabel(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"codexAccounts":[{"id":"a","logLabel":"pabcdef"},{"id":"b","logLabel":"p123456"},{"id":"c","logLabel":"p123456"}]}`), 0600)
	ids := usageIdentities(home)
	for _, tc := range []struct{ provider, label, want string }{{"openai", "pabcdef", "a"}, {"openai-pabcdef", "", "a"}, {"openai", "p123456", ""}, {"openai", "", ""}, {"anthropic", "pabcdef", ""}, {"openai", "secret-sentinel", ""}} {
		row := map[string]any{}
		if tc.label != "" {
			row["accountLogLabel"] = tc.label
		}
		got := attributedAccount(tc.provider, row, ids)
		if tc.want == "" {
			if got != nil {
				t.Fatal("unproven identity", tc)
			}
		} else if got == nil || *got != tc.want {
			t.Fatal("lost label", tc)
		}
	}
}

func TestReplayRestoresAccountOnlyOnExactUnattributedRow(t *testing.T) {
	h := openTemp(t)
	home := t.TempDir()
	at := int64(1800000000000)
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"codexAccounts":[{"id":"a","logLabel":"pabcdef"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	row := Usage{ID: attemptID("r", 0), At: at, Provider: "openai", Model: cachePtr("gpt-5.6-sol"), Input: cachePtr(1000.0), Output: cachePtr(100.0), Tokens: cachePtr(1100.0), USD: cachePtr(99.0)}
	if err := h.InsertUsage(row); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "usage.jsonl")
	if err := os.WriteFile(path, []byte(`{"requestId":"r","timestamp":1800000000000,"provider":"openai","model":"gpt-5.6-sol","accountLogLabel":"pabcdef","usage":{"inputTokens":1000,"outputTokens":100}}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	rows, err := h.ListUsage()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Account == nil || *rows[0].Account != "a" || rows[0].USD == nil || *rows[0].USD != 99 {
		t.Fatalf("backfill changed value or lost account: %v", rows)
	}
}
