package collect

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

const ollamaBalanceFixture = `{"included":{
	"session":{"remaining_percent":72.5,"resets_at":"2026-10-07T23:00:00Z"},
	"weekly":{"remaining_percent":40.0,"resets_at":"2026-10-12T00:00:00Z"}
},"purchased":{"balance_usd":9.75}}`

func TestParseOllamaBalanceParsesIncludedWindows(t *testing.T) {
	now := int64(1800000000000)
	rows, err := parseOllama([]byte(ollamaBalanceFixture), now)
	if err != nil || len(rows) != 2 {
		t.Fatalf("rows %d err %v", len(rows), err)
	}
	s := rows[0]
	if s.Provider != "ollama-cloud" || s.Endpoint != "balance" || s.WindowID != "five-hour" || s.Label != "5시간" {
		t.Fatalf("session row %+v", s)
	}
	if s.RemainingPercent == nil || math.Abs(*s.RemainingPercent-72.5) > 1e-9 {
		t.Fatalf("remaining %+v", s.RemainingPercent)
	}
	if s.UsedPercent == nil || math.Abs(*s.UsedPercent-27.5) > 1e-9 {
		t.Fatalf("used %+v", s.UsedPercent)
	}
	if s.Fraction == nil || math.Abs(*s.Fraction-0.275) > 1e-12 {
		t.Fatalf("fraction %+v", s.Fraction)
	}
	wantReset := time.Date(2026, 10, 7, 23, 0, 0, 0, time.UTC).UnixMilli()
	if s.ResetAt == nil || *s.ResetAt != wantReset {
		t.Fatalf("reset %+v", s.ResetAt)
	}
	if s.Kind != WindowOK || s.ObservedAt != now {
		t.Fatalf("row kind/at %+v", s)
	}
	w := rows[1]
	if w.WindowID != "weekly" || w.RemainingPercent == nil || math.Abs(*w.RemainingPercent-40.0) > 1e-9 {
		t.Fatalf("weekly row %+v", w)
	}
	if w.UsedPercent == nil || math.Abs(*w.UsedPercent-60.0) > 1e-9 {
		t.Fatalf("weekly used %+v", w.UsedPercent)
	}
	wantWeeklyReset := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC).UnixMilli()
	if w.ResetAt == nil || *w.ResetAt != wantWeeklyReset {
		t.Fatalf("weekly reset %+v", w.ResetAt)
	}
	// purchased.balance_usd is a separate credit quantity; it must leave
	// every percentage window above untouched.
}

func TestOllamaBalancePercentBoundaries(t *testing.T) {
	cases := []struct {
		name    string
		value   string
		kept    bool
		used    float64
		remains float64
	}{
		{"zero published", "0", true, 100, 0},
		{"full remaining", "100", true, 0, 100},
		{"over range", "100.5", false, 0, 0},
		{"negative", "-0.1", false, 0, 0},
	}
	for _, tc := range cases {
		body := fmt.Sprintf(`{"included":{"session":{"remaining_percent":%v}}}`, tc.value)
		rows, err := parseOllama([]byte(body), 1800000000000)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if tc.kept {
			if len(rows) != 1 || rows[0].Kind != WindowOK {
				t.Fatalf("%s: %+v", tc.name, rows)
			}
			if math.Abs(*rows[0].UsedPercent-tc.used) > 1e-9 || math.Abs(*rows[0].RemainingPercent-tc.remains) > 1e-9 {
				t.Fatalf("%s: used %v remain %v", tc.name, rows[0].UsedPercent, rows[0].RemainingPercent)
			}
			continue
		}
		// An unusable share reports only the parser-convention marker.
		if len(rows) != 1 || rows[0].Kind != WindowEmpty {
			t.Fatalf("%s: %+v", tc.name, rows)
		}
	}
}

func TestOllamaBalanceMalformedStaysUnknown(t *testing.T) {
	if rows, _ := parseOllama([]byte("[]"), 1800000000000); len(rows) != 1 || rows[0].Kind != WindowInvalid {
		t.Fatalf("array body %+v", rows)
	}
	rows, _ := parseOllama([]byte(`{"purchased":{"balance_usd":12.5}}`), 1800000000000)
	if len(rows) != 1 || rows[0].Kind != WindowEmpty {
		t.Fatalf("purchased only %+v", rows)
	}
	rows, _ = parseOllama([]byte(`{"included":{"session":{"remaining_percent":"50"}}}`), 1800000000000)
	if len(rows) != 1 || rows[0].Kind != WindowEmpty {
		t.Fatalf("string share %+v", rows)
	}
}

func TestOllamaSchedulerEndpointAndCredentialIsolation(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1800000000000)}
	fake := &Fake{HostResponses: map[string]transport.Response{
		"ollama.com": {Status: 200, Body: []byte(ollamaBalanceFixture)},
	}}
	s := NewScheduler(clk, fake)
	on := Binding{Provider: "ollama-cloud", AccountID: "key:a", Kind: KindKey,
		Token: "synthetic-ollama-key", Enabled: true, BaseStatus: "default"}
	off := on
	off.AccountID = "key:b"
	off.Token = "synthetic-ollama-off"
	off.Enabled = false
	rows := s.Collect(context.Background(), []Binding{on, off}, []string{"ollama-cloud"})
	if len(fake.Calls) != 1 {
		t.Fatalf("disabled credential was sent: %d calls", len(fake.Calls))
	}
	req := fake.Calls[0]
	if req.Host != "ollama.com" || req.Path != "/api/balance" || req.Method != "GET" {
		t.Fatalf("endpoint %s%s %s", req.Host, req.Path, req.Method)
	}
	if req.Headers["Authorization"] != "Bearer synthetic-ollama-key" {
		t.Fatalf("authorization %q", req.Headers["Authorization"])
	}
	if len(rows) != 2 || rows[0].Endpoint != "balance" || rows[0].Kind != WindowOK || rows[1].WindowID != "weekly" {
		t.Fatalf("rows %+v", rows)
	}
}

func TestOllamaSchedulerFailureKeepsLastGoodObservedAt(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1800000000000)}
	fake := &Fake{Responses: []transport.Response{
		{Status: 200, Body: []byte(ollamaBalanceFixture)},
		{Status: 503},
	}}
	s := NewScheduler(clk, fake)
	b := Binding{Provider: "ollama-cloud", AccountID: "key:a", Kind: KindKey,
		Token: "synthetic-ollama-key", Enabled: true, BaseStatus: "default"}
	first := s.Collect(context.Background(), []Binding{b}, []string{"ollama-cloud"})
	if len(first) != 2 || first[0].Kind != WindowOK || first[0].ObservedAt == 0 {
		t.Fatalf("first %+v", first)
	}
	clk.Set(clk.Now().Add(6 * time.Minute))
	second := s.Collect(context.Background(), []Binding{b}, []string{"ollama-cloud"})
	if len(second) != 3 || second[0].Kind != WindowFailed {
		t.Fatalf("second %+v", second)
	}
	if second[1].WindowID != "five-hour" || second[1].Kind != WindowFailed || second[1].ObservedAt != first[0].ObservedAt {
		t.Fatalf("retention %+v vs %+v", second[1], first[0])
	}
	if second[1].UsedPercent == nil || math.Abs(*second[1].UsedPercent-27.5) > 1e-9 {
		t.Fatalf("kept used %+v", second[1].UsedPercent)
	}
	same := s.Collect(context.Background(), []Binding{b}, []string{"ollama-cloud"})
	if len(same) != 3 || !same[1].Cached || same[1].ObservedAt != first[0].ObservedAt {
		t.Fatalf("cached replay %+v", same[1])
	}
}
