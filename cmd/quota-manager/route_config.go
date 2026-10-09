package main

import (
	"fmt"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

// configureClaudeRoute records the operator's cutover: from `from` (until
// `until`, exclusive) every direct Claude Code call carried a req_ request ID,
// so a transcript record without one was answered by OCX. An absent override
// preserves the persisted policy; "off" clears it.
func configureClaudeRoute(hist *store.History, from, until string) error {
	if from == "" {
		if until != "" {
			return fmt.Errorf("QUOTA_CLAUDE_OCX_UNTIL requires QUOTA_CLAUDE_OCX_FROM")
		}
		return nil
	}
	if from == "off" {
		return hist.SetMeta(store.ClaudeRoutePolicyKey, nil)
	}
	start, err := time.Parse(time.RFC3339Nano, from)
	if err != nil {
		return fmt.Errorf("QUOTA_CLAUDE_OCX_FROM must be an ISO timestamp with timezone")
	}
	var end any
	if until != "" {
		instant, err := time.Parse(time.RFC3339Nano, until)
		if err != nil {
			return fmt.Errorf("QUOTA_CLAUDE_OCX_UNTIL must be an ISO timestamp with timezone")
		}
		if instant.UnixMilli() <= start.UnixMilli() {
			return fmt.Errorf("QUOTA_CLAUDE_OCX_UNTIL must be later than QUOTA_CLAUDE_OCX_FROM")
		}
		end = instant.UnixMilli()
	}
	return hist.SetMeta(store.ClaudeRoutePolicyKey, map[string]any{"route": "ocx", "from": start.UnixMilli(), "until": end, "basis": "operator-cutover"})
}
