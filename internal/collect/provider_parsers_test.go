package collect

import (
	"testing"
	"time"
)

// Fixture-parity tests for the Node parser port. Every case mirrors a case in
// tests/provider-quota-adapters.test.mjs / src/*.mjs fixtures; no live calls.

const NOW = int64(1800000000000)

func mustParse(t *testing.T, body []byte, parse func([]byte, int64) ([]Reading, error), provider, endpoint string) []Reading {
	rows, err := parse(body, NOW)
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	for _, r := range rows {
		if r.Kind != WindowOK {
			t.Fatalf("want OK rows, got %+v", rows)
		}
		if r.Provider != provider || r.Endpoint != endpoint {
			t.Fatalf("attribution drift: %+v", r)
		}
	}
	return rows
}

func wantMarkers(t *testing.T, rows []Reading, want WindowKind) {
	t.Helper()
	if len(rows) != 1 || rows[0].Kind != want {
		t.Fatalf("want one %s marker, got %+v", want, rows)
	}
}

func ids(rows []Reading) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.WindowID)
	}
	return out
}

func TestCodexWindowDurations(t *testing.T) {
	weekly := mustParse(t, []byte(`{"rate_limit":{"primary_window":{"used_percent":14,"limit_window_seconds":604800,"reset_at":1790100895}}}`), parseCodex, "openai", "wham-usage")
	if len(weekly) != 1 || weekly[0].WindowID != "weekly" || *weekly[0].UsedPercent != 14 {
		t.Fatalf("weekly primary: %+v", weekly)
	}
	// reset_at arrives in epoch seconds and must not be read as milliseconds.
	if weekly[0].ResetAt == nil || *weekly[0].ResetAt != 1790100895000 {
		t.Fatalf("reset seconds: %+v", weekly[0].ResetAt)
	}
	burst := mustParse(t, []byte(`{"rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":18000},"secondary_window":{"used_percent":55,"limit_window_seconds":604800},"tertiary_window":{"used_percent":5,"limit_window_seconds":2592000}}}`), parseCodex, "openai", "wham-usage")
	if got := ids(burst); len(got) != 3 || got[0] != "short" || got[1] != "weekly" || got[2] != "monthly" {
		t.Fatalf("burst: %v", got)
	}
	if burst[0].Label != "5시간" {
		t.Fatalf("burst label %q", burst[0].Label)
	}
	monthly := mustParse(t, []byte(`{"rate_limit":{"primary_window":{"used_percent":60,"limit_window_seconds":2592000},"secondary_window":{"used_percent":20,"limit_window_seconds":604800}}}`), parseCodex, "openai", "wham-usage")
	if got := ids(monthly); len(got) != 2 || got[0] != "monthly" || got[1] != "weekly" {
		t.Fatalf("monthly primary keeps secondary weekly: %v", got)
	}
	undeclared := mustParse(t, []byte(`{"rate_limit":{"primary_window":{"used_percent":9}}}`), parseCodex, "openai", "wham-usage")
	if len(undeclared) != 1 || undeclared[0].WindowID != "weekly" {
		t.Fatalf("undeclared stays weekly: %+v", undeclared)
	}
}

func TestCodexDedupeAndZero(t *testing.T) {
	// The primary window may already be weekly; a supplementary window must not
	// overwrite it or publish the same id twice.
	rows := mustParse(t, []byte(`{"rate_limit":{"primary_window":{"used_percent":14,"limit_window_seconds":604800},"secondary_window":{"used_percent":55,"limit_window_seconds":604800}}}`), parseCodex, "openai", "wham-usage")
	if len(rows) != 1 || *rows[0].UsedPercent != 14 {
		t.Fatalf("first claim wins: %+v", rows)
	}
	zero := mustParse(t, []byte(`{"rate_limit":{"primary_window":{"used_percent":0,"limit_window_seconds":604800}}}`), parseCodex, "openai", "wham-usage")
	if len(zero) != 1 || zero[0].UsedPercent == nil || *zero[0].UsedPercent != 0 {
		t.Fatalf("numeric zero is a measured zero: %+v", zero)
	}
}

func TestCodexResetShapes(t *testing.T) {
	want := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC).UnixMilli()
	for name, reset := range map[string]string{
		"iso": `"reset_at":"2026-10-01T08:00:00Z"`,
		"ms":  `"reset_at":1790841600000`,
	} {
		body := []byte(`{"rate_limit":{"primary_window":{"used_percent":1,` + reset + `}}}`)
		rows, _ := parseCodex(body, NOW)
		if len(rows) != 1 || rows[0].ResetAt == nil || *rows[0].ResetAt != want {
			t.Fatalf("%s reset: %+v", name, rows)
		}
	}
	rows, _ := parseCodex([]byte(`{"rate_limit":{"primary_window":{"used_percent":1,"reset_at":"not-a-time"}}}`), NOW)
	if len(rows) != 1 || rows[0].ResetAt != nil {
		t.Fatalf("bogus reset is absent: %+v", rows)
	}
}

func TestClaudeWindows(t *testing.T) {
	body := []byte(`{"five_hour":{"utilization":10,"resets_at":"2026-10-01T08:00:00Z"},"seven_day":{"utilization":43},` +
		`"seven_day_fable":{"utilization":24},` +
		`"limits":[{"kind":"weekly_scoped","percent":24,"scope":{"model":{"display_name":"Fable"}}},{"kind":"weekly_scoped","percent":5,"scope":{"model":{"display_name":"Hedgehog"}}}]}`)
	rows := mustParse(t, body, parseClaude, "anthropic", "oauth-usage")
	got := ids(rows)
	want := []string{"five-hour", "weekly", "custom-fable", "custom-hedgehog"}
	if len(got) != len(want) {
		t.Fatalf("claude ids %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("claude ids %v want %v", got, want)
		}
	}
	if *rows[2].UsedPercent != 24 {
		t.Fatalf("bucket claims the fable window first: %+v", rows[2])
	}
}

func TestClaudeEmptyInvalid(t *testing.T) {
	rows, _ := parseClaude([]byte("not-json"), NOW)
	wantMarkers(t, rows, WindowInvalid)
	rows, _ = parseClaude([]byte("{}"), NOW)
	wantMarkers(t, rows, WindowEmpty)
}

func TestCursorWindows(t *testing.T) {
	body := []byte(`{"billingCycleEnd":"2027-02-01T00:00:00Z","planUsage":{"totalPercentUsed":2.5,"autoPercentUsed":1.9,"apiPercentUsed":22.21}}`)
	rows := mustParse(t, body, parseCursor, "cursor", "period-usage")
	want := []string{"monthly", "custom-first-party-models", "custom-api-usage"}
	got := ids(rows)
	for i := range want {
		if i >= len(got) || got[i] != want[i] {
			t.Fatalf("cursor ids %v want %v", got, want)
		}
	}
	if *rows[0].UsedPercent != 2.5 {
		t.Fatalf("reported percent published: %+v", rows[0])
	}
	wantReset := time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	if rows[0].ResetAt == nil || *rows[0].ResetAt != wantReset {
		t.Fatalf("iso cycle end: %+v", rows[0].ResetAt)
	}
}

func TestCursorSpendOnlyRow(t *testing.T) {
	// A spend pair without a reported percentage still names the window; the
	// percentage is not derived from the pair here.
	rows := mustParse(t, []byte(`{"planUsage":{"includedSpend":7845,"limit":40000}}`), parseCursor, "cursor", "period-usage")
	if len(rows) != 1 || rows[0].WindowID != "monthly" || rows[0].UsedPercent != nil {
		t.Fatalf("spend-only row: %+v", rows)
	}
}

func TestGrokCreditsWeekly(t *testing.T) {
	body := []byte(`{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":1790100895},"creditUsagePercent":12.5}}`)
	rows := mustParse(t, body, parseGrok, "xai", "grok-credits")
	if len(rows) != 1 || rows[0].WindowID != "weekly" || *rows[0].UsedPercent != 12.5 {
		t.Fatalf("weekly credits: %+v", rows)
	}
	if rows[0].ResetAt == nil || *rows[0].ResetAt != 1790100895000 {
		t.Fatalf("period end: %+v", rows[0].ResetAt)
	}
	// The wire format omits a zero-valued field; absence is not a zero.
	absent, _ := parseGrok([]byte(`{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY"}}}`), NOW)
	wantMarkers(t, absent, WindowEmpty)
	monthly, _ := parseGrok([]byte(`{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_MONTHLY"},"creditUsagePercent":5}}`), NOW)
	wantMarkers(t, monthly, WindowEmpty)
}

func TestGrokBillingSeparate(t *testing.T) {
	body := []byte(`{"config":{"used":{"val":3.5},"monthlyLimit":{"val":10},"billingPeriodEnd":"2026-10-01T08:00:00Z"}}`)
	rows := mustParse(t, body, parseGrokBilling, "xai", "grok-billing")
	if len(rows) != 1 || rows[0].WindowID != "monthly" || *rows[0].UsedPercent != 35 {
		t.Fatalf("billing percent: %+v", rows)
	}
	// A zero limit publishes no percentage rather than dividing into it.
	zero := mustParse(t, []byte(`{"config":{"used":{"val":3.5},"monthlyLimit":{"val":0}}}`), parseGrokBilling, "xai", "grok-billing")
	if len(zero) != 1 || zero[0].UsedPercent != nil {
		t.Fatalf("zero limit: %+v", zero)
	}
	none, _ := parseGrokBilling([]byte(`{"config":{}}`), NOW)
	wantMarkers(t, none, WindowEmpty)
}

func TestDevinWindows(t *testing.T) {
	body := []byte(`{"userStatus":{"planStatus":{"dailyQuotaRemainingPercent":40,"dailyQuotaResetAtUnix":1790100895,"weeklyQuotaRemainingPercent":10,"weeklyQuotaResetAtUnix":1790200895}}}`)
	rows := mustParse(t, body, parseDevin, "devin", "user-status")
	if got := ids(rows); len(got) != 2 || got[0] != "short" || got[1] != "weekly" {
		t.Fatalf("devin windows: %v", got)
	}
	if *rows[0].UsedPercent != 60 || *rows[1].UsedPercent != 90 {
		t.Fatalf("remaining converted: %+v", rows)
	}
	if rows[0].ResetAt == nil || *rows[0].ResetAt != 1790100895000 {
		t.Fatalf("unix seconds reset: %+v", rows[0].ResetAt)
	}
}

func TestDevinHiddenDaily(t *testing.T) {
	body := []byte(`{"userStatus":{"planStatus":{"planInfo":{"hideDailyQuota":true},"weeklyQuotaRemainingPercent":25}}}`)
	rows := mustParse(t, body, parseDevin, "devin", "user-status")
	if len(rows) != 2 {
		t.Fatalf("hidden daily kept as marker: %+v", rows)
	}
	if rows[0].WindowID != "short" || !rows[0].Hidden || rows[0].UsedPercent != nil {
		t.Fatalf("hidden daily: %+v", rows[0])
	}
	if rows[1].WindowID != "weekly" || rows[1].Hidden || *rows[1].UsedPercent != 75 {
		t.Fatalf("weekly unaffected: %+v", rows[1])
	}
}

func TestDevinRangeGuard(t *testing.T) {
	body := []byte(`{"userStatus":{"planStatus":{"dailyQuotaRemainingPercent":101,"weeklyQuotaRemainingPercent":50}}}`)
	rows := mustParse(t, body, parseDevin, "devin", "user-status")
	if got := ids(rows); len(got) != 1 || got[0] != "weekly" {
		t.Fatalf("out-of-range remaining skipped: %v", got)
	}
}

func TestOpenCodeWindows(t *testing.T) {
	body := []byte(`{"usage":{"rolling":{"status":"unsupported","percent":10},"weekly":{"percent":20.5,"resetsAt":1790100895},"monthly":{"percent":0}}}`)
	rows := mustParse(t, body, parseOpenCode, "opencode-go", "usage")
	got := ids(rows)
	if len(got) != 2 || got[0] != "weekly" || got[1] != "monthly" {
		t.Fatalf("non-ok rolling skipped: %v", got)
	}
	if *rows[0].UsedPercent != 20.5 {
		t.Fatalf("weekly percent: %+v", rows[0])
	}
	if rows[0].ResetAt == nil || *rows[0].ResetAt != 1790100895000 {
		t.Fatalf("resetsAt seconds: %+v", rows[0].ResetAt)
	}
	if rows[1].UsedPercent == nil || *rows[1].UsedPercent != 0 {
		t.Fatalf("numeric zero valid: %+v", rows[1])
	}
}

func TestCommandCodeWindows(t *testing.T) {
	body := []byte(`{"data":{"windowLimits":{"fiveHour":{"used":1,"cap":14,"resetAt":0},"weekly":{"used":0,"cap":10}}}}`)
	rows := mustParse(t, body, parseCommandCode, "command-code", "credits")
	if got := ids(rows); len(got) != 2 || got[0] != "five-hour" || got[1] != "weekly" {
		t.Fatalf("command windows: %v", got)
	}
	if diff := *rows[0].UsedPercent - 100.0/14.0; diff < -1e-9 || diff > 1e-9 {
		t.Fatalf("five-hour ratio: %v", *rows[0].UsedPercent)
	}
	// Unix 0 is a window that has not opened, not a reset in 1970.
	if rows[0].ResetAt != nil {
		t.Fatalf("resetAt 0: %+v", rows[0].ResetAt)
	}
	if rows[1].UsedPercent == nil || *rows[1].UsedPercent != 0 {
		t.Fatalf("zero used valid: %+v", rows[1])
	}
	// The surface answers bare as well as wrapped.
	bare := mustParse(t, []byte(`{"windowLimits":{"fiveHour":{"used":1,"cap":14}}}`), parseCommandCode, "command-code", "credits")
	if len(bare) != 1 || bare[0].WindowID != "five-hour" {
		t.Fatalf("bare body: %+v", bare)
	}
}

func TestCommandCodeZeroCap(t *testing.T) {
	rows := mustParse(t, []byte(`{"windowLimits":{"fiveHour":{"used":3,"cap":0}}}`), parseCommandCode, "command-code", "credits")
	if len(rows) != 1 || rows[0].UsedPercent != nil {
		t.Fatalf("zero cap publishes no percent: %+v", rows)
	}
}

func TestAdapterTableEntries(t *testing.T) {
	var billing, opencode *Adapter
	for _, ad := range Adapters() {
		a := ad
		switch {
		case a.Provider() == "xai" && a.EndpointID() == "grok-billing":
			billing = &a
		case a.Provider() == "opencode-go":
			opencode = &a
		}
	}
	if billing == nil {
		t.Fatal("grok-billing adapter missing")
	}
	// Each endpoint parses only its own shape: the credits parser refuses a
	// billing body and the billing parser refuses a credits body.
	rows, _ := (*billing).Parse([]byte(`{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY"},"creditUsagePercent":5}}`), NOW)
	wantMarkers(t, rows, WindowEmpty)
	if opencode == nil {
		t.Fatal("opencode-go adapter missing")
	}
	if (*opencode).EndpointID() != "usage" || (*opencode).Path() != "/zen/go/v1/usage" || (*opencode).Method() != "GET" {
		t.Fatalf("opencode endpoint drifted: %+v", *opencode)
	}
}
