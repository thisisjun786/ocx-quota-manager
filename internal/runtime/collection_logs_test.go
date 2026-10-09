package runtime

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

func TestCollectionLogWriteFailureMarksCycleError(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1800000000000)}
	hist := openProbeStore(t)
	fake := &collect.Fake{}
	fake.SetHost("api.anthropic.com", transport.Response{Status: 200, Body: []byte(`{"five_hour":{"utilization":10}}`)}, nil)
	rt := New(clk, hist, fake)
	rt.Home = writeProbeHome(t, map[string]string{"anthropic": "synthetic-token"})
	rt.Direct = []string{"anthropic"}
	rt.sched.OnAttempt = func(collect.Attempt) error { return errors.New("write failed") }
	rt.cycle(context.Background())
	analytics, ok := rt.Snapshot().Analytics.(map[string]any)
	if !ok || analytics["status"] != "error" {
		t.Fatalf("log write failure hidden: %+v", rt.Snapshot().Analytics)
	}
}

func TestCollectionLogsPersistAttemptsNotCachedCycles(t *testing.T) {
	start := time.UnixMilli(1800000000000)
	clk := &clock.Var{T: start}
	hist := openProbeStore(t)
	fake := &collect.Fake{Responses: []transport.Response{
		{Status: 429, Headers: http.Header{"Retry-After": []string{"600"}}},
		{Status: 200, Body: []byte(`{"five_hour":{"utilization":10}}`)},
	}}
	rt := New(clk, hist, fake)
	rt.Home = writeProbeHome(t, map[string]string{"anthropic": "synthetic-token"})
	rt.Direct = []string{"anthropic"}
	rt.cycle(context.Background())
	clk.Set(start.Add(time.Minute))
	rt.cycle(context.Background())
	clk.Set(start.Add(10 * time.Minute))
	rt.cycle(context.Background())
	page, err := hist.ListCollectionLogs(store.CollectionLogQuery{Period: "1h", Now: clk.Now().UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Rows) != 2 || page.Rows[0].Result != "ok" || page.Rows[1].Result != "rate_limited" || page.Rows[1].HTTPStatus == nil || *page.Rows[1].HTTPStatus != 429 || page.Summary[0].Attempts != 2 || *page.Summary[0].RateLimitRate != 50 {
		t.Fatalf("runtime attempt history: %+v", page)
	}
}
