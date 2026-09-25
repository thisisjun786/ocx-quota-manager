package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"testing"
)

func TestDirectObservationKeepsRecoverableAnthropicContract(t *testing.T) {
	now := int64(1800000000000)
	reset := now + 86400000
	epoch := int64(6)
	var points []calc.Point
	for i := 0; i < 2; i++ {
		used := float64(i * 12)
		o := directObservation(collect.Reading{Provider: "anthropic", Endpoint: "oauth-usage", Account: "a", WindowID: "weekly", Kind: collect.WindowOK, ObservedAt: now - int64(1-i)*3600000, UsedPercent: &used, ResetAt: &reset})
		if o.Source == nil || *o.Source != "anthropic/oauth-usage" || o.SourceVersion == nil || *o.SourceVersion != "anthropic-oauth-usage-1" {
			t.Fatal(o)
		}
		points = append(points, calc.Point{At: o.At, Reset: reset, Used: used, Epoch: &epoch, Source: *o.Source, SourceVersion: *o.SourceVersion, Method: *o.Method, ScopeKey: *o.ScopeKey, Unit: *o.Unit, LimitState: o.LimitState, WindowSemantics: o.WindowSemantics, UsedAccumulation: o.UsedAccumulation, CycleKey: *o.CycleKey})
	}
	sample := calc.ConsumePeriods(points, now)[calc.PeriodWeekly]
	if sample.DeltaPp == nil || *sample.DeltaPp != 12 || sample.RecoveredDeltaPp != 12 {
		t.Fatal(sample)
	}
}
func TestUnprovenWindowDoesNotBecomeFixed(t *testing.T) {
	used := 20.0
	reset := int64(1800100000000)
	for _, r := range []collect.Reading{
		{Provider: "opencode-go", Endpoint: "usage", WindowID: "five-hour"},
		{Provider: "command-code", Endpoint: "credits", WindowID: "weekly"},
		{Provider: "openai", Endpoint: "wham-usage", WindowID: "weekly"},
		{Provider: "kimi", Endpoint: "usages", WindowID: "weekly"},
	} {
		r.UsedPercent = &used
		r.ResetAt = &reset
		o := directObservation(r)
		if o.WindowSemantics == "fixed_reset" {
			t.Fatal(o)
		}
	}
	r := collect.Reading{Provider: "anthropic", Endpoint: "oauth-usage", WindowID: "custom-fable", UsedPercent: &used, ResetAt: &reset}
	o := directObservation(r)
	if *o.ScopeKey != "fable" {
		t.Fatal(o)
	}
}
