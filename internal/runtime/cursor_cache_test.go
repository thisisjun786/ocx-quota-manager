package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"testing"
	"time"
)

func TestCacheReference_weightsMeasuredOtherProviderTokens(t *testing.T) {
	// Given
	now := time.UnixMilli(1800000000000)
	a, b, c := 100.0, 10.0, 5.0
	zero := 0.0
	rows := []store.Usage{{Provider: "anthropic", At: now.UnixMilli() - 1000, Input: &a, Cached: &b}, {Provider: "openai", At: now.UnixMilli() - 1000, Input: &b, Cached: &c}, {Provider: "cursor", At: now.UnixMilli() - 1000, Input: &a, Cached: &a}, {Provider: "anthropic", At: now.UnixMilli() - 1000, Input: &a, Cached: nil}, {Provider: "openai", At: now.UnixMilli() - 31*86400000, Input: &a, Cached: &zero}}
	// When
	got := calculateCacheReference(rows, now)
	// Then
	if got.AppliedRate == nil || *got.AppliedRate != 15.0/110.0 || got.ReferenceInputTokens != 110 || len(got.Providers) != 2 {
		t.Fatalf("reference: %+v", got)
	}
}
