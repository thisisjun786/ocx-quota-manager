package collect

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

func TestSchedulerHonorsLongProviderRetryAfter(t *testing.T) {
	start := time.UnixMilli(1800000000000)
	for _, header := range []string{"3600", start.Add(time.Hour).UTC().Format(http.TimeFormat)} {
		t.Run(header, func(t *testing.T) {
			clk := &clock.Var{T: start}
			fake := &Fake{Responses: []transport.Response{{Status: 429, Headers: http.Header{"Retry-After": []string{header}}}}}
			s := NewScheduler(clk, fake)
			var attempt Attempt
			s.OnAttempt = func(a Attempt) error { attempt = a; return nil }
			b := Binding{Provider: "anthropic", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
			s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
			clk.Set(start.Add(31 * time.Minute))
			s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
			if fake.CallCount() != 1 || attempt.RetryAfterMs == nil || *attempt.RetryAfterMs != 3600000 || attempt.NextAttemptAt != start.Add(time.Hour).UnixMilli() {
				t.Fatalf("provider cooldown shortened: calls=%d attempt=%+v", fake.CallCount(), attempt)
			}
		})
	}
}

func TestSchedulerRestoreUsesNewestLegacyCredentialOutcome(t *testing.T) {
	start := time.UnixMilli(1800000000000)
	newer := Outcome{Provider: "anthropic", Account: "a", Endpoint: "oauth-usage", Status: "ok", LastAttemptAt: start.UnixMilli(), NextAttemptAt: start.Add(5 * time.Minute).UnixMilli()}
	older := newer
	older.LastAttemptAt = start.Add(-time.Hour).UnixMilli()
	older.NextAttemptAt = start.Add(-55 * time.Minute).UnixMilli()
	clk := &clock.Var{T: start}
	fake := &Fake{}
	s := NewScheduler(clk, fake)
	s.Restore([]Outcome{newer, older})
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if fake.CallCount() != 0 || len(s.Outcomes()) != 1 || s.Outcomes()[0].LastAttemptAt != newer.LastAttemptAt {
		t.Fatalf("stale outcome replaced current cadence: calls=%d outcomes=%+v", fake.CallCount(), s.Outcomes())
	}
}

func TestSchedulerCountsInvalidResponsesAsConsecutiveFailures(t *testing.T) {
	start := time.UnixMilli(1800000000000)
	clk := &clock.Var{T: start}
	fake := &Fake{Responses: []transport.Response{{Status: 200, Body: []byte(`not-json`)}}}
	s := NewScheduler(clk, fake)
	var attempt Attempt
	s.OnAttempt = func(a Attempt) error { attempt = a; return nil }
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	clk.Set(start.Add(5 * time.Minute))
	s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if attempt.Result != "invalid_json" || attempt.Failures != 2 || attempt.NextAttemptAt != start.Add(15*time.Minute).UnixMilli() {
		t.Fatalf("invalid response failure count: %+v", attempt)
	}
}

func TestSchedulerReplacementCredentialRecoversAfterNormalCadence(t *testing.T) {
	for _, restart := range []bool{false, true} {
		start := time.UnixMilli(1800000000000)
		clk := &clock.Var{T: start}
		fake := &Fake{Responses: []transport.Response{{Status: 401}, {Status: 200, Body: []byte(`{"five_hour":{"utilization":10}}`)}}}
		s := NewScheduler(clk, fake)
		b := Binding{Provider: "anthropic", AccountID: "a", Token: "expired", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
		s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
		if restart {
			prior := s.Outcomes()
			s = NewScheduler(clk, fake)
			s.Restore(prior)
		}
		b.Token = "replacement"
		clk.Set(start.Add(time.Minute))
		s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
		if fake.CallCount() != 1 {
			t.Fatal("replacement bypassed normal cadence")
		}
		clk.Set(start.Add(5 * time.Minute))
		s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
		if fake.CallCount() != 2 || s.Outcomes()[0].Status != "ok" {
			t.Fatalf("replacement inherited auth cooldown, restart=%v: %+v", restart, s.Outcomes())
		}
	}
}
