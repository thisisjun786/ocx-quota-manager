package runtime

import (
	"context"
	"errors"
	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
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
