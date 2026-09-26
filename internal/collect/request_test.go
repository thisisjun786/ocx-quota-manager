package collect

import (
	"context"
	"encoding/json"
	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
	"math"
	"testing"
	"time"
)

func TestQuotaRequestContracts(t *testing.T) {
	for _, ad := range Adapters() {
		t.Run(ad.Provider()+ad.EndpointID(), func(t *testing.T) {
			b := Binding{Provider: ad.Provider(), AccountID: "a", Token: "test-credential", Kind: KindOAuth, Enabled: true, BaseStatus: "default", AccountRef: stringRef("physical")}
			if b.Provider == "kimi" {
				b.AuthMode = "oauth"
				b.BaseURL = "https://api.kimi.com/coding/v1"
			}
			if b.Provider == "opencode-go" || b.Provider == "command-code" {
				b.Kind = KindKey
			}
			req, ok := quotaRequest(b, ad)
			if !ok {
				t.Fatal("validbindingrefused")
			}
			switch b.Provider {
			case "openai":
				if req.Headers["ChatGPT-Account-Id"] != "physical" {
					t.Fatal("accountmissing")
				}
			case "anthropic":
				if req.Headers["anthropic-beta"] == "" || req.Headers["User-Agent"] == "" {
					t.Fatal("clientheadersmissing")
				}
			case "cursor":
				if string(req.Body) != "{}" || req.Headers["Connect-Protocol-Version"] != "1" {
					t.Fatal("RPCmissing")
				}
			case "devin":
				var body map[string]any
				if json.Unmarshal(req.Body, &body) != nil || body["metadata"].(map[string]any)["apiKey"] != b.Token {
					t.Fatal("metadatamissing")
				}
			}
			b.BaseStatus = "custom"
			b.BaseURL = "https://relay.example/v1"
			if _, ok := quotaRequest(b, ad); ok {
				t.Fatal("relaycredentialleak")
			}
		})
	}
}
func TestSchedulerIntervalAndCredentialIsolation(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1800000000000)}
	fake := &Fake{Responses: []transport.Response{{Status: 200, Body: []byte(`{"five_hour":{"utilization":10}}`)}}}
	s := NewScheduler(clk, fake)
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "first", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	first := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if len(first) == 0 {
		t.Fatal("first")
	}
	clk.Set(clk.Now().Add(10 * time.Second))
	cached := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if fake.CallCount() != 1 || len(cached) == 0 || cached[0].ObservedAt != first[0].ObservedAt {
		t.Fatal("refreshduplicatedorretimestamped")
	}
	b.Token = "replacement"
	s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if fake.CallCount() != 1 {
		t.Fatal("token rotation bypassed cadence")
	}
	b.BaseStatus = "unknown"
	s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if fake.CallCount() != 1 {
		t.Fatal("unknownbasecalled")
	}
}
func TestOllamaFraction(t *testing.T) {
	rows, err := parseOllama([]byte(`{"limits":{"session":{"usage":0.4237},"weekly":{"usage":0}}}`), 1800000000000)
	if err != nil || len(rows) != 2 || math.Abs(*rows[0].UsedPercent-42.37) > 1e-10 || *rows[1].UsedPercent != 0 {
		t.Fatal(rows, err)
	}
}

func TestSchedulerOutageRemainsBounded(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1800000000000)}
	f := &Fake{Responses: []transport.Response{{Status: 200, Body: []byte(`{"five_hour":{"utilization":10}}`)}, {Status: 503}}}
	s := NewScheduler(clk, f)
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	first := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if len(first) != 1 || first[0].Kind != WindowOK {
		t.Fatal(first)
	}
	for i := 0; i < 20; i++ {
		clk.Set(clk.Now().Add(5 * time.Minute))
		rows := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
		if len(rows) != 2 || rows[1].ObservedAt != first[0].ObservedAt || rows[1].Kind != WindowFailed {
			t.Fatalf("failure %d grew or refreshed data: %+v", i, rows)
		}
		cached := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
		if len(cached) != 2 || !cached[1].Cached || cached[1].Kind != WindowFailed {
			t.Fatal(cached)
		}
	}
}

func TestSchedulerRefusesAmbiguousNormalizedAccount(t *testing.T) {
	f := &Fake{}
	s := NewScheduler(clock.System{}, f)
	b := Binding{Provider: "openai", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default", AccountRef: stringRef("physical")}
	alias := b
	alias.ConfigProvider = "chatgpt"
	alias.Token = "other"
	s.Collect(context.Background(), []Binding{b, alias}, []string{"openai"})
	if f.CallCount() != 0 {
		t.Fatal("ambiguous credentials were sent")
	}
}

func TestSchedulerAccountRefIsolatesCache(t *testing.T) {
	clk := &clock.Var{T: time.UnixMilli(1800000000000)}
	f := &Fake{Responses: []transport.Response{{Status: 200, Body: []byte(`{"account_id":"first","rate_limit":{"primary_window":{"used_percent":10,"limit_window_seconds":604800}}}`)}, {Status: 503}}}
	s := NewScheduler(clk, f)
	b := Binding{Provider: "openai", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default", AccountRef: stringRef("first")}
	first := s.Collect(context.Background(), []Binding{b}, []string{"openai"})
	if len(first) != 1 || first[0].Kind != WindowOK {
		t.Fatal(first)
	}
	b.AccountRef = stringRef("second")
	clk.Set(clk.Now().Add(5 * time.Minute))
	rows := s.Collect(context.Background(), []Binding{b}, []string{"openai"})
	if f.CallCount() != 2 || len(rows) != 1 || rows[0].WindowID != "" {
		t.Fatal("another physical account inherited old data", rows)
	}
}

func TestSchedulerRejectsShortCredentialEcho(t *testing.T) {
	f := &Fake{Responses: []transport.Response{{Status: 200, Body: []byte(`{"five_hour":{"utilization":10},"echo":"tiny"}`)}}}
	s := NewScheduler(clock.System{}, f)
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "tiny", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	rows := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if len(rows) != 1 || rows[0].Kind != WindowInvalid {
		t.Fatal(rows)
	}
}

func TestPublicPercentBoundsAndEmptyRetirement(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	negative, over := float64(-1), float64(123.45)
	if remain(&negative) != nil || remain(&over) == nil || *remain(&over) != 0 {
		t.Fatal("invalid public percent bounds")
	}
	clk := &clock.Var{T: now}
	f := &Fake{Responses: []transport.Response{
		{Status: 200, Body: []byte(`{"five_hour":{"utilization":40}}`)},
		{Status: 200, Body: []byte(`{}`)},
		{Status: 503},
	}}
	s := NewScheduler(clk, f)
	b := Binding{Provider: "anthropic", AccountID: "a", Token: "synthetic", Kind: KindOAuth, Enabled: true, BaseStatus: "default"}
	s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	clk.Set(clk.Now().Add(5 * time.Minute))
	s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	clk.Set(clk.Now().Add(5 * time.Minute))
	rows := s.Collect(context.Background(), []Binding{b}, []string{"anthropic"})
	if len(rows) != 1 || rows[0].WindowID != "" {
		t.Fatal("empty success resurrected old endpoint limits", rows)
	}
	noPercent := []Reading{{Provider: "xai", Account: "a", WindowID: "monthly", Kind: WindowOK, ObservedAt: now.UnixMilli()}}
	if p := project(noPercent, now); len(p[0].Accounts[0].Windows) != 0 {
		t.Fatal("percent-less evidence became a quota window")
	}
}
