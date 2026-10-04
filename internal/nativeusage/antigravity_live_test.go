package nativeusage

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Explicitly opt in: this probe prints counts and hashed paths, never source values.
func TestAntigravityLiveMetadataProbe(t *testing.T) {
	if os.Getenv("QUOTA_AGY_PROBE") != "1" {
		t.Skip("opt-in metadata probe")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal("home unavailable")
	}
	files, total, invalidTotal, failed := 0, 0, 0, 0
	for _, root := range []string{"antigravity-cli", "antigravity"} {
		paths, err := filepath.Glob(filepath.Join(home, ".gemini", root, "conversations", "*.db"))
		if err != nil {
			t.Fatal("glob failed")
		}
		for _, path := range paths {
			files++
			events, invalid, readErr := ReadAntigravityWithDiagnostics(context.Background(), path)
			total += len(events)
			invalidTotal += invalid
			if readErr == nil && len(events) > 0 {
				continue
			}
			if readErr != nil {
				failed++
			}
			category := "no-usage"
			if readErr != nil {
				category = "read-error"
			}
			for _, c := range []string{"no generation with usage", "timestamp", "read limits", "protobuf", "singular field", "overflow"} {
				if readErr != nil && strings.Contains(readErr.Error(), c) {
					category = c
					break
				}
			}
			uri := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
			db, err := sql.Open("sqlite", uri.String())
			if err != nil {
				t.Logf("id=%s category=%s", Hash(path), category)
				continue
			}
			rows, err := db.Query("SELECT idx,data FROM gen_metadata WHERE length(data) <= ? LIMIT ?", agMaxBlob, agMaxRows)
			counts := map[string]int{"rows": 0, "empty_blob": 0, "zero_tokens": 0, "response": 0, "generation_time": 0, "parse_error": 0}
			if err == nil {
				for rows.Next() {
					var idx int64
					var blob []byte
					if rows.Scan(&idx, &blob) != nil {
						break
					}
					counts["rows"]++
					top, _ := agDecode(blob)
					chat, _ := top.message(1)
					usage, _ := chat.message(4)
					gen, _ := chat.message(9)
					for n := range top {
						counts[fmt.Sprintf("top_field_%d", n)]++
					}
					for n := range chat {
						counts[fmt.Sprintf("chat_field_%d", n)]++
					}
					for n := range usage {
						counts[fmt.Sprintf("usage_field_%d", n)]++
					}
					for n, f := range gen {
						counts[fmt.Sprintf("gen_field_%d_wire_%d", n, f.wire)]++
					}
					if len(blob) == 0 {
						counts["empty_blob"]++
					}
					g, e := agParseGeneration(idx, blob)
					if e != nil {
						counts["parse_error"]++
						continue
					}
					if g.event.Input == 0 && g.event.Output == 0 && g.event.CacheRead == 0 {
						counts["zero_tokens"]++
					}
					if g.response != "" {
						counts["response"]++
					}
					if g.event.At != 0 {
						counts["generation_time"]++
					}
				}
				rows.Close()
			}
			tx := mustAGProbeTx(t, db)
			times, e := agReadSteps(context.Background(), tx, &agBudget{})
			tx.Rollback()
			responseTimes, indexTimes, stepErrors := len(times.responses), len(times.indices), 0
			if e != nil {
				stepErrors = 1
			}
			db.Close()
			t.Logf("id=%s category=%s included=%d invalid=%d counts=%v response_times=%d index_times=%d step_errors=%d", Hash(path), category, len(events), invalid, counts, responseTimes, indexTimes, stepErrors)
		}
	}
	t.Logf("files=%d included=%d invalid=%d failed=%d", files, total, invalidTotal, failed)
}
func mustAGProbeTx(t *testing.T, db *sql.DB) *sql.Tx {
	t.Helper()
	tx, e := db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if e != nil {
		t.Fatal("metadata transaction failed")
	}
	t.Cleanup(func() { tx.Rollback() })
	return tx
}
