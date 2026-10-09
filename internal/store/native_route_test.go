package store

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
)

func TestNativeUnknownEvidenceRefinement(t *testing.T) {
	for _, tc := range []struct{ old, next, want string }{
		{"route-unverified", "request-id-absent", "request-id-absent"},
		{"route-unverified", "request-id-unrecognized", "request-id-unrecognized"},
		{"request-id-absent", "request-id-unrecognized", "request-id-unrecognized"},
		{"request-id-unrecognized", "request-id-absent", "request-id-unrecognized"},
		{"request-id-absent", "route-unverified", "request-id-absent"},
	} {
		old := nativeEvent("refine")
		old.Route, old.Evidence = nativeusage.Unknown, tc.old
		next := old
		next.Evidence = tc.next
		if got := mergeNative(old, next); got.Route != nativeusage.Unknown || got.Evidence != tc.want {
			t.Fatalf("%s + %s = %+v", tc.old, tc.next, got)
		}
		next.Output++ // A completed streaming vector keeps the refined reason.
		if got := mergeNative(old, next); got.Evidence != tc.want || got.Output != next.Output {
			t.Fatalf("streaming %s + %s = %+v", tc.old, tc.next, got)
		}
	}
}

func nativeStored(t *testing.T, h *History, id string) (string, *float64, string) {
	t.Helper()
	var raw, basis string
	var usd *float64
	if err := h.db.QueryRow(`SELECT event,usd,basis FROM native_usage WHERE id=?`, id).Scan(&raw, &usd, &basis); err != nil {
		t.Fatal(err)
	}
	return raw, usd, basis
}

func TestNativeDirectReplayKeepsStoredRowIdentical(t *testing.T) {
	h := openTemp(t)
	nativeRate(t, h)
	e := nativeEvent("direct-replay")
	if err := h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	raw, usd, basis := nativeStored(t, h, e.ID)
	if usd == nil {
		t.Fatal("direct row unpriced")
	}
	partial := e
	partial.Output-- // An earlier streaming snapshot of the same message.
	if err := h.CommitNative("claude", nativeBatch(partial, e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	raw2, usd2, basis2 := nativeStored(t, h, e.ID)
	if raw2 != raw || usd2 == nil || *usd2 != *usd || basis2 != basis {
		t.Fatal("direct replay changed the stored row")
	}
}

func TestNativeAliasModelIsNeverValued(t *testing.T) {
	h := openTemp(t)
	alias := "ocx-claude-native--gpt-6.1-sol"
	if _, err := h.InsertEvidence(Evidence{Provider: "anthropic", Model: alias, Status: "official", SourceURL: cachePtr(claudePriceSource), Rates: [4]*float64{cachePtr(10.0), cachePtr(50.0), cachePtr(1.0), cachePtr(12.5)}, FirstRevision: "test", FirstSeenAt: 1800000000000}); err != nil {
		t.Fatal(err)
	}
	e := nativeEvent("alias")
	e.Model, e.CacheWrite1h = alias, 0
	e.Route, e.Evidence = nativeusage.Proxy, "ocx-model-alias"
	for i := 0; i < 2; i++ {
		if err := h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
			t.Fatal(err)
		}
	}
	_, usd, _ := nativeStored(t, h, e.ID)
	v, _ := h.NativeUsage()
	s := v.Summary["claude"]
	if usd != nil || len(v.Rows) != 0 || s.Proxy != 1 || s.ProxyByEvidence["ocx-model-alias"] != 1 || s.Unpriced != 1 {
		t.Fatalf("alias valued or counted: %v %+v", usd, s)
	}
}

func setRoutePolicy(t *testing.T, h *History, from int64, until *int64) {
	t.Helper()
	var u any
	if until != nil {
		u = *until
	}
	if err := h.SetMeta(ClaudeRoutePolicyKey, map[string]any{"route": "ocx", "from": from, "until": u, "basis": "operator-cutover"}); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeRoutePolicyIsReadTimeAndScoped(t *testing.T) {
	h := openTemp(t)
	nativeRate(t, h)
	base := nativeEvent("x").At
	ev := func(id, evidence string, route nativeusage.Route, at int64) nativeusage.Event {
		e := nativeEvent(id)
		e.Route, e.Evidence, e.At = route, evidence, at
		return e
	}
	direct := ev("direct", "anthropic-request-header", nativeusage.Direct, base)
	events := []nativeusage.Event{
		ev("absent-in", "request-id-absent", nativeusage.Unknown, base),
		ev("absent-from", "request-id-absent", nativeusage.Unknown, base-1000),
		ev("absent-before", "request-id-absent", nativeusage.Unknown, base-1001),
		ev("absent-until", "request-id-absent", nativeusage.Unknown, base+1000),
		ev("unrecognized", "request-id-unrecognized", nativeusage.Unknown, base),
		ev("legacy", "route-unverified", nativeusage.Unknown, base),
		ev("marker", "ocx-request-marker", nativeusage.Proxy, base),
		direct,
	}
	ag := ev("ag", "request-id-absent", nativeusage.Unknown, base)
	ag.Client, ag.Provider = "antigravity", "antigravity"
	if err := h.CommitNative("claude", nativeBatch(events...), base+2000); err != nil {
		t.Fatal(err)
	}
	if err := h.CommitNative("antigravity", nativeBatch(ag), base+2000); err != nil {
		t.Fatal(err)
	}
	before, _ := h.NativeUsage()
	if s := before.Summary["claude"]; s.Pending != 6 || s.PendingByReason["request-id-absent"] != 4 || s.Proxy != 1 || before.ClaudePolicy != nil {
		t.Fatalf("%+v", s)
	}
	stored := map[string]string{}
	for _, e := range events {
		raw, _, _ := nativeStored(t, h, e.ID)
		stored[e.ID] = raw
	}
	until := base + 1000
	setRoutePolicy(t, h, base-1000, &until)
	v, _ := h.NativeUsage()
	s := v.Summary["claude"]
	want := NativeSummary{Included: 1, Pending: 4, Proxy: 3, Unpriced: 0,
		ProxyByEvidence:  map[string]int{"ocx-request-marker": 1, "configured-ocx-cutover": 2},
		PendingByReason:  map[string]int{"request-id-absent": 2, "request-id-unrecognized": 1, "route-unverified": 1},
		ConflictByReason: map[string]int{}}
	s.PendingUSD = nil
	if !reflect.DeepEqual(s, want) || len(v.Rows) != 1 || v.Rows[0].ID != direct.ID {
		t.Fatalf("policy summary %+v", s)
	}
	if v.ClaudePolicy == nil || v.ClaudePolicy.From != base-1000 || *v.ClaudePolicy.Until != until {
		t.Fatal(v.ClaudePolicy)
	}
	if a := v.Summary["antigravity"]; a.Pending != 1 || a.Proxy != 0 {
		t.Fatal("policy applied to antigravity", a)
	}
	for _, e := range events {
		if raw, _, _ := nativeStored(t, h, e.ID); raw != stored[e.ID] {
			t.Fatal("policy rewrote a stored row")
		}
	}
	setRoutePolicy(t, h, base-1000, nil)
	if v, _ = h.NativeUsage(); v.Summary["claude"].ProxyByEvidence["configured-ocx-cutover"] != 3 {
		t.Fatal("open-ended policy", v.Summary["claude"])
	}
	if err := h.SetMeta(ClaudeRoutePolicyKey, nil); err != nil {
		t.Fatal(err)
	}
	if v, _ = h.NativeUsage(); !reflect.DeepEqual(v.Summary["claude"].PendingByReason, before.Summary["claude"].PendingByReason) || v.ClaudePolicy != nil {
		t.Fatal("removing the policy did not restore pending", v.Summary["claude"])
	}
}

func TestNativeSummaryBreakdownsEncodeAsObjects(t *testing.T) {
	raw, _ := json.Marshal(NativeSummary{}.Complete())
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	for _, k := range []string{"proxyByEvidence", "pendingByReason", "conflictByReason"} {
		if _, ok := m[k].(map[string]any); !ok {
			t.Fatal(k, string(raw))
		}
	}
	h := openTemp(t)
	e := nativeEvent("conflict")
	other := e
	other.Tier = "priority"
	if err := h.CommitNative("claude", nativeBatch(e, other), e.At+1000); err != nil {
		t.Fatal(err)
	}
	v, _ := h.NativeUsage()
	if c := v.Summary["claude"].ConflictByReason; c["conflicting-source"] != 1 {
		t.Fatal(c)
	}
}

func transcriptLine(t *testing.T, id, model, request string, at time.Time) []byte {
	t.Helper()
	row := map[string]any{"type": "assistant", "timestamp": at.UTC().Format(time.RFC3339Nano), "message": map[string]any{"id": id, "model": model, "usage": map[string]any{"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20}}}
	if request != "" {
		row["requestId"] = request
	}
	b, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}

func TestClaudeEvidenceRereadTargetsRecentFilesOnce(t *testing.T) {
	h := openTemp(t)
	nativeRate(t, h)
	now := time.Now()
	dir := t.TempDir()
	recent, old := filepath.Join(dir, "recent.jsonl"), filepath.Join(dir, "old.jsonl")
	var lines []byte
	lines = append(lines, transcriptLine(t, "msg_absent", "native-test", "", now.Add(-10*time.Minute))...)
	lines = append(lines, transcriptLine(t, "msg_direct", "native-test", "req_0123456789abcdef", now.Add(-9*time.Minute))...)
	lines = append(lines, transcriptLine(t, "msg_alias", "ocx-claude-native--gpt-6-astra", "", now.Add(-8*time.Minute))...)
	if err := os.WriteFile(recent, lines, 0600); err != nil {
		t.Fatal(err)
	}
	oldAt := now.Add(-10 * 24 * time.Hour)
	if err := os.WriteFile(old, transcriptLine(t, "msg_old", "native-test", "req_abcdef0123456789", oldAt), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(old, oldAt, oldAt); err != nil {
		t.Fatal(err)
	}
	source := nativeusage.Source{Client: "claude", Roots: []string{dir}}
	nowMS := now.UnixMilli()
	first, err := nativeusage.Scan(context.Background(), source, nil, 0, nowMS)
	if err != nil || len(first.Events) != 4 {
		t.Fatal(first, err)
	}
	// Reproduce what parser revision 1 stored.
	for i, e := range first.Events {
		if e.Route != nativeusage.Direct {
			first.Events[i].Route, first.Events[i].Evidence = nativeusage.Unknown, "route-unverified"
		}
	}
	if err = h.CommitNative("claude", first, nowMS); err != nil {
		t.Fatal(err)
	}
	directID := nativeusage.Hash("native-v1", "claude", "msg_direct")
	raw, usd, basis := nativeStored(t, h, directID)
	if usd == nil {
		t.Fatal("direct row unpriced")
	}
	recentKey, oldKey := nativeusage.Hash("claude", recent), nativeusage.Hash("claude", old)
	cursors, err := h.NativeCursors("claude")
	if err != nil || cursors[recentKey].Revision != 0 || cursors[oldKey].Revision != nativeusage.Revision {
		t.Fatal("reset", cursors, err)
	}
	if _, ok := h.Meta(claudeEvidenceKey); !ok {
		t.Fatal("flag not written")
	}
	second, err := nativeusage.Scan(context.Background(), source, cursors, 0, nowMS)
	if err != nil || second.Files != 1 || len(second.Events) != 3 {
		t.Fatal("reread scope", second, err)
	}
	if err = h.CommitNative("claude", second, nowMS); err != nil {
		t.Fatal(err)
	}
	evidence := func(msg string) (string, string, *float64) {
		var route, ev string
		var usd *float64
		if err := h.db.QueryRow(`SELECT route,json_extract(event,'$.Evidence'),usd FROM native_usage WHERE id=?`, nativeusage.Hash("native-v1", "claude", msg)).Scan(&route, &ev, &usd); err != nil {
			t.Fatal(err)
		}
		return route, ev, usd
	}
	if r, ev, _ := evidence("msg_absent"); r != "unknown" || ev != "request-id-absent" {
		t.Fatal(r, ev)
	}
	if r, ev, u := evidence("msg_alias"); r != "ocx" || ev != "ocx-model-alias" || u != nil {
		t.Fatal(r, ev, u)
	}
	raw2, usd2, basis2 := nativeStored(t, h, directID)
	if raw2 != raw || *usd2 != *usd || basis2 != basis {
		t.Fatal("direct row changed by reread")
	}
	// The flag prevents a second reset even if legacy rows remain.
	legacy := nativeEvent("legacy-after")
	legacy.At, legacy.Route, legacy.Evidence = nowMS-1000, nativeusage.Unknown, "route-unverified"
	if err = h.CommitNative("claude", nativeusage.Batch{Events: []nativeusage.Event{legacy}}, nowMS); err != nil {
		t.Fatal(err)
	}
	cursors, err = h.NativeCursors("claude")
	if err != nil || cursors[recentKey].Revision != nativeusage.Revision {
		t.Fatal("second reset", cursors[recentKey], err)
	}
}

func TestClaudeEvidenceRereadWithoutLegacyRowsOnlySetsFlag(t *testing.T) {
	h := openTemp(t)
	e := nativeEvent("direct-only")
	if err := h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	cursors, err := h.NativeCursors("claude")
	if err != nil || cursors[nativeusage.Hash("path")].Revision != 1 {
		t.Fatal(cursors, err)
	}
	if v, ok := h.Meta(claudeEvidenceKey); !ok || v.(map[string]any)["resetCursors"] != 0.0 {
		t.Fatal("flag", v)
	}
}

func TestNativeProxySnapshotsNeverConflictOnCounters(t *testing.T) {
	alias := "ocx-claude-native--gpt-6.1-sol"
	// A converted OCX stream opens with OCX's prompt estimate and ends with the
	// upstream's count, cached input split out (production shape).
	first := nativeEvent("alias-stream")
	first.Model, first.Input, first.Output, first.CacheRead, first.CacheWrite, first.CacheWrite1h = alias, 34020, 0, 0, 0, 0
	first.Route, first.Evidence = nativeusage.Proxy, "ocx-model-alias"
	final := first
	final.Input, final.Output, final.CacheRead, final.At = 30252, 275, 28160, first.At+500
	for _, pair := range [][2]nativeusage.Event{{first, final}, {final, first}} {
		got := mergeNative(pair[0], pair[1])
		if got.Route != nativeusage.Proxy || got.Evidence != "ocx-model-alias" || got.Output != 275 || got.CacheRead != 28160 || got.At != first.At {
			t.Fatalf("%+v", got)
		}
	}
	// Equal output still settles on one vector whatever the order.
	estimate := final
	estimate.Input, estimate.CacheRead = 34020, 0
	if a, b := mergeNative(estimate, final), mergeNative(final, estimate); !reflect.DeepEqual(a, b) || a.CacheRead != 28160 {
		t.Fatalf("order-dependent %+v %+v", a, b)
	}
	marker := first
	marker.Model, marker.Evidence = "native-test", "ocx-request-marker"
	markerFinal := final
	markerFinal.Model, markerFinal.Evidence = "native-test", "ocx-request-marker"
	if got := mergeNative(marker, markerFinal); got.Route != nativeusage.Proxy || got.Output != 275 {
		t.Fatalf("marker %+v", got)
	}
	// A legacy conflict or route-unverified row of an alias becomes OCX's.
	for _, stored := range []nativeusage.Event{first, final} {
		stored.Route, stored.Evidence = nativeusage.Conflict, "conflicting-counters"
		if got := mergeNative(stored, final); got.Route != nativeusage.Proxy || got.Evidence != "ocx-model-alias" || got.Output != 275 {
			t.Fatalf("legacy conflict %+v", got)
		}
		stored.Route, stored.Evidence = nativeusage.Unknown, "route-unverified"
		if got := mergeNative(stored, first); got.Route != nativeusage.Proxy || got.Evidence != "ocx-model-alias" {
			t.Fatalf("legacy unknown %+v", got)
		}
	}
	// Counter disagreement still demotes calls whose cost would come from the transcript.
	for _, route := range []struct {
		r nativeusage.Route
		e string
	}{{nativeusage.Direct, "anthropic-request-header"}, {nativeusage.Unknown, "request-id-absent"}} {
		a, b := first, final
		a.Model, b.Model = "native-test", "native-test"
		a.Route, a.Evidence, b.Route, b.Evidence = route.r, route.e, route.r, route.e
		if got := mergeNative(a, b); got.Route != nativeusage.Conflict || got.Evidence != "conflicting-counters" {
			t.Fatalf("%s %+v", route.r, got)
		}
	}
	// A marker row with a stored counter conflict stays excluded.
	stored := marker
	stored.Route, stored.Evidence = nativeusage.Conflict, "conflicting-counters"
	if got := mergeNative(stored, markerFinal); got.Route != nativeusage.Conflict {
		t.Fatalf("marker conflict reopened %+v", got)
	}
	// An alias snapshot never erases a source contradiction: the same message
	// also seen as a direct call of another model stays a conflict in any order.
	direct := nativeEvent("alias-stream")
	direct.At = first.At
	for _, pair := range [][2]nativeusage.Event{{first, direct}, {direct, first}} {
		got := mergeNative(pair[0], pair[1])
		for i := 0; i < 3; i++ {
			got = mergeNative(mergeNative(got, first), direct)
		}
		if got.Route != nativeusage.Conflict || got.Evidence != "conflicting-source" {
			t.Fatalf("source contradiction hidden %+v", got)
		}
	}
	// A legacy counter conflict that later meets that contradiction records it,
	// whichever of the direct and the alias observation arrives first.
	legacy := first
	legacy.Route, legacy.Evidence = nativeusage.Conflict, "conflicting-counters"
	for _, order := range [][]nativeusage.Event{{direct, first}, {first, direct}} {
		got := legacy
		for i := 0; i < 2; i++ {
			got = mergeNative(mergeNative(got, order[0]), order[1])
		}
		if got.Route != nativeusage.Conflict || got.Evidence != "conflicting-source" {
			t.Fatalf("legacy counter conflict lost a source contradiction %+v", got)
		}
	}

	h := openTemp(t)
	var settled string
	for i, e := range []nativeusage.Event{first, final, first, estimate, final} {
		if err := h.CommitNative("claude", nativeBatch(e), final.At+1000); err != nil {
			t.Fatal(err)
		}
		raw, _, _ := nativeStored(t, h, first.ID)
		if i == 1 {
			settled = raw
		} else if i > 1 && raw != settled {
			t.Fatal("reread rewrote a settled proxy row")
		}
	}
	v, err := h.NativeUsage()
	if err != nil {
		t.Fatal(err)
	}
	if s := v.Summary["claude"]; s.Conflicts != 0 || s.Proxy != 1 || s.ProxyByEvidence["ocx-model-alias"] != 1 || len(v.Rows) != 0 {
		t.Fatalf("%+v", s)
	}
}

func permuteEvents(events []nativeusage.Event) [][]nativeusage.Event {
	if len(events) <= 1 {
		return [][]nativeusage.Event{append([]nativeusage.Event(nil), events...)}
	}
	var out [][]nativeusage.Event
	for i := range events {
		rest := append(append([]nativeusage.Event(nil), events[:i]...), events[i+1:]...)
		for _, p := range permuteEvents(rest) {
			out = append(out, append([]nativeusage.Event{events[i]}, p...))
		}
	}
	return out
}

func TestNativeMergeOrderIndependentForOCXProvenMessages(t *testing.T) {
	alias := "ocx-claude-native--gpt-6.1-sol"
	ev := func(model string, route nativeusage.Route, evidence string, v [3]int64, at int64) nativeusage.Event {
		e := nativeEvent("ocx-proven")
		e.Model, e.Route, e.Evidence, e.At = model, route, evidence, e.At+at
		e.Input, e.Output, e.CacheRead, e.CacheWrite, e.CacheWrite1h = v[0], v[1], v[2], 0, 0
		return e
	}
	// A converted stream's opening estimate and its final upstream count (production shape).
	estimate, final := [3]int64{34020, 0, 0}, [3]int64{30252, 275, 28160}
	fold := func(seed *nativeusage.Event, order []nativeusage.Event) nativeusage.Event {
		got := order[0]
		if seed != nil {
			got = mergeNative(*seed, got)
		}
		for _, e := range order[1:] {
			got = mergeNative(got, e)
		}
		return got
	}
	legacyConflict := ev(alias, nativeusage.Conflict, "conflicting-counters", estimate, 0)
	for _, tc := range []struct {
		name     string
		set      []nativeusage.Event
		evidence string
	}{
		// Parser revision 1 stored aliases as unknown or, with a req_ ID, direct.
		{"alias", []nativeusage.Event{ev(alias, nativeusage.Unknown, "route-unverified", estimate, 0), ev(alias, nativeusage.Direct, "anthropic-request-header", final, 300),
			ev(alias, nativeusage.Proxy, "ocx-model-alias", estimate, 100), ev(alias, nativeusage.Proxy, "ocx-request-marker", final, 200)}, "ocx-model-alias"},
		{"marker", []nativeusage.Event{ev("native-test", nativeusage.Unknown, "request-id-absent", estimate, 0),
			ev("native-test", nativeusage.Proxy, "ocx-request-marker", estimate, 100), ev("native-test", nativeusage.Proxy, "ocx-request-marker", final, 200)}, "ocx-request-marker"},
	} {
		var want *nativeusage.Event
		seeds := []*nativeusage.Event{nil}
		if tc.name == "alias" {
			seeds = append(seeds, &legacyConflict)
		}
		for _, seed := range seeds {
			for _, order := range permuteEvents(tc.set) {
				got := fold(seed, order)
				again := got
				for _, e := range order {
					again = mergeNative(again, e)
				}
				if !reflect.DeepEqual(again, got) {
					t.Fatalf("%s: a reread changed %+v to %+v", tc.name, got, again)
				}
				if want == nil {
					want = &got
				} else if !reflect.DeepEqual(*want, got) {
					t.Fatalf("%s: order-dependent %+v vs %+v", tc.name, *want, got)
				}
			}
		}
		if want.Route != nativeusage.Proxy || want.Evidence != tc.evidence || want.Output != 275 || want.CacheRead != 28160 || want.At != nativeEvent("x").At {
			t.Fatalf("%s: %+v", tc.name, *want)
		}
		// The same message also seen as a direct call of another model is a
		// contradiction in every order, also after a legacy counter conflict.
		other := nativeEvent("ocx-proven")
		other.Model = "claude-other"
		for _, seed := range []*nativeusage.Event{nil, &legacyConflict} {
			if seed != nil && tc.name != "alias" {
				continue
			}
			for _, order := range permuteEvents(append([]nativeusage.Event{other}, tc.set[1:]...)) {
				if got := fold(seed, order); got.Route != nativeusage.Conflict || got.Evidence != "conflicting-source" {
					t.Fatalf("%s: contradiction hidden %+v", tc.name, got)
				}
			}
		}
	}
}

func TestNativeUnprovenCounterConflictFollowsTheRouteProof(t *testing.T) {
	ev := func(route nativeusage.Route, evidence string, v [3]int64, at int64) nativeusage.Event {
		e := nativeEvent("unproven")
		e.Route, e.Evidence, e.At = route, evidence, e.At+at
		e.Input, e.Output, e.CacheRead, e.CacheWrite, e.CacheWrite1h = v[0], v[1], v[2], 0, 0
		return e
	}
	estimate, final := [3]int64{34020, 0, 0}, [3]int64{30252, 275, 28160}
	a, b := ev(nativeusage.Unknown, "request-id-absent", estimate, 100), ev(nativeusage.Unknown, "request-id-absent", final, 200)
	marker := ev(nativeusage.Proxy, "ocx-request-marker", estimate, 0)
	direct := ev(nativeusage.Direct, "anthropic-request-header", estimate, 0)
	// A settled OCX row must match exactly; a conflict keeps the payload of the
	// observation that first demoted it, so only its route and reason must
	// match, and only its route when direct and OCX proofs meet (the reason
	// then names whichever disagreement was seen first).
	settle := func(set []nativeusage.Event, routeOnly bool) nativeusage.Event {
		var want *nativeusage.Event
		for _, order := range permuteEvents(set) {
			h := openTemp(t)
			for _, e := range append(order, order...) { // read, then reread
				if err := h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
					t.Fatal(err)
				}
			}
			raw, _, _ := nativeStored(t, h, a.ID)
			var got nativeusage.Event
			if err := json.Unmarshal([]byte(raw), &got); err != nil {
				t.Fatal(err)
			}
			if want == nil {
				want = &got
				continue
			}
			if got.Route == nativeusage.Conflict && got.Route == want.Route && (routeOnly || got.Evidence == want.Evidence && got.Unproven == want.Unproven) {
				continue
			}
			if !reflect.DeepEqual(*want, got) {
				t.Fatalf("order-dependent %+v vs %+v", *want, got)
			}
		}
		return *want
	}
	// Unproven snapshots alone disagree: a conflict, as before.
	if got := settle([]nativeusage.Event{a, b}, false); got.Route != nativeusage.Conflict || got.Evidence != "conflicting-counters" || !got.Unproven {
		t.Fatalf("unproven %+v", got)
	}
	// An OCX proof settles them on the later snapshot in any order.
	if got := settle([]nativeusage.Event{a, b, marker}, false); got.Route != nativeusage.Proxy || got.Evidence != "ocx-request-marker" || got.Output != 275 || got.CacheRead != 28160 || got.At != marker.At || got.Unproven {
		t.Fatalf("proxy %+v", got)
	}
	// A direct proof keeps the conflict in any order.
	if got := settle([]nativeusage.Event{a, b, direct}, false); got.Route != nativeusage.Conflict || got.Unproven {
		t.Fatalf("direct %+v", got)
	}
	// Direct and OCX proofs of one message contradict each other in any order.
	if got := settle([]nativeusage.Event{a, b, direct, marker}, true); got.Route != nativeusage.Conflict {
		t.Fatalf("contradiction %+v", got)
	}
}

func TestNativeAliasRuleIsClaudeOnly(t *testing.T) {
	// Only Claude Code models name OCX picker aliases; another source's model
	// that happens to start with ocx- keeps its own route.
	e := nativeEvent("antigravity-ocx-model")
	e.Client, e.Provider, e.PriceProvider, e.Model = "antigravity", "antigravity", "antigravity", "ocx-test"
	e.Route, e.Evidence = nativeusage.Direct, "antigravity-generation"
	if got := mergeNative(e, e); got.Route != nativeusage.Direct || got.Evidence != "antigravity-generation" {
		t.Fatalf("%+v", got)
	}
}

func TestNativeViewListsOnlyExcludedCandidates(t *testing.T) {
	h := openTemp(t)
	base := nativeEvent("x").At
	ev := func(id string, route nativeusage.Route, evidence string, at int64) nativeusage.Event {
		e := nativeEvent(id)
		e.Route, e.Evidence, e.At = route, evidence, at
		return e
	}
	conflict := ev("conflict", nativeusage.Direct, "anthropic-request-header", base+3)
	fork := conflict
	fork.Input, fork.Output = conflict.Input+1, conflict.Output-1
	if err := h.CommitNative("claude", nativeBatch(
		ev("direct", nativeusage.Direct, "anthropic-request-header", base),
		ev("marker", nativeusage.Proxy, "ocx-request-marker", base+1),
		ev("absent", nativeusage.Unknown, "request-id-absent", base+2),
		conflict, fork,
	), base+10000); err != nil {
		t.Fatal(err)
	}
	ag := ev("ag", nativeusage.Unknown, "request-id-absent", base+4)
	ag.Client, ag.Provider = "antigravity", "antigravity"
	if err := h.CommitNative("antigravity", nativeBatch(ag), base+10000); err != nil {
		t.Fatal(err)
	}
	v, err := h.NativeUsage()
	if err != nil {
		t.Fatal(err)
	}
	want := []NativeExcluded{{"claude", base + 2}, {"claude", base + 3}, {"antigravity", base + 4}}
	if !reflect.DeepEqual(v.Excluded, want) {
		t.Fatalf("%+v", v.Excluded)
	}
	// A record the cutover policy attributes to OCX is no longer left out.
	setRoutePolicy(t, h, base, nil)
	if v, _ = h.NativeUsage(); !reflect.DeepEqual(v.Excluded, want[1:]) {
		t.Fatalf("policy %+v", v.Excluded)
	}
}
