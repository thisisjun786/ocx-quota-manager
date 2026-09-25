package runtime

import (
	"context"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

func TestLastGoodSurvivesFailure(t *testing.T) {
	clk := clock.Fixed{T: time.Date(2027, 1, 15, 8, 0, 0, 0, time.UTC)}
	fake := &collect.Fake{Responses: []transport.Response{{
		Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":10,"limit_window_seconds":604800}}}`),
	}}}
	rt := New(clk, nil, fake)
	rt.Direct = []string{"openai"}
	rt.Home = t.TempDir()
	first := rt.Snapshot()
	if first.SchemaVersion != 1 || first.Providers == nil {
		t.Fatalf("%+v", first)
	}
	rt.markFailure()
	after := rt.Snapshot()
	if after.ObservedAt == nil || *after.ObservedAt != *first.ObservedAt {
		t.Fatal("observedAt must stay")
	}
	if !contains(after.Warnings, failureNote) {
		t.Fatalf("warnings %v", after.Warnings)
	}
}

func TestShutdownBounded(t *testing.T) {
	rt := New(clock.System{}, nil, &collect.Fake{})
	ctx, cancel := context.WithCancel(context.Background())
	rt.Start(ctx)
	cancel()
	done := make(chan error, 1)
	go func() {
		c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		done <- rt.Close(c)
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("close exceeded deadline")
	}
}

func TestSingleFlightPoll(t *testing.T) {
	fake := &collect.Fake{Delay: 80 * time.Millisecond, Responses: []transport.Response{{Status: 200, Body: []byte(`{}`)}}}
	rt := New(clock.System{}, nil, fake)
	rt.Direct = []string{"openai"}
	ctx := context.Background()
	go rt.cycle(ctx)
	time.Sleep(10 * time.Millisecond)
	rt.cycle(ctx)
}

func TestRestartKeepsBootDTO(t *testing.T) {
	rt := New(clock.System{}, nil, &collect.Fake{})
	a := rt.Snapshot()
	if a.SchemaVersion != 1 || len(a.Providers) != 0 {
		t.Fatalf("%+v", a)
	}
}
