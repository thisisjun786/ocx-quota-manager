package store

import (
	"strings"
	"testing"
)

func TestEpochNumbersAreNeverReusedAfterRetention(t *testing.T) {
	h, err := Open(t.TempDir(), OpenOptions{RetentionDays: 31})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	day := int64(86400000)
	start := int64(1_800_000_000_000)
	first, err := h.OpenEpoch("openai", "acct", "native_account_id", nil, start, "initial")
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.OpenEpoch("openai", "acct", "native_account_id", nil, start+day, "replaced")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Maintain(start + 100*day); err != nil {
		t.Fatal(err)
	}
	var closed int
	if err := h.DB().QueryRow("SELECT count(*) FROM identity_epochs WHERE epoch=?", first).Scan(&closed); err != nil {
		t.Fatal(err)
	}
	if closed != 0 {
		t.Fatalf("retention kept the closed epoch row %d", first)
	}
	// Even with every epoch row gone, the next number continues the sequence.
	if _, err := h.DB().Exec("DELETE FROM identity_epochs"); err != nil {
		t.Fatal(err)
	}
	third, err := h.OpenEpoch("openai", "acct", "native_account_id", nil, start+101*day, "replaced")
	if err != nil {
		t.Fatal(err)
	}
	if third <= second {
		t.Fatalf("epochs first=%d second=%d third=%d: a number was reused", first, second, third)
	}
}

func TestEpochTableHoldsNoCredentialMaterial(t *testing.T) {
	h, err := Open(t.TempDir(), OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	digest := "sha256:3f5a"
	if _, err := h.OpenEpoch("anthropic", "acct", "credential_digest", &digest, 1_800_000_000_000, "initial"); err != nil {
		t.Fatal(err)
	}
	rows, err := h.DB().Query("SELECT * FROM identity_epochs")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		for i, v := range values {
			s, _ := v.(string)
			if strings.Contains(s, "sk-") || strings.Contains(strings.ToLower(cols[i]), "token") {
				t.Fatalf("epoch column %s holds %q", cols[i], s)
			}
		}
	}
}

func TestFailedMaintenanceLeavesEveryTableAndTheBoundaryUnchanged(t *testing.T) {
	h, err := Open(t.TempDir(), OpenOptions{RetentionDays: 31})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	day := int64(86400000)
	now := int64(1_800_000_000_000)
	old := now - 60*day
	if err := h.InsertUsage(Usage{ID: "old", At: old, Provider: "openai"}); err != nil {
		t.Fatal(err)
	}
	reset, used := old+day, 5.0
	if err := h.InsertSample(Sample{Provider: "openai", Account: "a", Window: "weekly", At: old, Reset: &reset, Used: &used}); err != nil {
		t.Fatal(err)
	}
	count := func(table string) int {
		var n int
		if err := h.DB().QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	boundary := func() string {
		var v string
		_ = h.DB().QueryRow("SELECT value FROM meta WHERE key='usageExcludedBefore'").Scan(&v)
		return v
	}
	usageBefore, samplesBefore, boundaryBefore := count("usage"), count("samples"), boundary()
	// ollama_observations is pruned after usage and samples, so its absence fails the pass mid-way.
	if _, err := h.DB().Exec("ALTER TABLE ollama_observations RENAME TO ollama_observations_gone"); err != nil {
		t.Fatal(err)
	}
	if err := h.Maintain(now); err == nil {
		t.Fatal("maintenance succeeded with a missing table")
	}
	if count("usage") != usageBefore || count("samples") != samplesBefore || boundary() != boundaryBefore {
		t.Fatalf("partial maintenance: usage %d->%d samples %d->%d boundary %q->%q",
			usageBefore, count("usage"), samplesBefore, count("samples"), boundaryBefore, boundary())
	}
}
