package collect

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

func TestRegisteredProviders(t *testing.T) {
	want := []string{"openai", "anthropic", "cursor", "xai", "devin", "command-code", "opencode-go"}
	have := map[string]bool{}
	for _, a := range Adapters() {
		have[a.Provider()] = true
	}
	for _, id := range want {
		if !have[id] || !IsRegisteredDirect(id) {
			t.Fatalf("missing %s", id)
		}
	}
	if IsRegisteredDirect("google") {
		t.Fatal("google is not a direct reader")
	}
}

func TestParseEmptyInvalidOK(t *testing.T) {
	now := time.Date(2027, 1, 15, 8, 0, 0, 0, time.UTC).UnixMilli()
	rows, _ := parseCodex([]byte(`{}`), now)
	if rows[0].Kind != WindowEmpty {
		t.Fatalf("empty %s", rows[0].Kind)
	}
	rows, _ = parseCodex([]byte(`not-json`), now)
	if rows[0].Kind != WindowInvalid {
		t.Fatalf("invalid %s", rows[0].Kind)
	}
	rows, _ = parseCodex([]byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":40,"limit_window_seconds":604800}}}`), now)
	if rows[0].Kind != WindowOK || rows[0].WindowID != "weekly" || *rows[0].UsedPercent != 40 {
		t.Fatalf("%+v", rows[0])
	}
}

func TestFake429KeepsRetryAfter(t *testing.T) {
	clk := clock.Fixed{T: time.Date(2027, 1, 15, 8, 0, 0, 0, time.UTC)}
	fake := &Fake{Responses: []transport.Response{{
		Status: 429, Headers: http.Header{"Retry-After": []string{"120"}},
	}}}
	s := NewScheduler(clk, fake)
	s.Collect(context.Background(), []Binding{{
		Provider: "openai", AccountID: "a", Token: "SYNTHETIC_ACCESS_TOKEN", Enabled: true, Kind: KindOAuth, BaseStatus: "default", AccountRef: stringRef("account"),
	}}, []string{"openai"})
	if len(fake.Calls) != 1 {
		t.Fatalf("calls %d", len(fake.Calls))
	}
	s.Collect(context.Background(), []Binding{{
		Provider: "openai", AccountID: "a", Token: "SYNTHETIC_ACCESS_TOKEN", Enabled: true, Kind: KindOAuth, BaseStatus: "default", AccountRef: stringRef("account"),
	}}, []string{"openai"})
	if len(fake.Calls) != 1 {
		t.Fatalf("429 must not be retried early, calls=%d", len(fake.Calls))
	}
}

func Test401DoesNotResendUnchangedCredential(t *testing.T) {
	fake := &Fake{Responses: []transport.Response{
		{Status: 401, Body: []byte(`{}`)},
		{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":1,"limit_window_seconds":604800}}}`)},
	}}
	s := NewScheduler(clock.System{}, fake)
	rows := s.Collect(context.Background(), []Binding{{
		Provider: "openai", AccountID: "a", Token: "SYNTHETIC_ACCESS_TOKEN", Enabled: true, Kind: KindOAuth, BaseStatus: "default", AccountRef: stringRef("account"),
	}}, []string{"openai"})
	if len(fake.Calls) != 1 {
		t.Fatalf("401 unchanged credential calls=%d", len(fake.Calls))
	}
	if len(rows) != 1 || rows[0].Kind != WindowFailed {
		t.Fatalf("%+v", rows)
	}
}

func Test403IsFailedNotRetried(t *testing.T) {
	fake := &Fake{Responses: []transport.Response{{Status: 403}}}
	s := NewScheduler(clock.System{}, fake)
	rows := s.Collect(context.Background(), []Binding{{
		Provider: "openai", AccountID: "a", Token: "SYNTHETIC_ACCESS_TOKEN", Enabled: true, Kind: KindOAuth, BaseStatus: "default", AccountRef: stringRef("account"),
	}}, []string{"openai"})
	if len(fake.Calls) != 1 {
		t.Fatalf("calls %d", len(fake.Calls))
	}
	if rows[0].Kind != WindowFailed {
		t.Fatalf("%s", rows[0].Kind)
	}
}

func TestOneProviderFailureDoesNotStopAnother(t *testing.T) {
	fake := &Fake{}
	fake.SetHost("chatgpt.com", transport.Response{}, errors.New("refused"))
	fake.SetHost("api.anthropic.com", transport.Response{Status: 200, Body: []byte(`{"five_hour":{"utilization":10}}`)}, nil)
	s := NewScheduler(clock.System{}, fake)
	rows := s.Collect(context.Background(), []Binding{
		{Provider: "openai", AccountID: "a", Token: "SYNTHETIC_ACCESS_TOKEN", Enabled: true, Kind: KindOAuth, BaseStatus: "default", AccountRef: stringRef("account")},
		{Provider: "anthropic", AccountID: "b", Token: "SYNTHETIC_ACCESS_TOKEN", Enabled: true, Kind: KindOAuth, BaseStatus: "default", AccountRef: stringRef("account")},
	}, []string{"openai", "anthropic"})
	if len(fake.Calls) != 2 {
		t.Fatalf("calls %d", len(fake.Calls))
	}
	var failed, ok int
	for _, r := range rows {
		switch r.Kind {
		case WindowFailed:
			if r.Provider != "openai" {
				t.Fatalf("unexpected fail %+v", r)
			}
			failed++
		case WindowOK:
			if r.Provider != "anthropic" || r.WindowID != "five-hour" {
				t.Fatalf("unexpected ok %+v", r)
			}
			ok++
		}
	}
	if failed == 0 || ok == 0 {
		t.Fatalf("want both providers, rows=%+v", rows)
	}
}

func TestReadOnlyCredentialLoad(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"providers":{"openai":{"apiKey":"k"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := (Reader{Home: dir}).Load()
	if err != nil {
		t.Fatal(err)
	}
	if src.Files["ocxConfig"] != FileOK || len(src.Bindings) != 1 || src.Bindings[0].Token != "k" {
		t.Fatalf("%+v", src)
	}
	if src.Files["ocxAuth"] != FileMissing {
		t.Fatalf("missing auth %s", src.Files["ocxAuth"])
	}
}

func TestUnknownDirectProviderIgnored(t *testing.T) {
	ids := ParseDirectProviders("openai,openai,not-a-vendor")
	if len(ids) != 2 || ids[0] != "openai" || ids[1] != "not-a-vendor" {
		t.Fatalf("%v", ids)
	}
	if IsRegisteredDirect("not-a-vendor") {
		t.Fatal("unknown must stay unregistered")
	}
}

func TestSupportKinds(t *testing.T) {
	if SupportKind("openai") != "direct" || SupportKind("ollama") != "estimate" || SupportKind("google") != "unsupported" {
		t.Fatal("support inventory drifted")
	}
	if IsRegisteredDirect("ollama") {
		t.Fatal("ollama must not become a HTTPS reader")
	}
}
