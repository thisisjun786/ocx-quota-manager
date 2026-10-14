package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func TestBinaryHistoryLimit(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "quota-manager")
	if out, err := exec.Command("go", "build", "-o", exe, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	for _, tc := range []struct{ name, limit, want string }{
		{"smaller_than_existing", "1", "existing history exceeds the configured limit"},
		{"zero", "0", "QUOTA_DB_MAX_MIB"},
		{"negative", "-1", "QUOTA_DB_MAX_MIB"},
		{"malformed", "two", "QUOTA_DB_MAX_MIB"},
		{"fractional", "1.5", "QUOTA_DB_MAX_MIB"},
		{"overflow", "8796093022208", "QUOTA_DB_MAX_MIB"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := t.TempDir()
			h, err := store.Open(data, store.OpenOptions{MaxBytes: 4 << 20})
			if err != nil {
				t.Fatal(err)
			}
			payload := strings.Repeat("x", 2<<20)
			if _, err := h.DB().Exec("INSERT INTO meta(key,value) VALUES ('preserve',?)", payload); err != nil {
				t.Fatal(err)
			}
			if err := h.Close(); err != nil {
				t.Fatal(err)
			}
			home := t.TempDir()
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, exe)
			cmd.Env = []string{
				"PATH=" + os.Getenv("PATH"), "HOME=" + home,
				"OPENCODEX_HOME=" + home, "QUOTA_CODEX_HOME=" + home,
				"QUOTA_CLAUDE_HOME=" + home, "QUOTA_GEMINI_HOME=" + home,
				"QUOTA_DATA_DIR=" + data, "QUOTA_DB_MAX_MIB=" + tc.limit,
				"QUOTA_HOST=127.0.0.1", "QUOTA_PORT=19357",
				"QUOTA_DIRECT_PROVIDERS=", "QUOTA_NATIVE_USAGE=off", "QUOTA_PRICE_CATALOG=off",
			}
			out, err := cmd.CombinedOutput()
			if ctx.Err() != nil || err == nil || !strings.Contains(string(out), tc.want) {
				t.Fatalf("limit %q: err=%v deadline=%v output=%s", tc.limit, err, ctx.Err(), out)
			}
			h, err = store.Open(data, store.OpenOptions{MaxBytes: 4 << 20})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			var preserved string
			if err := h.DB().QueryRow("SELECT value FROM meta WHERE key='preserve'").Scan(&preserved); err != nil {
				t.Fatal(err)
			}
			if preserved != payload {
				t.Fatal("existing history changed on rejected startup")
			}
		})
	}
}

func TestHistoryOptionsSetsPageLimit(t *testing.T) {
	for _, tc := range []struct {
		raw string
		mib int64
	}{{"", 512}, {"1", 1}, {"2048", 2048}} {
		t.Run(tc.raw, func(t *testing.T) {
			options, err := historyOptions(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			h, err := store.Open(t.TempDir(), options)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			var pages, pageSize int64
			if err := h.DB().QueryRow("PRAGMA max_page_count").Scan(&pages); err != nil {
				t.Fatal(err)
			}
			if err := h.DB().QueryRow("PRAGMA page_size").Scan(&pageSize); err != nil {
				t.Fatal(err)
			}
			if pages*pageSize != tc.mib*(1<<20) {
				t.Fatalf("limit=%d bytes, want %d MiB", pages*pageSize, tc.mib)
			}
		})
	}
}
