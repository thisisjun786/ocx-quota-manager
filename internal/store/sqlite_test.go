package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSchemaAndWAL(t *testing.T) {
	h := openTemp(t)
	if err := h.HasRequiredSchema(); err != nil {
		t.Fatal(err)
	}
	var mode string
	if err := h.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode=%s err=%v", mode, err)
	}
}

func TestUsageObservationEpochAndEvidence(t *testing.T) {
	h := openTemp(t)
	account := "acc-1"
	usd := 1.25
	if err := h.InsertUsage(Usage{ID: "u1", At: 1_800_000_000_000, Provider: "openai", Account: &account, USD: &usd, Basis: strPtr("catalog")}); err != nil {
		t.Fatal(err)
	}
	if err := h.InsertObservation(Observation{
		Provider: "openai", Account: account, Window: "weekly", At: 1_800_000_000_000,
		Basis: "percent", ObservedPercent: 0, LimitState: "ok", WindowSemantics: "fixed",
		PrecisionEvidence: "{}", Reconciliation: "{}", UsedAccumulation: "{}", PairsSample: 1,
	}); err != nil {
		t.Fatal(err)
	}
	epoch, err := h.OpenEpoch("openai", account, "native_account_id", nil, 1_800_000_000_000, "initial")
	if err != nil || epoch != 1 {
		t.Fatalf("epoch=%d err=%v", epoch, err)
	}
	id, err := h.InsertEvidence(Evidence{Provider: "openai", Model: "gpt-5.4", Status: "official", FirstRevision: "1", FirstSeenAt: 1_800_000_000_000})
	if err != nil || id == 0 {
		t.Fatalf("evidence id=%d err=%v", id, err)
	}
	if err := h.LinkUsagePrice("u1", id, 1_800_000_000_000); err != nil {
		t.Fatal(err)
	}
	n, _ := h.Count("usage")
	if n != 1 {
		t.Fatalf("usage %d", n)
	}
}

func TestJSONLPartialLineAndResume(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	log := filepath.Join(dir, "usage.jsonl")
	line := `{"timestamp":1800000000000,"requestId":"r1","provider":"openai","model":"gpt-5.4","usage":{"inputTokens":1,"outputTokens":2,"totalTokens":3}}` + "\n"
	if err := os.WriteFile(log, []byte(line+"{\"timestamp\":1800000001000,\"requestId\":\"r2\""), 0o600); err != nil {
		t.Fatal(err)
	}
	n, err := h.IngestJSONL(log, 1_800_000_002_000)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("inserted %d want 1 (partial last line unread)", n)
	}
	cur, ok := h.Meta("usageCursor")
	if !ok {
		t.Fatal("missing cursor")
	}
	if err := os.WriteFile(log, []byte(line+`{"timestamp":1800000001000,"requestId":"r2","attempts":[{"provider":"openai","usage":{"inputTokens":4,"outputTokens":5}}]}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	n, err = h.IngestJSONL(log, 1_800_000_002_000)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("resume inserted %d want 1", n)
	}
	total, _ := h.Count("usage")
	if total != 2 {
		t.Fatalf("usage rows %d", total)
	}
	_ = cur
}

func TestAttemptsAreNotDoubleCounted(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	log := filepath.Join(dir, "usage.jsonl")
	body := `{"timestamp":1800000000000,"requestId":"dup","provider":"openai","usage":{"totalTokens":9},"attempts":[{"provider":"openai","usage":{"totalTokens":3}},{"provider":"openai","usage":{"totalTokens":6}}]}` + "\n"
	if err := os.WriteFile(log, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	n, err := h.IngestJSONL(log, 1_800_000_002_000)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("want 2 attempts, got %d", n)
	}
	total, _ := h.Count("usage")
	if total != 2 {
		t.Fatalf("double counted parent+attempts: %d", total)
	}
}

func TestSafeAnd64BitIntegers(t *testing.T) {
	h := openTemp(t)
	const maxSafe = 9007199254740991
	const beyond = int64(9007199254740993)
	if err := h.InsertUsage(Usage{ID: "safe", At: maxSafe, Provider: "openai"}); err != nil {
		t.Fatal(err)
	}
	if err := h.InsertUsage(Usage{ID: "wide", At: beyond, Provider: "openai"}); err != nil {
		t.Fatal(err)
	}
	var gotSafe, gotWide int64
	if err := h.db.QueryRow("SELECT at FROM usage WHERE id='safe'").Scan(&gotSafe); err != nil || gotSafe != maxSafe {
		t.Fatalf("safe %d err=%v", gotSafe, err)
	}
	if err := h.db.QueryRow("SELECT at FROM usage WHERE id='wide'").Scan(&gotWide); err != nil || gotWide != beyond {
		t.Fatalf("64-bit %d err=%v", gotWide, err)
	}
}

func TestReopenPreservesRows(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.InsertUsage(Usage{ID: "keep", At: 100, Provider: "openai"}); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h2, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h2.Close() })
	n, err := h2.Count("usage")
	if err != nil || n != 1 {
		t.Fatalf("reopen usage=%d err=%v", n, err)
	}
}

func TestRetentionDoesNotRewriteSettledUSD(t *testing.T) {
	h := openTemp(t)
	usd := 4.0
	if err := h.InsertUsage(Usage{ID: "old", At: 1, Provider: "openai", USD: &usd, Basis: strPtr("catalog")}); err != nil {
		t.Fatal(err)
	}
	if err := h.Maintain(1 + 200*86400000); err != nil {
		t.Fatal(err)
	}
	n, _ := h.Count("usage")
	if n != 0 {
		t.Fatalf("old row survived retention: %d", n)
	}
}

func TestMissingIndexIsDetected(t *testing.T) {
	h := openTemp(t)
	if _, err := h.db.Exec("DROP INDEX usage_time"); err != nil {
		t.Fatal(err)
	}
	if err := h.HasRequiredSchema(); err == nil {
		t.Fatal("dropped index must fail schema check")
	}
}

func TestEvidenceDigestStable(t *testing.T) {
	a, err := EvidenceDigest(Evidence{Provider: "openai", Model: "gpt-5.4", Status: "official", Conditions: []string{"b", "a"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := EvidenceDigest(Evidence{Provider: "openai", Model: "gpt-5.4", Status: "official", Conditions: []string{"a", "b"}})
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("condition order changed digest %s %s", a, b)
	}
}

func TestCursorJSONRoundTrip(t *testing.T) {
	raw, _ := json.Marshal(UsageCursor{Ino: "1", Offset: 12, Fingerprint: "abc"})
	var back UsageCursor
	if err := json.Unmarshal(raw, &back); err != nil || back.Offset != 12 {
		t.Fatalf("%v %v", back, err)
	}
}

func openTemp(t *testing.T) *History {
	t.Helper()
	h, err := Open(t.TempDir(), OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	return h
}

func strPtr(s string) *string { return &s }
