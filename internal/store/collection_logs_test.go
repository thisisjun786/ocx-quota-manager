package store

import (
	"database/sql"
	"math"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
)

func TestCollectionLogsFiltersPaginationRetentionAndReopen(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	now := int64(1800000000000)
	for i := 0; i < 102; i++ {
		result := "ok"
		if i == 0 {
			result = "rate_limited"
		}
		if err := h.InsertCollectionLog(collect.Attempt{StartedAt: now - 1000, Provider: "anthropic", Account: "a", Endpoint: "usage", Result: result, NextAttemptAt: now + 300000}); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.InsertCollectionLog(collect.Attempt{StartedAt: now - 31*86400000, Provider: "openai", Account: "b", Result: "ok"}); err != nil {
		t.Fatal(err)
	}
	page, err := h.ListCollectionLogs(CollectionLogQuery{Now: now, Result: "rate_limited"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Rows) != 1 || len(page.Summary) != 1 || page.Summary[0].Attempts != 102 || page.Summary[0].Successes != 101 || page.Summary[0].RateLimited != 1 || math.Abs(*page.Summary[0].RateLimitRate-100.0/102) > 1e-12 || page.NextBefore != nil {
		t.Fatalf("filtered denominator: %+v", page)
	}
	page, err = h.ListCollectionLogs(CollectionLogQuery{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Rows) != 100 || page.NextBefore == nil || len(page.Providers) != 1 || len(page.Accounts) != 1 {
		t.Fatalf("first page: %+v", page)
	}
	next, err := h.ListCollectionLogs(CollectionLogQuery{Now: now, Before: *page.NextBefore})
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Rows) != 2 || next.NextBefore != nil || next.Rows[0].ID >= page.Rows[99].ID {
		t.Fatalf("next page: %+v", next)
	}
	if err := h.Maintain(now); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h, err = Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	var count int
	if err := h.db.QueryRow(`SELECT count(*) FROM collection_logs`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 102 {
		t.Fatalf("retention/reopen count=%d", count)
	}
}

func TestCollectionLogsAddToExistingDatabaseWithoutLosingHistory(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	var oldSchema []string
	for _, statement := range strings.Split(schemaSQL, ";") {
		if !strings.Contains(statement, "collection_logs") {
			oldSchema = append(oldSchema, statement)
		}
	}
	if _, err := db.Exec(strings.Join(oldSchema, ";")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO meta VALUES ('migration-sentinel','preserved')`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err := h.InsertCollectionLog(collect.Attempt{Provider: "anthropic", Result: "ok"}); err != nil {
		t.Fatal(err)
	}
	var value string
	if err := h.db.QueryRow(`SELECT value FROM meta WHERE key='migration-sentinel'`).Scan(&value); err != nil || value != "preserved" {
		t.Fatalf("migration lost prior history: %q %v", value, err)
	}
}
