package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"testing"
)

func TestUsagePaceIndependentProviderAndAccount(t *testing.T) {
	now := int64(1800000000000)
	rows := []store.Usage{{Provider: "a", Account: repairPtr("one"), At: now - 2*calc.HourMs}, {Provider: "a", Account: repairPtr("two"), At: now - calc.HourMs}, {Provider: "b", At: now - 100*calc.HourMs}}
	prices := []calc.AppliedPrice{{USD: repairPtr(10.0)}, {USD: repairPtr(20.0)}, {USD: repairPtr(1000.0)}}
	all := usagePace("a", nil, rows, prices, now)
	one := usagePace("a", repairPtr("one"), rows, prices, now)
	if all["projectedFiveHourUsd"] != 75.0 || one["projectedFiveHourUsd"] != 25.0 {
		t.Fatal(all, one)
	}
	if usagePace("a", nil, rows[1:2], prices[1:2], now-calc.HourMs/2)["usdPerHour"] != nil {
		t.Fatal("undersampled projection")
	}
}
