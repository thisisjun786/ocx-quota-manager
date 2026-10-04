package nativeusage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const nativeAt = "2026-10-04T07:00:00Z"

func claudeLine(id, request string, output int64) []byte {
	b, _ := json.Marshal(map[string]any{"type": "assistant", "timestamp": nativeAt, "requestId": request, "message": map[string]any{"id": id, "model": "claude-test", "usage": map[string]any{"input_tokens": 10, "output_tokens": output, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20, "cache_creation": map[string]any{"ephemeral_1h_input_tokens": 15}}}})
	return append(b, '\n')
}

func TestScanFailuresCannotStarveHealthyFiles(t *testing.T) {
	path, db := agTestDB(t)
	agTestInsert(t, db, 0, agTestGeneration(agTestUsage("healthy-response"), "gemini-test", "", 1791097200))
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	old := time.Unix(1791097200, 0)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(path)
	for i := 0; i < filesPerBatch; i++ {
		bad := filepath.Join(dir, fmt.Sprintf("bad-%03d.db", i))
		if err := os.WriteFile(bad, []byte("not a database"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	source := Source{Client: "antigravity", Roots: []string{dir}}
	first, err := Scan(context.Background(), source, nil, 0, 1800000000000)
	if err != nil || first.Failed != filesPerBatch || len(first.Events) != 0 {
		t.Fatal(first, err)
	}
	for _, c := range first.Cursors {
		if c.Offset != 0 {
			t.Fatal("failed file advanced")
		}
	}
	second, err := Scan(context.Background(), source, first.Cursors, 0, 1800000001000)
	if err != nil || len(second.Events) != 1 {
		t.Fatal("healthy file starved", second, err)
	}
}

func TestClaudeRouteAndTokenSemantics(t *testing.T) {
	for _, tc := range []struct {
		id    string
		route Route
	}{{"req_0123456789abcdef", Direct}, {"ocx-123", Proxy}, {"", Unknown}, {"req_short", Unknown}} {
		got := ParseLine("claude", claudeLine("msg_test", tc.id, 5), &State{})
		if got.Invalid || got.Event == nil {
			t.Fatalf("parse %+v", got)
		}
		e := got.Event
		if e.Route != tc.route || e.Input != 130 || e.CacheRead != 100 || e.CacheWrite != 20 || e.CacheWrite1h != 15 || e.Output != 5 {
			t.Fatalf("%+v", e)
		}
	}
	if !ParseLine("claude", claudeLine("msg_bad", "req_0123456789abcdef", -1), &State{}).Invalid {
		t.Fatal("negative output accepted")
	}
	if got := ParseLine("claude", []byte(`{"type":"user","message":{"content":"do not retain"}}`), &State{}); got.Event != nil || got.Invalid {
		t.Fatal(got)
	}
}

func codexLine(total, last Counts) []byte {
	b, _ := json.Marshal(map[string]any{"type": "event_msg", "timestamp": nativeAt, "payload": map[string]any{"type": "token_count", "info": map[string]any{"total_token_usage": total, "last_token_usage": last}}})
	return b
}

func TestCodexNotificationsCumulativeAndUnknownRouting(t *testing.T) {
	state := State{Session: Hash("s"), Turn: Hash("t"), Model: "gpt-test"}
	a := Counts{Input: 100, Output: 20, Cached: 50}
	first := ParseLine("codex", codexLine(a, a), &state)
	if first.Event == nil || first.Event.Route != Unknown || first.Event.Input != 100 {
		t.Fatal(first)
	}
	if repeat := ParseLine("codex", codexLine(a, a), &state); repeat.Event != nil {
		t.Fatal("notification counted twice")
	}
	b := Counts{Input: 180, Output: 30, Cached: 90}
	next := ParseLine("codex", codexLine(b, Counts{Input: 999}), &state)
	if next.Event == nil || next.Event.Input != 80 || next.Event.Output != 10 || next.Event.CacheRead != 40 {
		t.Fatal(next)
	}
	reset := ParseLine("codex", codexLine(Counts{Input: 10, Output: 2}, Counts{Input: 10, Output: 2}), &state)
	if reset.Event == nil || reset.Event.Input != 10 {
		t.Fatal("reset lost", reset)
	}
	copyState := State{Session: Hash("copy"), Turn: Hash("t"), Model: "gpt-test"}
	copy := ParseLine("codex", codexLine(a, a), &copyState)
	if copy.Event.ID != first.Event.ID {
		t.Fatal("fork replay identity depends on path/session")
	}
}

func TestScanPartialReplayCopyAndReplacement(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.jsonl")
	line := claudeLine("msg_1", "req_0123456789abcdef", 5)
	if err := os.WriteFile(path, line[:len(line)-1], 0600); err != nil {
		t.Fatal(err)
	}
	source := Source{Client: "claude", Roots: []string{dir}}
	now := time.Date(2026, 10, 4, 8, 0, 0, 0, time.UTC).UnixMilli()
	b, err := Scan(context.Background(), source, nil, 0, now)
	if err != nil || len(b.Events) != 0 {
		t.Fatal(b, err)
	}
	if err = os.WriteFile(path, line, 0600); err != nil {
		t.Fatal(err)
	}
	b, err = Scan(context.Background(), source, b.Cursors, 0, now)
	if err != nil || len(b.Events) != 1 {
		t.Fatal(b, err)
	}
	seen := b.Events[0].ID
	cur := b.Cursors
	b, err = Scan(context.Background(), source, cur, 0, now)
	if err != nil || len(b.Events) != 0 || b.Files != 0 {
		t.Fatal("unchanged rescan", b, err)
	}
	if err = os.WriteFile(filepath.Join(dir, "copy.jsonl"), line, 0600); err != nil {
		t.Fatal(err)
	}
	b, err = Scan(context.Background(), source, cur, 0, now)
	if err != nil || len(b.Events) != 1 || b.Events[0].ID != seen {
		t.Fatal("copy identity", b, err)
	}
	if err = os.WriteFile(path, claudeLine("msg_2", "req_0123456789abcdef", 6), 0600); err != nil {
		t.Fatal(err)
	}
	b, err = Scan(context.Background(), source, cur, 0, now)
	if err != nil || len(b.Events) != 2 {
		t.Fatal("replacement", b, err)
	}
	if _, err = Scan(context.Background(), source, nil, now, now); err != nil {
		t.Fatal(err)
	}
}

func TestScanAtomicReplacementWithPreservedSizeAndTime(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.jsonl")
	if err := os.WriteFile(path, claudeLine("msg_1", "req_0123456789abcdef", 5), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	source := Source{Client: "claude", Roots: []string{dir}}
	first, err := Scan(context.Background(), source, nil, 0, 1800000000000)
	if err != nil || len(first.Events) != 1 {
		t.Fatal(first, err)
	}
	replacement := filepath.Join(dir, "new")
	if err = os.WriteFile(replacement, claudeLine("msg_2", "req_0123456789abcdef", 5), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(replacement, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	second, err := Scan(context.Background(), source, first.Cursors, 0, 1800000001000)
	if err != nil || len(second.Events) != 1 || second.Events[0].ID == first.Events[0].ID {
		t.Fatal("replacement hidden by stat equality", second, err)
	}
}

func TestIncompleteTailIsWaitingForSourceNotBackfill(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "partial.jsonl")
	complete := claudeLine("msg_before", "req_0123456789abcdef", 5)
	next := claudeLine("msg_after", "req_0123456789abcdef", 8)
	if err := os.WriteFile(path, append(append([]byte{}, complete...), next[:len(next)/2]...), 0600); err != nil {
		t.Fatal(err)
	}
	source := Source{Client: "claude", Roots: []string{dir}}
	first, err := Scan(context.Background(), source, nil, 0, 1800000000000)
	if err != nil || len(first.Events) != 1 || first.Pending != 0 {
		t.Fatal("partial tail reported as backfill", first, err)
	}
	second, err := Scan(context.Background(), source, first.Cursors, 0, 1800000001000)
	if err != nil || len(second.Events) != 0 || second.Files != 0 || second.Pending != 0 {
		t.Fatal("unchanged tail read repeatedly", second, err)
	}
	if err = os.WriteFile(path, append(append([]byte{}, complete...), next...), 0600); err != nil {
		t.Fatal(err)
	}
	third, err := Scan(context.Background(), source, first.Cursors, 0, 1800000002000)
	if err != nil || len(third.Events) != 1 || third.Events[0].ID == first.Events[0].ID || third.Pending != 0 {
		t.Fatal("completed tail lost or duplicated", third, err)
	}
}
