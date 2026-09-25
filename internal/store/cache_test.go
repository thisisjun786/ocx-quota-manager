package store

import (
	"testing"
)

func TestUsageCacheSeesInsertsUpdatesAndRawWrites(t *testing.T) {
	h := openTemp(t)
	acc := "a"
	if err := h.InsertUsage(Usage{ID: "u1", At: 2_000, Provider: "anthropic", Account: &acc, Input: fp(1), Output: fp(1), Cached: fp(0), Tokens: fp(2)}); err != nil {
		t.Fatal(err)
	}
	rows, err := h.ListUsage()
	if err != nil || len(rows) != 1 || rows[0].USD != nil {
		t.Fatalf("first read %v %+v", err, rows)
	}
	// Later insert with an earlier timestamp must be merged in time order.
	if err := h.InsertUsage(Usage{ID: "u0", At: 1_000, Provider: "anthropic", Account: &acc, Tokens: fp(1)}); err != nil {
		t.Fatal(err)
	}
	// Filling a missing price updates the existing row in place.
	if err := h.InsertUsage(Usage{ID: "u1", At: 2_000, Provider: "anthropic", Account: &acc, Input: fp(1), Output: fp(1), Cached: fp(0), Tokens: fp(2), USD: fp(3), Basis: strPtr("catalog")}); err != nil {
		t.Fatal(err)
	}
	rows, err = h.ListUsage()
	if err != nil || len(rows) != 2 || rows[0].ID != "u0" || rows[1].ID != "u1" || rows[1].USD == nil || *rows[1].USD != 3 {
		t.Fatalf("incremental read %v %+v", err, rows)
	}
	held := rows
	if _, err := h.DB().Exec("DELETE FROM usage WHERE id='u0'"); err != nil {
		t.Fatal(err)
	}
	rows, err = h.ListUsage()
	if err != nil || len(rows) != 1 || rows[0].ID != "u1" {
		t.Fatalf("after raw delete %v %+v", err, rows)
	}
	if len(held) != 2 || held[0].ID != "u0" {
		t.Fatalf("an earlier result changed under its holder: %+v", held)
	}
	// A valuation assumption changes every derived amount.
	if _, err := h.DB().Exec("INSERT INTO claude_cache_costs VALUES ('u1',2,5,10)"); err != nil {
		t.Fatal(err)
	}
	if err := h.SetMeta("claudeCacheAssumption", map[string]any{"ttl": "1h", "from": 0.0}); err != nil {
		t.Fatal(err)
	}
	rows, err = h.ListUsage()
	if err != nil || len(rows) != 1 || *rows[0].USD != 5 {
		t.Fatalf("after valuation meta %v %+v", err, rows)
	}
}

func TestObservationCacheAppendsAndResetsOnRetention(t *testing.T) {
	h := openTemp(t)
	day := int64(86_400_000)
	now := 400 * day
	for i, at := range []int64{now - 200*day, now - day} {
		if err := h.InsertObservation(Observation{Provider: "p", Account: "a", Window: "weekly", At: at, Basis: "ok", ObservedPercent: float64(i), LimitState: "missing", WindowSemantics: "fixed_reset", PrecisionEvidence: "unknown", Reconciliation: "unverified", UsedAccumulation: "unknown"}); err != nil {
			t.Fatal(err)
		}
		rows, err := h.ListObservations()
		if err != nil || len(rows) != i+1 {
			t.Fatalf("after insert %d: %v %d", i, err, len(rows))
		}
	}
	if err := h.Maintain(now); err != nil {
		t.Fatal(err)
	}
	rows, err := h.ListObservations()
	if err != nil || len(rows) != 1 || rows[0].At != now-day {
		t.Fatalf("after retention %v %+v", err, rows)
	}
}
