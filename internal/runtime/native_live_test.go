package runtime

import (
	"context"
	"encoding/json"
	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"os"
	"testing"
	"time"
)

// Explicit opt-in: reads local metadata only and writes an isolated temporary
// database. Normal tests never read a developer's history or call a provider.
func TestNativeLocalMetadataProbe(t *testing.T) {
	if os.Getenv("QUOTA_NATIVE_PROBE") != "1" {
		t.Skip("explicit local metadata probe")
	}
	data := t.TempDir()
	h, err := store.Open(data, store.OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	rt := New(clock.System{}, h, &collect.Fake{})
	if path := os.Getenv("QUOTA_PROBE_CATALOG"); path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		catalog, err := store.ParseCatalog(raw)
		if err != nil {
			t.Fatal(err)
		}
		h.SetCatalog(catalog)
	}
	rt.NativeEnabled = true
	rt.ClaudeHome = os.Getenv("QUOTA_PROBE_CLAUDE_HOME")
	rt.CodexHome = os.Getenv("QUOTA_PROBE_CODEX_HOME")
	rt.GeminiHome = os.Getenv("QUOTA_PROBE_GEMINI_HOME")
	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		status, _ := rt.collectNative(context.Background(), now.Add(time.Duration(i)*time.Second))
		raw, _ := json.Marshal(status)
		t.Logf("pass %d: %s", i+1, raw)
	}
	view, err := h.NativeUsage()
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Rows) == 0 {
		t.Fatal("no native records collected")
	}
	cur, err := h.NativeCursors("claude")
	if err != nil {
		t.Fatal(err)
	}
	if len(cur) == 0 {
		t.Fatal("no incremental cursors")
	}
	rows, err := h.ListUsage()
	if err != nil || len(rows) != 0 {
		t.Fatal("OCX table changed", err)
	}
	t.Logf("included=%d source_count=%d legacy_rows=%d", len(view.Rows), len(view.Summary), len(rows))
}
