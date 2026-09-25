package runtime

import (
	"testing"
	"time"
)

type metaMap map[string]any

func (m metaMap) Meta(k string) (any, bool) { v, ok := m[k]; return v, ok }

func TestUsageTimesPublishesReadAndSpan(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	got := usageTimes(metaMap{"usageObservedSince": 1_700_000_000_000.0, "usageObservedThrough": 1_799_999_000_000.0}, now, true)
	if got["usageObservedAt"] != now.UTC().Format(time.RFC3339Nano) || got["usageObservedSince"] == nil || got["usageObservedThrough"] == nil {
		t.Fatalf("times %+v", got)
	}
	if usageTimes(metaMap{}, now, false)["usageObservedAt"] != nil {
		t.Fatal("a failed read must not claim a read time")
	}
}
