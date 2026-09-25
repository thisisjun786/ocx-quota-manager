package collect

import (
	"context"
	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"os"
	"strings"
	"testing"
	"time"
)

func TestKimiPayloads(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		ids        []string
		used       []float64
	}{
		{"nested", `{"usage":null,"data":{"usage":{"limit":"100","remaining":"75","resetTime":"2030-01-01T00:00:00Z"},"limits":[{"window":{"duration":300,"timeUnit":"MINUTE","resetAt":1900000000},"detail":{"limit":20,"used":2}}],"totalQuota":{"percent":33}}}`, []string{"five-hour", "weekly", scopedWindowID("Total subscription credits")}, []float64{10, 25, 33}},
		{"weekly limit", `{"limits":[{"name":"weekly","detail":{"used_percent":"0"},"window":{"reset_time":1900000000}},{"name":"5 hour","detail":{"limit":10,"used":5}}]}`, []string{"five-hour", "weekly"}, []float64{50, 0}},
		{"invalid", `{"usage":{"limit":0,"used":3},"limits":[{"name":"weekly","detail":{"percent":-1}}]}`, nil, nil},
		{"remaining invalid", `{"usage":{"limit":10,"remaining":20}}`, nil, nil},
		{"over limit", `{"usage":{"limit":100,"used":150},"limits":[{"name":"5h","percent":150}]}`, []string{"five-hour", "weekly"}, []float64{100, 100}},
		{"nan", `{"usage":{"percent":"NaN"}}`, nil, nil},
		{"total only", `{"totalQuota":{"percent":20}}`, []string{scopedWindowID("Total subscription credits")}, []float64{20}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows, err := parseKimi([]byte(tc.body), 1800000000000)
			if err != nil {
				t.Fatal(err)
			}
			if len(tc.ids) == 0 {
				if len(rows) != 1 || rows[0].Kind != WindowEmpty {
					t.Fatal(rows)
				}
				return
			}
			if len(rows) != len(tc.ids) {
				t.Fatal(rows)
			}
			for i, r := range rows {
				if r.WindowID != tc.ids[i] || r.UsedPercent == nil || *r.UsedPercent != tc.used[i] {
					t.Fatal(rows)
				}
			}
			if tc.name == "nested" && (rows[0].ResetAt == nil || *rows[0].ResetAt != 1900000000000 || rows[1].ResetAt == nil) {
				t.Fatal("reset lost")
			}
		})
	}
	rows, _ := parseKimi([]byte(`[]`), 1)
	if rows[0].Kind != WindowInvalid {
		t.Fatal(rows)
	}
}
func TestKimiCredentialDestination(t *testing.T) {
	good := Binding{Provider: "kimi", AccountID: "a", Token: "synthetic", Kind: KindOAuth, AuthMode: "oauth", Enabled: true, BaseStatus: "custom", BaseURL: "https://api.kimi.com/coding/v1"}
	var ad Adapter
	for _, candidate := range Adapters() {
		if candidate.Provider() == "kimi" {
			ad = candidate
		}
	}
	if ad == nil {
		t.Fatal("Kimi adapter unregistered")
	}
	for _, tc := range []struct {
		base  string
		allow bool
	}{
		{good.BaseURL, true}, {good.BaseURL + "/", true}, {"https://api.kimi.com/v1", false}, {"https://api.kimi.com.evil.test/coding/v1", false}, {"http://api.kimi.com/coding/v1", false}, {good.BaseURL + "?", false}, {good.BaseURL + "?x=1", false}, {good.BaseURL + "#x", false}, {"https://u@api.kimi.com/coding/v1", false}, {"", false}, {"https://api.kimi.com/coding%2fv1", false},
	} {
		b := good
		b.BaseURL = tc.base
		_, ok := quotaRequest(b, ad)
		if ok != tc.allow {
			t.Fatalf("base %q got %v", tc.base, ok)
		}
		if !tc.allow {
			f := &Fake{}
			NewScheduler(clock.System{}, f).Collect(context.Background(), []Binding{b}, []string{"kimi"})
			if f.CallCount() != 0 {
				t.Fatal("unsafe request")
			}
		}
	}
	for _, kind := range []BindingKind{KindOAuth, KindKey} {
		for _, mode := range []string{"oauth", "key", "", "forward", "local", "typo"} {
			b := good
			b.Kind = kind
			b.AuthMode = mode
			_, ok := quotaRequest(b, ad)
			if ok != ((kind == KindOAuth && mode == "oauth") || (kind == KindKey && (mode == "key" || mode == ""))) {
				t.Fatal(kind, mode)
			}
		}
	}
	f := &Fake{}
	NewScheduler(clock.System{}, f).Collect(context.Background(), []Binding{good}, nil)
	if f.CallCount() != 0 {
		t.Fatal("default opt-in changed")
	}
}

func TestKimiOnlyPrimaryKeyCollected(t *testing.T) {
	for _, primary := range []string{"primary", "${MISSING_KIMI_KEY}", "$MISSING_KIMI_KEY", "keychain:test", ""} {
		config := `{"providers":{"kimi":{"authMode":"key","baseUrl":"https://api.kimi.com/coding/v1","apiKey":"` + primary + `","apiKeyPool":[{"id":"a","key":"primary"},{"id":"b","key":"backup"},{"id":"c","key":"primary"}]}}}`
		local, err := (Reader{Home: "/synthetic", ReadFile: func(path string) ([]byte, error) {
			if strings.HasSuffix(path, "config.json") {
				return []byte(config), nil
			}
			return nil, os.ErrNotExist
		}}).LoadLocal(time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if len(local.Providers[0].Accounts) > 1 {
			t.Fatal("backup keys inflated roster")
		}
		f := &Fake{}
		NewScheduler(clock.System{}, f).Collect(context.Background(), local.Bindings, []string{"kimi"})
		want := 0
		if primary == "primary" {
			want = 1
		}
		if f.CallCount() != want {
			t.Fatalf("primary %q calls %d", primary, f.CallCount())
		}
	}
}
