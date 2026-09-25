package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"testing"
	"time"
)

func TestPriceGaps_resolvesFindingWhenModelBecomesPriced(t *testing.T) {
	// Given
	now := time.UnixMilli(1800000000000)
	m := &rosterMemory{data: map[string]any{}}
	model := "test-model"
	tokens := 12.0
	p := []contract.Provider{{ID: "cursor", Analytics: map[string]any{"modelPrices": []map[string]any{{"model": model, "status": "unpriced"}}}}}
	usage := []store.Usage{{Provider: "cursor", Model: &model, At: now.UnixMilli(), Tokens: &tokens}}
	if _, err := attachPriceGaps(p, usage, []calc.AppliedPrice{{}}, m, now); err != nil {
		t.Fatal(err)
	}
	// When
	p[0].Analytics = map[string]any{"modelPrices": []map[string]any{{"model": model, "status": "official", "sourceUrl": "https://example.org", "checkedAt": "2026-01-01", "rates": map[string]any{"input": 1.0, "output": 1.0}}}}
	amount := 1.0
	summary, err := attachPriceGaps(p, usage, []calc.AppliedPrice{{USD: &amount}}, m, now.Add(5*time.Minute))
	// Then
	if err != nil {
		t.Fatal(err)
	}
	view := p[0].Analytics.(map[string]any)["priceGaps"].(map[string]any)
	if view["modelsNeedingPriceCheck"] != 0 || len(view["resolved"].([]map[string]any)) != 1 || summary["status"] != "ok" {
		t.Fatalf("gaps: %+v", view)
	}
}

func TestPriceGaps_ignoresCallsWithoutTokenCounts(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	m := &rosterMemory{data: map[string]any{}}
	model := "priced-model"
	zero := 0.0
	price := map[string]any{"model": model, "status": "official", "sourceUrl": "https://example.org", "checkedAt": "2026-01-01", "rates": map[string]any{"input": 1.0, "output": 1.0}}
	p := []contract.Provider{{ID: "anthropic", Analytics: map[string]any{"modelPrices": []map[string]any{price}}}}
	// The provider reported zero tokens for this call: no rate could price it.
	usage := []store.Usage{{Provider: "anthropic", Model: &model, At: now.UnixMilli(), Input: &zero, Output: &zero, Tokens: &zero}}
	if _, err := attachPriceGaps(p, usage, []calc.AppliedPrice{{}}, m, now); err != nil {
		t.Fatal(err)
	}
	view := p[0].Analytics.(map[string]any)["priceGaps"].(map[string]any)
	if view["modelsNeedingPriceCheck"] != 0 {
		t.Fatalf("a tokenless call flagged a priced model: %+v", view["models"])
	}
}
