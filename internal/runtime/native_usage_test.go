package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func nativeRuntime(t *testing.T) (*Runtime, *store.History, *clock.Var) {
	t.Helper()
	clk := &clock.Var{T: time.UnixMilli(1800000000000).UTC()}
	h := openProbeStore(t)
	rt := New(clk, h, &collect.Fake{})
	rt.Home = t.TempDir()
	rt.ClaudeHome = t.TempDir()
	rt.CodexHome = t.TempDir()
	rt.GeminiHome = t.TempDir()
	rt.NativeEnabled = true
	return rt, h, clk
}

func addNativeTranscript(t *testing.T, rt *Runtime, id string, at int64) {
	t.Helper()
	dir := filepath.Join(rt.ClaudeHome, "projects", "project")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{"type": "assistant", "timestamp": time.UnixMilli(at).UTC().Format(time.RFC3339Nano), "requestId": "req_0123456789abcdef", "message": map[string]any{"id": id, "model": "claude-test", "usage": map[string]any{"input_tokens": 100, "output_tokens": 10}}})
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), append(data, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
}

func costRequests(t *testing.T, rt *Runtime) int {
	t.Helper()
	a, ok := rt.Snapshot().Analytics.(map[string]any)
	if !ok {
		t.Fatal("no analytics")
	}
	c, ok := a["costs"].(map[string]any)
	if !ok {
		t.Fatal("no costs", a)
	}
	return c["periods"].(map[string]any)["day"].(costPeriod).Total.Requests
}

// A Claude Code transcript collected after costs were settled adds nothing to
// costs; its direct evidence is reported once however often it is read.
func TestClaudeTranscriptAddsNoCostAcrossCycles(t *testing.T) {
	rt, h, clk := nativeRuntime(t)
	addNativeTranscript(t, rt, "msg_direct", clk.Now().UnixMilli()-1000)
	rt.cycle(context.Background())
	if n := costRequests(t, rt); n != 0 {
		t.Fatal("transcript added to costs", n)
	}
	first := rt.Snapshot().Warnings
	if len(first) != 1 || !strings.Contains(first[0], "req_") || !strings.Contains(first[0], "1건") {
		t.Fatal(first)
	}
	rt.cycle(context.Background())
	if n := costRequests(t, rt); n != 0 {
		t.Fatal("cycle added", n)
	}
	if again := rt.Snapshot().Warnings; len(again) != 1 || again[0] != first[0] {
		t.Fatal("notice repeated or changed", again)
	}
	rows, _ := h.ListUsage()
	if len(rows) != 0 {
		t.Fatal("quota rows polluted")
	}
	if _, ok := h.Meta("usageObservedThrough"); ok {
		t.Fatal("native scan fabricated OCX coverage")
	}
}

func TestNativeCostsAdvanceDuringOCXFailure(t *testing.T) {
	rt, h, clk := nativeRuntime(t)
	at := clk.Now().UnixMilli()
	writeUsageLog(t, rt.Home, []map[string]any{{"requestId": "ocx-only", "timestamp": at - 1000, "provider": "anthropic", "model": "claude-test", "usage": map[string]any{"inputTokens": 100, "outputTokens": 10}}})
	addNativeTranscript(t, rt, "msg_first", at-500)
	rt.cycle(context.Background())
	if n := costRequests(t, rt); n != 1 {
		t.Fatal(n)
	}
	boundary, _ := h.Meta("usageObservedThrough")
	if err := os.Remove(filepath.Join(rt.Home, "usage.jsonl")); err != nil {
		t.Fatal(err)
	}
	clk.T = clk.T.Add(time.Minute)
	addNativeTranscript(t, rt, "msg_after_outage", clk.Now().UnixMilli()-1000)
	rt.cycle(context.Background())
	if n := costRequests(t, rt); n != 1 {
		t.Fatal("transcript added to costs during the OCX outage", n)
	}
	if s := claudeNativeStatus(t, rt); s.UnsettledDirectNew != 2 {
		t.Fatal("collection froze with OCX", s.NativeSummary)
	}
	after, _ := h.Meta("usageObservedThrough")
	if after != boundary {
		t.Fatal("OCX clock advanced", boundary, after)
	}
	rows, _ := h.ListUsage()
	if len(rows) != 1 {
		t.Fatal("OCX rows changed")
	}
}

func TestCodexCostsOwnedByOCX(t *testing.T) {
	rt, h, clk := nativeRuntime(t)
	e := nativeusage.Event{ID: nativeusage.Hash("native"), Client: "codex", Provider: "openai", PriceProvider: "openai", Model: "gpt-test", At: clk.Now().UnixMilli() - 1000, Input: 100, Output: 10, Route: nativeusage.Unknown, Evidence: "route-unverified"}
	proxy := e
	proxy.ID = nativeusage.Hash("proxy")
	proxy.Route = nativeusage.Proxy
	direct := e
	direct.ID = nativeusage.Hash("old-direct")
	direct.Route = nativeusage.Direct
	if err := h.CommitNative("codex", nativeusage.Batch{Events: []nativeusage.Event{e, proxy, direct}}, clk.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	writeUsageLog(t, rt.Home, []map[string]any{{"requestId": "codex-via-ocx", "timestamp": clk.Now().UnixMilli() - 2000, "provider": "openai", "model": "gpt-test", "usage": map[string]any{"inputTokens": 100, "outputTokens": 10}}})
	local := filepath.Join(rt.CodexHome, "sessions")
	if err := os.MkdirAll(local, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(local, "ignored.jsonl"), []byte("malformed source deliberately not read\n"), 0600); err != nil {
		t.Fatal(err)
	}
	addNativeTranscript(t, rt, "msg_direct", clk.Now().UnixMilli()-500)
	rt.cycle(context.Background())
	if n := costRequests(t, rt); n != 1 {
		t.Fatal("Codex must be counted exactly once via OCX", n)
	}
	s := rt.Snapshot()
	for _, w := range s.Warnings {
		if strings.Contains(w, "Codex") {
			t.Fatal("redundant Codex warning", w)
		}
	}
	cursors, err := h.NativeCursors("codex")
	if err != nil || len(cursors) != 0 {
		t.Fatal("Codex local logs scanned", err)
	}
	v, err := h.NativeUsage()
	if err != nil || len(v.Rows) != 0 {
		t.Fatal("legacy Codex candidates entered native total", err)
	}
	if _, exists := v.Summary["codex"]; exists {
		t.Fatal("legacy duplicate cost summary")
	}
	var retained int
	if err := h.DB().QueryRow(`SELECT count(*) FROM native_usage WHERE client='codex'`).Scan(&retained); err != nil || retained != 3 {
		t.Fatal("legacy history must be retained", retained, err)
	}
	n := s.Analytics.(map[string]any)["nativeUsage"].(map[string]nativeStatus)["codex"]
	if n.Status != "via-ocx" || n.Pending != 0 || n.PendingUSD != nil {
		t.Fatal(n)
	}
	raw, _ := json.Marshal(s)
	if !json.Valid(raw) {
		t.Fatal("invalid snapshot")
	}
	if path := os.Getenv("QUOTA_NATIVE_SNAPSHOT"); path != "" {
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNativeCollectionSurvivesMalformedOCXConfig(t *testing.T) {
	rt, _, clk := nativeRuntime(t)
	if err := os.WriteFile(filepath.Join(rt.Home, "config.json"), []byte("{invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	addNativeTranscript(t, rt, "msg_native_despite_config", clk.Now().UnixMilli()-1000)
	rt.cycle(context.Background())
	if s := claudeNativeStatus(t, rt); s.UnsettledDirectNew != 1 {
		t.Fatal("native blocked by OCX config", s.NativeSummary)
	}
}

func TestNativeIncompleteTailDoesNotWarnOrClaimBackfill(t *testing.T) {
	rt, _, clk := nativeRuntime(t)
	addClaudeRecord(t, rt, "msg_complete", "", clk.Now().UnixMilli()-1000)
	path := filepath.Join(rt.ClaudeHome, "projects", "project", "msg_complete.jsonl")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString(`{"type":"assistant","message":`)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		rt.cycle(context.Background())
		s := rt.Snapshot()
		if len(s.Warnings) != 0 {
			t.Fatal("unfinished source displayed as a problem", s.Warnings)
		}
		n := s.Analytics.(map[string]any)["nativeUsage"].(map[string]nativeStatus)["claude"]
		// A record without a request ID is diagnosis only: counted, not warned.
		if n.Status != "ok" || n.PendingFiles != 0 || n.WaitingFiles != 1 || n.Pending != 1 {
			t.Fatal(n)
		}
	}
}

// A history written while transcripts still added to costs keeps those rows,
// with their stored amounts, in the period they belong to; later reads of the
// same transcripts and new direct records leave the totals alone.
func TestSettledClaudeCostsStayInTheirPeriod(t *testing.T) {
	clk := &clock.Var{T: time.Now().UTC()}
	dir := t.TempDir()
	h, err := store.Open(dir, store.OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	at := clk.Now().UnixMilli() - 3*3600000
	old := nativeusage.Event{ID: nativeusage.Hash("settled"), Client: "claude", Provider: "anthropic", PriceProvider: "anthropic", Model: "claude-test", At: at, Input: 100, Output: 10, Route: nativeusage.Direct, Evidence: "anthropic-request-header"}
	if err = h.CommitNative("claude", nativeusage.Batch{Events: []nativeusage.Event{old}}, at+1000); err != nil {
		t.Fatal(err)
	}
	// As the earlier release stored it: valued, then settled by the new one.
	if _, err = h.DB().Exec(`UPDATE native_usage SET usd=.001, basis='official'; DELETE FROM native_settled; DELETE FROM meta WHERE key=?`, store.NativeSettledKey); err != nil {
		t.Fatal(err)
	}
	h.Close()
	if h, err = store.Open(dir, store.OpenOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	rt := New(clk, h, &collect.Fake{})
	rt.Home, rt.ClaudeHome, rt.CodexHome, rt.GeminiHome = t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	rt.NativeEnabled = true
	writeUsageLog(t, rt.Home, []map[string]any{ocxNativeRow("ocx-00000000000000000000000000000001", at+1000)})
	for i := 0; i < 2; i++ {
		rt.cycle(context.Background())
		if n := costRequests(t, rt); n != 2 {
			t.Fatal("settled row plus the OCX row", n)
		}
		if w := rt.Snapshot().Warnings; len(w) != 0 {
			t.Fatal(w)
		}
	}
	addNativeTranscript(t, rt, "msg_new_direct", clk.Now().UnixMilli()-1000)
	rt.cycle(context.Background())
	if n := costRequests(t, rt); n != 2 {
		t.Fatal("new direct record added", n)
	}
	s := claudeNativeStatus(t, rt)
	// The test clock trails the settlement, so the record counts as read late.
	if s.Included != 1 || s.UnsettledDirectNew+s.UnsettledDirectPast != 1 || s.SettledAt == nil || len(rt.Snapshot().Warnings) != 1 {
		t.Fatal(s.NativeSummary, rt.Snapshot().Warnings)
	}
}
