package store

import (
	"path/filepath"
	"testing"
	"time"
)

// TestRoundTripOldNewOldNew is the in-process Go Open loop only; it is not
// evidence that a Node writer and the Go binary can share one database.
func TestRoundTripOldNewOldNew(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2027, 1, 15, 8, 0, 0, 0, time.UTC).UnixMilli()
	a, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.InsertUsage(Usage{ID: "u1", At: now, Provider: "openai"}); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := b.InsertUsage(Usage{ID: "u2", At: now + 1000, Provider: "openai"}); err != nil {
		t.Fatal(err)
	}
	n, err := b.Count("usage")
	if err != nil || n < 2 {
		t.Fatalf("new write count=%d %v", n, err)
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	c, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	n, err = c.Count("usage")
	if err != nil || n < 2 {
		t.Fatalf("old reopen lost rows count=%d %v", n, err)
	}
	if err := c.InsertUsage(Usage{ID: "u2", At: now + 1000, Provider: "openai"}); err != nil {
		t.Fatal(err)
	}
	n2, _ := c.Count("usage")
	if n2 != n {
		t.Fatalf("duplicate insert changed count %d -> %d", n, n2)
	}
	if err := c.HasRequiredSchema(); err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	if _, err := Open(filepath.Join(dir, "missing-parent-will-create"), OpenOptions{}); err != nil {
		// Open mkdir's the directory; just prove a second writer is not opened on the first file.
		t.Fatal(err)
	}
}
