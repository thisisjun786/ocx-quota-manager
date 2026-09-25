package collect

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

func TestSchedulerRejectsRedirectWithShapedBody(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1_800_000_000_000).UTC()}
	fake := &Fake{Responses: []transport.Response{
		{Status: 200, Body: []byte(`{"five_hour":{"utilization":10}}`)},
		{Status: 302, Headers: http.Header{"Location": []string{"https://example.invalid"}}, Body: []byte(`{"five_hour":{"utilization":90}}`)},
	}}
	s := NewScheduler(clk, fake)
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	first := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if len(first) != 1 || first[0].UsedPercent == nil || *first[0].UsedPercent != 10 {
		t.Fatalf("seed %+v", first)
	}
	clk.T = clk.T.Add(3 * time.Minute)
	second := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	failed := false
	kpt := false
	for _, row := range second {
		if row.Kind == WindowFailed {
			failed = true
		}
		if row.UsedPercent != nil && *row.UsedPercent == 90 {
			t.Fatal("redirect body became a reading")
		}
		if row.UsedPercent != nil && *row.UsedPercent == 10 {
			kpt = true
		}
	}
	if !failed || !kpt {
		t.Fatalf("302 must fail and keep last good: %+v", second)
	}
}

func TestSchedulerCapsPercentAbove100(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1_800_000_000_000).UTC()}
	fake := &Fake{Responses: []transport.Response{{Status: 200, Body: []byte(`{"five_hour":{"utilization":125}}`)}}}
	s := NewScheduler(clk, fake)
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	rows := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if len(rows) != 1 || rows[0].UsedPercent == nil || *rows[0].UsedPercent != 100 {
		t.Fatalf("125 must cap at 100: %+v", rows)
	}
	if rows[0].RemainingPercent == nil || *rows[0].RemainingPercent != 0 {
		t.Fatalf("capped used leaves remaining 0: %+v", rows[0].RemainingPercent)
	}
}

func collectAt(s *Scheduler, clk *clock.Var, at time.Time, b Binding) []Reading {
	clk.Set(at)
	return s.Collect(context.Background(), []Binding{b}, []string{b.Provider})
}

// Repeated failures back off further each time instead of retrying every two
// minutes forever; one success returns to the normal poll interval.
func TestSchedulerFailureBackoffGrowsAndResets(t *testing.T) {
	start := time.UnixMilli(1_800_000_000_000).UTC()
	clk := &clock.Var{T: start}
	fake := &Fake{}
	fake.SetHost("api.anthropic.com", transport.Response{Status: 500, Body: []byte(`{}`)}, nil)
	s := NewScheduler(clk, fake)
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	calls := func() int { return fake.CallCount() }
	collectAt(s, clk, start, b)
	collectAt(s, clk, start.Add(2*time.Minute+time.Second), b)
	if calls() != 2 {
		t.Fatalf("second attempt after the first cooldown: %d calls", calls())
	}
	// The third attempt must wait longer than the base two minutes.
	collectAt(s, clk, start.Add(4*time.Minute+2*time.Second), b)
	if calls() != 2 {
		t.Fatalf("backoff did not grow after two failures: %d calls", calls())
	}
	collectAt(s, clk, start.Add(7*time.Minute), b)
	if calls() != 3 {
		t.Fatalf("grown backoff never expired: %d calls", calls())
	}
	fake.SetHost("api.anthropic.com", transport.Response{Status: 200, Body: []byte(`{"five_hour":{"utilization":10}}`)}, nil)
	collectAt(s, clk, start.Add(20*time.Minute), b)
	collectAt(s, clk, start.Add(22*time.Minute+time.Second), b)
	if calls() != 5 {
		t.Fatalf("success must reset to the base interval: %d calls", calls())
	}
}

// A rejected credential is not asked again every poll.
func TestSchedulerUnauthorizedCoolsDownLong(t *testing.T) {
	start := time.UnixMilli(1_800_000_000_000).UTC()
	clk := &clock.Var{T: start}
	fake := &Fake{}
	fake.SetHost("api.anthropic.com", transport.Response{Status: 401, Body: []byte(`{}`)}, nil)
	s := NewScheduler(clk, fake)
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	collectAt(s, clk, start, b)
	collectAt(s, clk, start.Add(5*time.Minute), b)
	if fake.CallCount() != 1 {
		t.Fatalf("401 retried after 5 minutes: %d calls", fake.CallCount())
	}
	collectAt(s, clk, start.Add(31*time.Minute), b)
	if fake.CallCount() != 2 {
		t.Fatalf("401 cooldown never expired: %d calls", fake.CallCount())
	}
}

// A transport error returns no body; it must be classified as a failure, not
// scanned for the credential first.
func TestSchedulerTransportErrorIsFailure(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1_800_000_000_000).UTC()}
	fake := &Fake{}
	fake.SetHost("api.anthropic.com", transport.Response{}, errors.New("dial"))
	s := NewScheduler(clk, fake)
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	b.Token = "synthetic"
	rows := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if len(rows) != 1 || rows[0].Kind != WindowFailed {
		t.Fatalf("transport error must be a failed reading: %+v", rows)
	}
}

// A refused credential stays cooled down across a restart.
func TestSchedulerRestoreKeepsBackoff(t *testing.T) {
	start := time.UnixMilli(1_800_000_000_000).UTC()
	clk := &clock.Var{T: start}
	fake := &Fake{}
	fake.SetHost("api.anthropic.com", transport.Response{Status: 401, Body: []byte(`{}`)}, nil)
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	first := NewScheduler(clk, fake)
	collectAt(first, clk, start, b)
	saved := first.Outcomes()
	if len(saved) != 1 || saved[0].Status != "unauthorized" || saved[0].Failures != 1 {
		t.Fatalf("outcome not recorded: %+v", saved)
	}
	second := NewScheduler(clk, fake)
	second.Restore(saved)
	collectAt(second, clk, start.Add(5*time.Minute), b)
	if fake.CallCount() != 1 {
		t.Fatalf("restart retried a refused credential: %d calls", fake.CallCount())
	}
	if got := second.Outcomes(); len(got) != 1 || got[0].Status != "unauthorized" {
		t.Fatalf("restored status lost: %+v", got)
	}
}
