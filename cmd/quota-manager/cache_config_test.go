package main

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"testing"
)

func TestClaudeCacheOverride(t *testing.T) {
	h, err := store.Open(t.TempDir(), store.OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err = configureClaudeCache(h, "1h", "2026-09-14T15:00:00Z"); err != nil {
		t.Fatal(err)
	}
	old, _ := h.Meta("claudeCacheAssumption")
	if err = configureClaudeCache(h, "", ""); err != nil {
		t.Fatal(err)
	}
	got, _ := h.Meta("claudeCacheAssumption")
	if got.(map[string]any)["from"] != old.(map[string]any)["from"] {
		t.Fatal("assumption lost")
	}
	for _, from := range []string{"", "2026-09-14T15:00:00", "yesterday"} {
		if configureClaudeCache(h, "1h", from) == nil {
			t.Fatal("accepted invalid cutoff", from)
		}
	}
	if configureClaudeCache(h, "bad", "") == nil {
		t.Fatal("accepted bad ttl")
	}
	if err = configureClaudeCache(h, "5m", ""); err != nil {
		t.Fatal(err)
	}
	got, _ = h.Meta("claudeCacheAssumption")
	if got != nil {
		t.Fatal("5m did not clear")
	}
}
