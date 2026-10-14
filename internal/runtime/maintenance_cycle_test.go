package runtime

import (
	"context"
	"errors"
	"fmt"
	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type maintenanceCycleStore struct {
	*store.History
	calls   int
	failure bool
}

func (s *maintenanceCycleStore) Maintain(now int64) error {
	s.calls++
	if s.failure {
		return errors.New("maintenancefailed")
	}
	return s.History.Maintain(now)
}
func TestCycleRunsMaintenanceAndReportsFailure(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1800000000000)}
	h := &maintenanceCycleStore{History: openProbeStore(t), failure: true}
	rt := New(clk, h, &collect.Fake{})
	rt.Home = writeProbeHome(t, nil)
	rt.cycle(context.Background())
	if h.calls != 1 || rt.Snapshot().Analytics.(map[string]any)["status"] != "error" {
		t.Fatal("maintenance failure hidden")
	}
	h.failure = false
	rt.cycle(context.Background())
	if h.calls != 2 || rt.Snapshot().Analytics.(map[string]any)["status"] != "ok" {
		t.Fatal("retry did not recover")
	}
	rt.cycle(context.Background())
	if h.calls != 2 {
		t.Fatal("maintenance reran every cycle")
	}
}

func TestFullHistoryRecoversThroughRetention(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	h := openProbeStore(t)
	// Expired diagnostic rows occupy pages that retention can safely reuse.
	for i := 0; i < 8; i++ {
		_, err := h.DB().Exec("INSERT INTO collection_logs(startedAt,provider,account,endpoint,result,durationMs,nextAttemptAt,failures) VALUES (?,?,?,?,?,0,0,0)", now.Add(-31*24*time.Hour).UnixMilli(), "test", "test", strings.Repeat("x", 65536), "ok")
		if err != nil {
			t.Fatal(err)
		}
	}
	var pages int64
	if err := h.DB().QueryRow("PRAGMA page_count").Scan(&pages); err != nil {
		t.Fatal(err)
	}
	if _, err := h.DB().Exec(fmt.Sprintf("PRAGMA max_page_count=%d", pages)); err != nil {
		t.Fatal(err)
	}
	home := writeProbeHome(t, nil)
	entry := fmt.Sprintf(`{"timestamp":%d,"requestId":"retention-recovery","provider":"test","model":"%s","usage":{"inputTokens":10,"outputTokens":2}}`+"\n", now.UnixMilli(), strings.Repeat("m", 65536))
	path := filepath.Join(home, "usage.jsonl")
	if err := os.WriteFile(path, []byte(entry), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.IngestJSONL(path, now.UnixMilli()); err == nil || !strings.Contains(err.Error(), "full") {
		t.Fatalf("expected SQLITE_FULL, got %v", err)
	}
	rt := New(clock.Fixed{T: now}, h, &collect.Fake{})
	rt.Home = home
	rt.cycle(context.Background())
	var logs int
	if err := h.DB().QueryRow("SELECT count(*) FROM collection_logs").Scan(&logs); err != nil {
		t.Fatal(err)
	}
	if logs != 0 {
		t.Fatalf("failed ingest prevented retention: %d expired rows remain", logs)
	}
	if rt.Snapshot().Analytics.(map[string]any)["status"] != "error" {
		t.Fatal("failed ingest was hidden")
	}
	rt.cycle(context.Background())
	if rt.Snapshot().Analytics.(map[string]any)["status"] != "ok" {
		t.Fatal("next cycle did not recover")
	}
	var count int
	if err := h.DB().QueryRow("SELECT count(*) FROM usage WHERE provider='test'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected one recovered usage row, got %d", count)
	}
}
