package store

import (
	"testing"
)

func TestRetentionUsesOneCutoffAndKeepsReferencedPrices(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{RetentionDays: 31})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	now := int64(40 * 86400000)
	cutoff := now - 31*86400000
	oldAt := cutoff - 1
	keepAt := cutoff
	usd := 1.5
	if err := h.InsertUsage(Usage{ID: "old-use", At: oldAt, Provider: "openai", USD: &usd}); err != nil {
		t.Fatal(err)
	}
	if err := h.InsertUsage(Usage{ID: "keep-use", At: keepAt, Provider: "anthropic", USD: &usd}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec("INSERT INTO usage_timings(id,durationMs,firstOutputMs,tokensReported) VALUES ('old-use',1,1,1),('keep-use',1,1,1)"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec("INSERT INTO cursor_cache_costs(id,noCacheUsd,fullCacheUsd,eligibleInputTokens) VALUES ('old-use',1,1,1)"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec("INSERT INTO claude_cache_costs(id,fiveMinuteUsd,oneHourUsd,cacheWriteTokens) VALUES ('keep-use',1,2,3)"); err != nil {
		t.Fatal(err)
	}
	oldUsed, keepUsed := 1.0, 2.0
	if err := h.InsertSample(Sample{Provider: "openai", Account: "a", Window: "weekly", At: oldAt, Used: &oldUsed}); err != nil {
		t.Fatal(err)
	}
	if err := h.InsertSample(Sample{Provider: "openai", Account: "a", Window: "weekly", At: keepAt, Used: &keepUsed}); err != nil {
		t.Fatal(err)
	}
	if err := h.InsertObservation(Observation{Provider: "openai", Account: "a", Window: "weekly", At: oldAt, Basis: "ok", ObservedPercent: 1, LimitState: "missing", WindowSemantics: "fixed_reset", PrecisionEvidence: "unknown", Reconciliation: "unverified", UsedAccumulation: "unknown"}); err != nil {
		t.Fatal(err)
	}
	if err := h.InsertObservation(Observation{Provider: "openai", Account: "a", Window: "weekly", At: keepAt, Basis: "ok", ObservedPercent: 2, LimitState: "missing", WindowSemantics: "fixed_reset", PrecisionEvidence: "unknown", Reconciliation: "unverified", UsedAccumulation: "unknown"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec("INSERT INTO ollama_observations(source,at,payload) VALUES ('local',?,'old'),('local',?,'keep')", oldAt, keepAt); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec("INSERT INTO identity_epochs(provider,account,epoch,basis,startedAt,endedAt,reason) VALUES ('openai','a',1,'ok',1,?, 'rotated'),('openai','b',1,'ok',1,NULL,'open'),('anthropic','c',1,'ok',1,?,'fresh')", oldAt, keepAt); err != nil {
		t.Fatal(err)
	}
	oldEv, err := h.InsertEvidence(Evidence{Provider: "openai", Model: "old", Status: "official", Rates: [4]*float64{&usd}, Conditions: []string{}, Unsupported: []string{}, FirstRevision: "1", FirstSeenAt: oldAt})
	if err != nil {
		t.Fatal(err)
	}
	keepEv, err := h.InsertEvidence(Evidence{Provider: "anthropic", Model: "keep", Status: "official", Rates: [4]*float64{&usd}, Conditions: []string{}, Unsupported: []string{}, FirstRevision: "1", FirstSeenAt: keepAt})
	if err != nil {
		t.Fatal(err)
	}
	// A second account's price stays only because a retained usage row points at it.
	// The expired row's price must leave with that row, not with a future reset.
	if err := h.LinkUsagePrice("old-use", oldEv, oldAt); err != nil {
		t.Fatal(err)
	}
	if err := h.LinkUsagePrice("keep-use", keepEv, keepAt); err != nil {
		t.Fatal(err)
	}
	if err := h.Maintain(now); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"usage", "samples", "quota_observations", "ollama_observations"} {
		var n int
		if err := h.db.QueryRow("SELECT COUNT(*) FROM "+table+" WHERE at<?", cutoff).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s rows before cutoff: %d err=%v", table, n, err)
		}
		if err := h.db.QueryRow("SELECT COUNT(*) FROM "+table+" WHERE at>=?", cutoff).Scan(&n); err != nil || n != 1 {
			t.Fatalf("%s kept rows: %d err=%v", table, n, err)
		}
	}
	var timings int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM usage_timings WHERE id='old-use'").Scan(&timings); err != nil || timings != 0 {
		t.Fatalf("expired timing %d", timings)
	}
	if err := h.db.QueryRow("SELECT COUNT(*) FROM usage_timings WHERE id='keep-use'").Scan(&timings); err != nil || timings != 1 {
		t.Fatalf("kept timing %d", timings)
	}
	var side int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM cursor_cache_costs").Scan(&side); err != nil || side != 0 {
		t.Fatalf("expired cursor sidecar %d", side)
	}
	if err := h.db.QueryRow("SELECT COUNT(*) FROM claude_cache_costs").Scan(&side); err != nil || side != 1 {
		t.Fatalf("kept claude sidecar %d", side)
	}
	var epochs int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM identity_epochs").Scan(&epochs); err != nil || epochs != 2 {
		t.Fatalf("epochs %d, closed-before-cutoff must go and the open epoch must stay", epochs)
	}
	var prices, links int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM price_evidence").Scan(&prices); err != nil || prices != 1 {
		t.Fatalf("price evidence %d, referenced row must stay and the unreferenced one must go", prices)
	}
	if err := h.db.QueryRow("SELECT COUNT(*) FROM usage_prices WHERE id='keep-use'").Scan(&links); err != nil || links != 1 {
		t.Fatalf("kept link %d", links)
	}
	excluded, ok := h.Meta("usageExcludedBefore")
	if !ok || int64(excluded.(float64)) != cutoff {
		t.Fatalf("excluded boundary %v", excluded)
	}
}

func TestRetentionBoundaryDoesNotMoveBackward(t *testing.T) {
	h := openTemp(t)
	resetAt := int64(50 * 86400000)
	if err := h.SetMeta("historyResetAt", resetAt); err != nil {
		t.Fatal(err)
	}
	now := int64(200 * 86400000)
	if err := h.Maintain(now); err != nil {
		t.Fatal(err)
	}
	forward := now - 90*86400000
	got, ok := h.Meta("usageExcludedBefore")
	if !ok || int64(got.(float64)) != forward {
		t.Fatalf("forward boundary %v", got)
	}
	// A clock reset must not declare previously excluded history readable again.
	if err := h.Maintain(now - 40*86400000); err != nil {
		t.Fatal(err)
	}
	got, ok = h.Meta("usageExcludedBefore")
	if !ok || int64(got.(float64)) != forward {
		t.Fatalf("boundary moved backward to %v", got)
	}
	reset, ok := h.Meta("historyResetAt")
	if !ok || int64(reset.(float64)) != resetAt {
		t.Fatalf("historyResetAt changed: %v", reset)
	}
}

// Fresh evidence has no usage link until ingest prices a row. Retention before
// that ingest deletes it; retention after the link exists keeps it.
func TestFreshEvidenceSurvivesWhenLinkedBeforeRetention(t *testing.T) {
	h := openTemp(t)
	now := int64(100 * 86400000)
	usd := 2.0
	id, err := h.InsertEvidence(Evidence{Provider: "openai", Model: "gpt-5.4", Status: "official", Rates: [4]*float64{&usd}, Conditions: []string{}, Unsupported: []string{}, FirstRevision: "1", FirstSeenAt: now})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.InsertUsage(Usage{ID: "fresh", At: now - 3600_000, Provider: "openai", USD: &usd}); err != nil {
		t.Fatal(err)
	}
	if err := h.LinkUsagePrice("fresh", id, now); err != nil {
		t.Fatal(err)
	}
	if err := h.Maintain(now); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM price_evidence WHERE id=?", id).Scan(&n); err != nil || n != 1 {
		t.Fatalf("linked fresh evidence deleted: %d err=%v", n, err)
	}
}
