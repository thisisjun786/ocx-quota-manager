package nativeusage

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func agTestVar(field, value uint64) []byte {
	b := binary.AppendUvarint(nil, field<<3)
	return binary.AppendUvarint(b, value)
}
func agTestBytes(field uint64, value []byte) []byte {
	b := binary.AppendUvarint(nil, field<<3|2)
	b = binary.AppendUvarint(b, uint64(len(value)))
	return append(b, value...)
}
func agTestJoin(parts ...[]byte) []byte { return bytes.Join(parts, nil) }
func agTestStamp(seconds uint64) []byte {
	return agTestJoin(agTestVar(1, seconds), agTestVar(2, 123000000))
}
func agTestUsage(response string) []byte {
	return agTestJoin(agTestVar(1, 10), agTestVar(2, 20), agTestVar(5, 40), agTestVar(9, 50), agTestVar(10, 60), agTestBytes(11, []byte(response)))
}
func agTestGeneration(usage []byte, model, label string, seconds uint64) []byte {
	chat := agTestJoin(agTestBytes(4, usage), agTestBytes(19, []byte(model)), agTestBytes(21, []byte(label)))
	if seconds > 0 {
		chat = append(chat, agTestBytes(9, agTestBytes(4, agTestStamp(seconds)))...)
	}
	return agTestBytes(1, chat)
}
func agTestDB(t *testing.T) (string, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "conversation.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, query := range []string{"CREATE TABLE gen_metadata (idx integer, data blob)", "CREATE TABLE steps (idx integer, step_type integer, metadata blob)"} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	return path, db
}
func agTestInsert(t *testing.T, db *sql.DB, idx int, blob []byte) {
	t.Helper()
	if _, err := db.Exec("INSERT INTO gen_metadata (idx,data) VALUES (?,?)", idx, blob); err != nil {
		t.Fatal(err)
	}
}
func agTestInsertStep(t *testing.T, db *sql.DB, response string, genIndex int, seconds uint64) {
	t.Helper()
	metadata := agTestJoin(agTestBytes(1, agTestStamp(seconds)), agTestBytes(9, agTestBytes(11, []byte(response))))
	if genIndex >= 0 {
		metadata = append(metadata, agTestBytes(20, agTestVar(3, uint64(genIndex)))...)
	}
	if _, err := db.Exec("INSERT INTO steps (idx,step_type,metadata) VALUES (0,15,?)", metadata); err != nil {
		t.Fatal(err)
	}
}

func TestAntigravityRevisionReplaysUnchangedFileOnce(t *testing.T) {
	path, db := agTestDB(t)
	agTestInsert(t, db, 0, agTestGeneration(agTestUsage("revision"), "gemini-test", "", 1700000000))
	source := Source{Client: "antigravity", Roots: []string{filepath.Dir(path)}}
	now := int64(1700000001000)
	b, err := Scan(context.Background(), source, nil, 0, now)
	if err != nil || len(b.Events) != 1 {
		t.Fatal(b, err)
	}
	key := Hash("antigravity", path)
	legacy := b.Cursors[key]
	legacy.Revision = 1
	b, err = Scan(context.Background(), source, map[string]Cursor{key: legacy}, 0, now+1)
	if err != nil || len(b.Events) != 1 || b.Events[0].Input != 60 || b.Events[0].ModelEnum != 10 || b.Events[0].ParserRevision != AntigravityRevision || b.Cursors[key].Revision != AntigravityRevision {
		t.Fatal(b, err)
	}
	replay, err := Scan(context.Background(), source, b.Cursors, 0, now+2)
	if err != nil || replay.Files != 0 || len(replay.Events) != 0 {
		t.Fatal("unchanged replay", replay, err)
	}
}

func TestAntigravityMalformedAndOverflow(t *testing.T) {
	cases := map[string][]byte{
		"truncated":          {0x0a, 0x05, 0x01},
		"tag-zero":           {0},
		"overflow-varint":    agTestBytes(1, agTestBytes(4, append([]byte{8}, bytes.Repeat([]byte{0xff}, 11)...))),
		"counter-overflow":   agTestGeneration(agTestJoin(agTestVar(2, math.MaxUint64), agTestBytes(11, []byte("response"))), "gemini-test", "", 1700000000),
		"sum-overflow":       agTestGeneration(agTestJoin(agTestVar(2, uint64(MaxTokens)), agTestVar(5, 1), agTestBytes(11, []byte("response"))), "gemini-test", "", 1700000000),
		"output-overflow":    agTestGeneration(agTestJoin(agTestVar(9, uint64(MaxTokens)), agTestVar(10, 1), agTestBytes(11, []byte("response"))), "gemini-test", "", 1700000000),
		"wrong-wire":         agTestGeneration(agTestBytes(2, []byte("10")), "gemini-test", "", 1700000000),
		"timestamp-overflow": agTestGeneration(agTestUsage("response"), "gemini-test", "", math.MaxUint64),
		"blob-limit":         bytes.Repeat([]byte{0}, agMaxBlob+1),
	}
	for name, blob := range cases {
		t.Run(name, func(t *testing.T) {
			path, db := agTestDB(t)
			agTestInsert(t, db, 0, blob)
			events, err := ReadAntigravity(context.Background(), path)
			if err == nil || len(events) != 0 {
				t.Fatalf("got events=%v error=%v", events, err)
			}
		})
	}
}

func TestAntigravityMissingTimeAndIdentity(t *testing.T) {
	for _, missing := range []string{"time", "identity", "usage", "empty-protobuf"} {
		t.Run(missing, func(t *testing.T) {
			path, db := agTestDB(t)
			response, seconds := "response", uint64(1700000000)
			if missing == "time" {
				seconds = 0
			}
			if missing == "identity" {
				response = ""
			}
			usage := agTestUsage(response)
			if missing == "usage" {
				usage = agTestBytes(11, []byte(response))
			}
			blob := agTestGeneration(usage, "gemini-test", "", seconds)
			if missing == "empty-protobuf" {
				blob = []byte{}
			}
			agTestInsert(t, db, 0, blob)
			events, err := ReadAntigravity(context.Background(), path)
			if err == nil || len(events) != 0 {
				t.Fatalf("missing %s got %v, %v", missing, events, err)
			}
		})
	}
	// Missing-time rows must also be omitted in a supported database.
	path, db := agTestDB(t)
	agTestInsert(t, db, 0, agTestGeneration(agTestUsage("missing"), "gemini-test", "", 0))
	agTestInsert(t, db, 1, agTestGeneration(agTestUsage("good"), "gemini-test", "", 1700000000))
	events, err := ReadAntigravity(context.Background(), path)
	if err != nil || len(events) != 1 || events[0].ID != Hash("native-v1", "antigravity", "good") {
		t.Fatalf("%v %v", events, err)
	}
}

func TestAntigravityUnsupportedAndCanceled(t *testing.T) {
	path, db := agTestDB(t)
	if _, err := db.Exec("DROP TABLE gen_metadata"); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadAntigravity(context.Background(), path); err == nil {
		t.Fatal("absent generation table accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ReadAntigravity(ctx, path); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected canceled: %v", err)
	}
	missing := filepath.Join(t.TempDir(), "missing.db")
	if _, err := ReadAntigravity(context.Background(), missing); err == nil {
		t.Fatal("missing database accepted")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("source database created: %v", err)
	}
}

func TestAntigravityGenerationAndCopyDedupReadOnly(t *testing.T) {
	path, db := agTestDB(t)
	blob := agTestGeneration(agTestUsage("same-response"), "gemini-test", "Display name", 1700000000)
	agTestInsert(t, db, 0, blob)
	agTestInsert(t, db, 1, blob)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0444); err != nil {
		t.Fatal(err)
	}
	events, err := ReadAntigravity(context.Background(), path)
	if err != nil || len(events) != 1 {
		t.Fatalf("%v %v", events, err)
	}
	e := events[0]
	if e.Input != 60 || e.CacheRead != 40 || e.Output != 110 || e.At != 1700000000123 || e.Model != "gemini-test" || e.PriceProvider != "google" || e.Provider != "antigravity" || e.Client != "antigravity" || e.Route != Direct || e.Evidence != "antigravity-generation" || !e.Valid() {
		t.Fatalf("incorrect event: %+v", e)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("source database changed")
	}
	copyPath := filepath.Join(t.TempDir(), "renamed.db")
	if err := os.WriteFile(copyPath, before, 0444); err != nil {
		t.Fatal(err)
	}
	copied, err := ReadAntigravity(context.Background(), copyPath)
	if err != nil || len(copied) != 1 || copied[0].ID != e.ID {
		t.Fatalf("copy dedup: %v %v", copied, err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("unexpected source sidecars: %v", entries)
	}
}

func TestAntigravityModernStepTimestampAndWAL(t *testing.T) {
	path, db := agTestDB(t)
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("PRAGMA wal_autocheckpoint=0"); err != nil {
		t.Fatal(err)
	}
	// Modern generation #9.#10 is opaque cache metadata, never a usage date.
	blob := agTestGeneration(agTestUsage("response-match"), "claude-test", "", 0)
	top, err := agDecode(blob)
	if err != nil {
		t.Fatal(err)
	}
	chat := append([]byte(nil), top[1].bytes...)
	chat = append(chat, agTestBytes(9, agTestBytes(10, []byte("opaque cache metadata")))...)
	agTestInsert(t, db, 3, agTestBytes(1, chat))
	agTestInsert(t, db, 7, agTestGeneration(agTestUsage("index-match"), "claude-test", "", 0))
	agTestInsertStep(t, db, "response-match", -1, 1700000001)
	agTestInsertStep(t, db, "", 7, 1700000002)
	// A response-ID match takes precedence over a differing index-only date.
	agTestInsertStep(t, db, "", 3, 1700000003)
	before, err := os.ReadFile(path + "-wal")
	if err != nil {
		t.Fatal(err)
	}
	events, err := ReadAntigravity(context.Background(), path)
	if err != nil || len(events) != 2 {
		t.Fatalf("%v %v", events, err)
	}
	if events[0].At != 1700000001123 || events[1].At != 1700000002123 || events[0].PriceProvider != "anthropic" {
		t.Fatalf("wrong dates/provider: %v", events)
	}
	after, err := os.ReadFile(path + "-wal")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("source WAL changed")
	}
}

func TestAntigravityLabelRecovery(t *testing.T) {
	for _, ambiguous := range []bool{false, true} {
		t.Run(map[bool]string{false: "unique", true: "ambiguous"}[ambiguous], func(t *testing.T) {
			path, db := agTestDB(t)
			agTestInsert(t, db, 0, agTestGeneration(agTestUsage("known"), "gemini-test", "Shared label", 1700000000))
			agTestInsert(t, db, 1, agTestGeneration(agTestUsage("unknown"), "", "Shared label", 1700000001))
			if ambiguous {
				agTestInsert(t, db, 2, agTestGeneration(agTestUsage("other"), "claude-test", "Shared label", 1700000002))
			}
			events, err := ReadAntigravity(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			expected := "gemini-test"
			if ambiguous {
				expected = "unknown"
			}
			if len(events) < 2 || events[1].Model != expected {
				t.Fatalf("got %v expected %s", events, expected)
			}
		})
	}
	// A display label on its own is never treated as a model identifier.
	path, db := agTestDB(t)
	agTestInsert(t, db, 0, agTestGeneration(agTestUsage("alone"), "", "gemini-test", 1700000000))
	events, err := ReadAntigravity(context.Background(), path)
	if err != nil || len(events) != 1 || events[0].Model != "unknown" {
		t.Fatalf("%v %v", events, err)
	}
}

func TestAntigravityMetadataLimits(t *testing.T) {
	for _, kind := range []string{"rows", "bytes", "step-blob"} {
		t.Run(kind, func(t *testing.T) {
			path, db := agTestDB(t)
			switch kind {
			case "rows":
				_, err := db.Exec("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < ?) INSERT INTO gen_metadata SELECT x, x'0a00' FROM n", agMaxRows)
				if err != nil {
					t.Fatal(err)
				}
			case "bytes":
				_, err := db.Exec("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < 32) INSERT INTO gen_metadata SELECT x, zeroblob(?) FROM n", agMaxBlob)
				if err != nil {
					t.Fatal(err)
				}
			case "step-blob":
				_, err := db.Exec("INSERT INTO steps VALUES (0,15,zeroblob(?))", agMaxBlob+1)
				if err != nil {
					t.Fatal(err)
				}
			}
			if events, err := ReadAntigravity(context.Background(), path); err == nil || len(events) != 0 {
				t.Fatalf("limit accepted %v %v", events, err)
			}
		})
	}
}

func TestAntigravityPartialDiagnostics(t *testing.T) {
	path, db := agTestDB(t)
	agTestInsert(t, db, 0, agTestGeneration(agTestUsage("good"), "gemini-test", "", 1700000000))
	agTestInsert(t, db, 1, agTestGeneration(agTestUsage("missing-time"), "gemini-test", "", 0))
	agTestInsert(t, db, 2, agTestGeneration(agTestUsage(""), "gemini-test", "", 1700000000))
	agTestInsert(t, db, 3, []byte{})
	agTestInsert(t, db, 4, agTestGeneration(agTestUsage("good"), "gemini-test", "", 1700000000))
	events, invalid, err := ReadAntigravityWithDiagnostics(context.Background(), path)
	if err != nil || len(events) != 1 || invalid != 3 {
		t.Fatalf("events=%v invalid=%d err=%v", events, invalid, err)
	}
}

func TestAntigravityDuplicateResponsePreservesDifferingObservations(t *testing.T) {
	path, db := agTestDB(t)
	first := agTestGeneration(agTestUsage("shared-response"), "gemini-test", "", 1700000000)
	strongerUsage := agTestJoin(agTestVar(1, 20), agTestVar(2, 30), agTestVar(5, 50), agTestVar(9, 70), agTestVar(10, 80), agTestBytes(11, []byte("shared-response")))
	stronger := agTestGeneration(strongerUsage, "gemini-test", "", 1700000000)
	conflictUsage := agTestJoin(agTestVar(1, 5), agTestVar(2, 15), agTestVar(5, 30), agTestVar(9, 100), agTestVar(10, 100), agTestBytes(11, []byte("shared-response")))
	conflict := agTestGeneration(conflictUsage, "gemini-test", "", 1700000000)
	agTestInsert(t, db, 0, first)
	agTestInsert(t, db, 1, stronger)
	agTestInsert(t, db, 2, conflict)
	agTestInsert(t, db, 3, stronger)
	events, invalid, err := ReadAntigravityWithDiagnostics(context.Background(), path)
	if err != nil || invalid != 0 || len(events) != 3 {
		t.Fatalf("events=%v invalid=%d err=%v", events, invalid, err)
	}
	expectedInput := []int64{60, 80, 45}
	expectedOutput := []int64{110, 150, 200}
	for i, e := range events {
		if e.ID != events[0].ID || e.Input != expectedInput[i] || e.Output != expectedOutput[i] || !e.Valid() {
			t.Fatalf("observation %d: %+v", i, e)
		}
	}
}

func TestAntigravityModelOnlyMetadataIsNotUsage(t *testing.T) {
	path, db := agTestDB(t)
	agTestInsert(t, db, 0, agTestGeneration(agTestVar(1, 42), "", "", 0))
	events, invalid, err := ReadAntigravityWithDiagnostics(context.Background(), path)
	if err != nil || invalid != 0 || len(events) != 0 {
		t.Fatalf("model-only: included=%d invalid=%d error=%v", len(events), invalid, err)
	}
	// A model enum is not a token counter, including with real usage.
	agTestInsert(t, db, 1, agTestGeneration(agTestJoin(agTestVar(1, 42), agTestVar(2, 20), agTestBytes(11, []byte("completed"))), "gemini-test", "", 1700000000))
	events, invalid, err = ReadAntigravityWithDiagnostics(context.Background(), path)
	if err != nil || invalid != 0 || len(events) != 1 || events[0].Input != 20 {
		t.Fatalf("completed: events=%v invalid=%d error=%v", events, invalid, err)
	}
	// Real usage with missing identity remains invalid alongside the good row.
	agTestInsert(t, db, 2, agTestGeneration(agTestVar(2, 20), "gemini-test", "", 1700000000))
	events, invalid, err = ReadAntigravityWithDiagnostics(context.Background(), path)
	if err != nil || invalid != 1 || len(events) != 1 {
		t.Fatalf("mixed: included=%d invalid=%d error=%v", len(events), invalid, err)
	}
}
