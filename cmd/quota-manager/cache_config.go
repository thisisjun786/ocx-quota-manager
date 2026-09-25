package main

import (
	"fmt"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"time"
)

// An absent override preserves the persisted assumption during a runtime swap.
func configureClaudeCache(hist *store.History, ttl, from string) error {
	if ttl == "" {
		return nil
	}
	if ttl == "5m" {
		return hist.SetMeta("claudeCacheAssumption", nil)
	}
	if ttl != "1h" {
		return fmt.Errorf("QUOTA_CLAUDE_CACHE_TTL must be 5m or 1h")
	}
	instant, err := time.Parse(time.RFC3339Nano, from)
	if err != nil {
		return fmt.Errorf("QUOTA_CLAUDE_CACHE_FROM must be an ISO timestamp with timezone")
	}
	return hist.SetMeta("claudeCacheAssumption", map[string]any{"ttl": "1h", "from": instant.UnixMilli(), "basis": "user-assumption"})
}
