package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"testing"
	"time"
)

func TestCapacityMatchesSameAccountRun(t *testing.T) {
	now := int64(1800000000000)
	reset := now + 3600000
	pts := []calc.Point{{At: now - 600000, Reset: reset, Used: 10}, {At: now, Reset: reset, Used: 20}}
	rows := []store.Usage{{Provider: "openai", Account: repairPtr("a"), At: now - 1000, USD: repairPtr(5.0)}, {Provider: "openai", Account: repairPtr("b"), At: now - 1000, USD: repairPtr(900.0)}}
	prices := []calc.AppliedPrice{{USD: rows[0].USD}, {USD: rows[1].USD}}
	win := contract.Window{ID: "weekly", RemainingPercent: repairPtr(80.0), ResetAt: repairPtr(time.UnixMilli(reset).UTC().Format(time.RFC3339Nano))}
	got := windowCapacity("openai", "a", win, pts, rows, prices, now)
	if got["capacityApiUsd"] != 50.0 || got["remainingApiUsd"] != 40.0 {
		t.Fatalf("capacity %v", got)
	}
	pts[1].At = now + 1
	if got := windowCapacity("openai", "a", win, pts, rows, prices, now); got["capacityApiUsd"] != nil {
		t.Fatalf("future %v", got)
	}
}

func TestCapacityDoesNotBridgeMissingOrDifferentEvidence(t *testing.T) {
	now := int64(1800000000000)
	reset := now + 3600000
	for _, kind := range []string{"gap", "reset", "identity", "scope", "stale", "unattributed", "no-prices"} {
		t.Run(kind, func(t *testing.T) {
			pts := []calc.Point{{At: now - 600000, Reset: reset, Used: 10}, {At: now, Reset: reset, Used: 20}}
			win := contract.Window{ID: "weekly", RemainingPercent: repairPtr(80.0)}
			rows := []store.Usage{{Provider: "openai", Account: repairPtr("a"), At: now - 1000, USD: repairPtr(5.0)}}
			prices := []calc.AppliedPrice{{USD: rows[0].USD}}
			switch kind {
			case "gap":
				pts[0].At = now - 3600000
			case "reset":
				pts[0].Reset = reset - 120000
			case "identity":
				pts[0].Epoch = repairPtr(int64(1))
				pts[1].Epoch = repairPtr(int64(2))
			case "scope":
				win.UsageScope = repairPtr("model-specific")
			case "stale":
				win.Stale = repairPtr(true)
			case "unattributed":
				rows[0].Account = nil
			case "no-prices":
				prices[0].USD = nil
			}
			got := windowCapacity("openai", "a", win, pts, rows, prices, now)
			key := "capacityApiUsd"
			if kind == "stale" {
				key = "remainingApiUsd"
			}
			if got[key] != nil {
				t.Fatalf("%s wrongly calculated %v", kind, got)
			}
		})
	}
}

func TestCapacityFiltersWholeRetiredEpochRuns(t *testing.T) {
	now := int64(1800000000000)
	reset := now + 3600000
	pts := []calc.Point{{At: now - 1200000, Reset: reset, Used: 0, Epoch: repairPtr(int64(1))}, {At: now - 600000, Reset: reset, Used: 50, Epoch: repairPtr(int64(1))}, {At: now - 500000, Reset: reset, Used: 0, Epoch: repairPtr(int64(2))}, {At: now, Reset: reset, Used: 10, Epoch: repairPtr(int64(2))}}
	rows := []store.Usage{{Provider: "openai", Account: repairPtr("a"), At: now - 700000}, {Provider: "openai", Account: repairPtr("a"), At: now - 1000}}
	prices := []calc.AppliedPrice{{USD: repairPtr(500.0)}, {USD: repairPtr(5.0)}}
	win := contract.Window{ID: "weekly", IdentityEpoch: repairPtr(int64(2)), RemainingPercent: repairPtr(90.0), ResetAt: repairPtr(time.UnixMilli(reset).UTC().Format(time.RFC3339Nano))}
	got := windowCapacity("openai", "a", win, pts, rows, prices, now)
	if got["capacityApiUsd"] != 50.0 {
		t.Fatalf("retired epoch pooled: %v", got)
	}
	win.Stale = repairPtr(true)
	got = windowCapacity("openai", "a", win, pts, rows, prices, now)
	hist, _ := got["historicalCapacity"].(map[string]any)
	if got["capacityApiUsd"] != nil || hist["apiUsd"] != 50.0 || got["remainingApiUsd"] != nil {
		t.Fatalf("stale not historical: %v", got)
	}
}

func TestCapacityKeepsActualMatchedEvidenceTimestamp(t *testing.T) {
	now := int64(1800000000000)
	oldReset := now - 3600000
	newReset := now + 3600000
	pts := []calc.Point{{At: now - 7200000, Reset: oldReset, Used: 10}, {At: now - 6600000, Reset: oldReset, Used: 20}, {At: now, Reset: newReset, Used: 30}}
	rows := []store.Usage{{Provider: "openai", Account: repairPtr("a"), At: now - 6700000}}
	prices := []calc.AppliedPrice{{USD: repairPtr(5.0)}}
	win := contract.Window{ID: "weekly", RemainingPercent: repairPtr(70.0), ResetAt: repairPtr(time.UnixMilli(newReset).UTC().Format(time.RFC3339Nano))}
	got := windowCapacity("openai", "a", win, pts, rows, prices, now)
	if got["capacityBasis"] != "historical" || got["capacityObservedAt"] != time.UnixMilli(now-6600000).UTC().Format(time.RFC3339Nano) {
		t.Fatalf("old evidence relabeled: %v", got)
	}
}
