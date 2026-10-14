package main

import (
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/runtime"
)

func TestCollectInterval(t *testing.T) {
	for raw, want := range map[string]time.Duration{"": runtime.DefaultInterval, "10s": 10 * time.Second, "1m": time.Minute, "5m": 5 * time.Minute} {
		if got, err := collectInterval(raw); err != nil || got != want {
			t.Fatalf("%q: %v %v", raw, got, err)
		}
	}
	for _, raw := range []string{"9s", "6m", "30", "15.5s", "-30s", "soon"} {
		if _, err := collectInterval(raw); err == nil {
			t.Fatalf("%q accepted", raw)
		}
	}
}
