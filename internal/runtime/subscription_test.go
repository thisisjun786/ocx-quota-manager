package runtime

import "testing"

func TestConfirmedSubscriptionOverridesPlan(t *testing.T) {
	plan := "plus"
	got := subscription("openai", &plan)
	usd, _ := got["monthlyUsd"].(*float64)
	if usd == nil || *usd != 200 || got["basis"] != "user-confirmed" || got["label"] != "ChatGPT Pro" {
		t.Fatalf("confirmed override lost: %+v", got)
	}
}

func TestKnownPlanWithoutOverride(t *testing.T) {
	plan := "PLUS"
	got := subscription("openai-unconfirmed", &plan)
	if got["monthlyUsd"] != nil {
		t.Fatalf("unknown provider invented a price: %+v", got)
	}
	plan = "plus"
	// No USER_SUBSCRIPTIONS entry: the published Plus row is $20.
	// The catalog only carries providers that have either an override or a plan
	// table, and openai has an override, so this uses xai.
	known := "supergrok"
	got = subscription("not-a-provider", &known)
	if got["monthlyUsd"] != nil {
		t.Fatalf("missing provider invented %+v", got)
	}
	got = subscription("xai", &known)
	usd, _ := got["monthlyUsd"].(*float64)
	if usd == nil || *usd != 300 || got["basis"] != "user-confirmed" {
		t.Fatalf("confirmed Grok price wins over the published plan: %+v", got)
	}
}

func TestAmbiguousProStaysNil(t *testing.T) {
	// The confirmed openai override still wins for this installation.
	plan := "pro"
	got := subscription("openai", &plan)
	usd, _ := got["monthlyUsd"].(*float64)
	if usd == nil || *usd != 200 || got["basis"] != "user-confirmed" {
		t.Fatalf("override must beat ambiguous pro: %+v", got)
	}
	row := subscriptions.Plans["openai"]["pro"]
	if row.MonthlyUSD != nil || row.Basis != "ambiguous" {
		t.Fatalf("stored pro without an override stays ambiguous: %+v", row)
	}
	plus := subscriptions.Plans["openai"]["plus"]
	if plus.MonthlyUSD == nil || *plus.MonthlyUSD != 20 || plus.Basis != "official" {
		t.Fatalf("published Plus row: %+v", plus)
	}
}
