package runtime

import "time"

// usageTimes publishes when the usage log was last read and the span it
// covers, as the Node collector did (usageObservedAt/Since/Through).
func usageTimes(hist interface{ Meta(string) (any, bool) }, readAt time.Time, ingested bool) map[string]any {
	out := map[string]any{"usageObservedAt": nil, "usageObservedSince": nil, "usageObservedThrough": nil}
	if hist == nil {
		return out
	}
	if ingested {
		out["usageObservedAt"] = readAt.UTC().Format(time.RFC3339Nano)
	}
	for _, key := range []string{"usageObservedSince", "usageObservedThrough"} {
		if ms, ok := metaMillis(hist, key); ok && ms > 0 {
			out[key] = time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
		}
	}
	return out
}
