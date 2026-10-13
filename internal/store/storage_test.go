package store

import "testing"

func TestStorageUsageExcludesReusablePages(t *testing.T) {
	h, err := Open(t.TempDir(), OpenOptions{MaxBytes: 4 << 20})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if _, err = h.db.Exec("CREATE TABLE pressure(value BLOB); INSERT INTO pressure VALUES (zeroblob(2097152))"); err != nil {
		t.Fatal(err)
	}
	before, limit, err := h.StorageUsage()
	if err != nil || limit != 4<<20 || before < 2<<20 {
		t.Fatalf("before=%d limit=%d err=%v", before, limit, err)
	}
	if _, err = h.db.Exec("DELETE FROM pressure"); err != nil {
		t.Fatal(err)
	}
	after, _, err := h.StorageUsage()
	if err != nil {
		t.Fatal(err)
	}
	if before-after < 1<<20 {
		t.Fatalf("free pages still charged: before=%d after=%d", before, after)
	}
	h.Close()
	if _, _, err = h.StorageUsage(); err == nil {
		t.Fatal("closed database read reported success")
	}
}
