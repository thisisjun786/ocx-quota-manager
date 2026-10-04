package store

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
)

// Opt-in rehearsal: only a temporary copy of the supplied SQLite backup is
// modified. Source conversations are read-only; output contains aggregate counts.
func TestAntigravityCopiedLedgerCorrection(t *testing.T) {
	backup := os.Getenv("QUOTA_NATIVE_REPLAY_BACKUP")
	if backup == "" {
		t.Skip("opt-in copied database rehearsal")
	}
	dir := t.TempDir()
	in, err := os.Open(backup)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.Create(filepath.Join(dir, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(out, in)
	closeErr := out.Close()
	if err != nil || closeErr != nil {
		t.Fatal(err, closeErr)
	}
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	read := func() map[string]nativeusage.Event {
		t.Helper()
		rows, err := h.db.Query(`SELECT event FROM native_usage WHERE client='antigravity'`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		result := map[string]nativeusage.Event{}
		for rows.Next() {
			var raw string
			var e nativeusage.Event
			if err := rows.Scan(&raw); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(raw), &e); err != nil {
				t.Fatal(err)
			}
			result[e.ID] = e
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := read()
	ocxBefore, err := h.ListUsage()
	if err != nil {
		t.Fatal(err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	source := nativeusage.Source{Client: "antigravity", Roots: []string{filepath.Join(home, ".gemini/antigravity-cli/conversations"), filepath.Join(home, ".gemini/antigravity/conversations")}}
	now := time.Now().UnixMilli()
	var batches []nativeusage.Batch
	for i := 0; i < 100; i++ {
		cursors, err := h.NativeCursors("antigravity")
		if err != nil {
			t.Fatal(err)
		}
		b, err := nativeusage.Scan(context.Background(), source, cursors, h.NativeCutoff(now), now+int64(i))
		if err != nil || b.Invalid != 0 || b.Failed != 0 {
			t.Fatalf("scan invalid=%d failed=%d err=%v", b.Invalid, b.Failed, err)
		}
		if err := h.CommitNative("antigravity", b, now); err != nil {
			t.Fatal(err)
		}
		batches = append(batches, b)
		if b.Pending == 0 {
			break
		}
		if i == 99 {
			t.Fatal("backfill did not finish")
		}
	}
	after := read()
	corrected := 0
	var removed int64
	for id, old := range before {
		e, ok := after[id]
		if !ok {
			t.Fatal("history disappeared")
		}
		if old.ParserRevision >= nativeusage.AntigravityRevision {
			continue
		}
		want := old
		want.Input -= e.ModelEnum
		want.ModelEnum, want.ParserRevision = e.ModelEnum, nativeusage.AntigravityRevision
		if !reflect.DeepEqual(e, want) {
			t.Fatal("historical correction mismatch")
		}
		corrected++
		removed += e.ModelEnum
	}
	if corrected == 0 {
		t.Fatal("no legacy rows exercised")
	}
	// Force replay of identical source observations, bypassing cursor short-circuit.
	for _, b := range batches {
		if err := h.CommitNative("antigravity", b, now); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(after, read()) {
		t.Fatal("replay changed ledger")
	}
	ocxAfter, err := h.ListUsage()
	if err != nil || !reflect.DeepEqual(ocxBefore, ocxAfter) {
		t.Fatal("OCX rows changed", err)
	}
	var integrity string
	if err := h.db.QueryRow(`PRAGMA integrity_check`).Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatal(integrity, err)
	}
	t.Logf("legacy=%d corrected=%d after=%d removedEnumTokens=%d ocxRowsUnchanged=%d batches=%d integrity=%s", len(before), corrected, len(after), removed, len(ocxAfter), len(batches), integrity)
}
