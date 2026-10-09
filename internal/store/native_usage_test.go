package store

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
)

func TestAntigravityParserCorrectionPreservesCompletedUsage(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	nativeRate(t, h)
	old := nativeEvent("parser-correction")
	old.Client, old.Provider, old.Evidence = "antigravity", "antigravity", "antigravity-generation"
	old.Input += 900
	if err := h.CommitNative("antigravity", nativeBatch(old), old.At+1000); err != nil {
		t.Fatal(err)
	}
	before, _ := h.NativeUsage() // Populate cache before correction.
	next := old
	next.Input -= 900
	next.Output-- // A stale partial copy must not lower the completed output.
	next.ParserRevision, next.ModelEnum = nativeusage.AntigravityRevision, 900
	if err := h.CommitNative("antigravity", nativeBatch(next), old.At+1000); err != nil {
		t.Fatal(err)
	}
	partial, _ := h.NativeUsage()
	if *partial.Rows[0].Input != float64(old.Input) {
		t.Fatal("partial source authorized correction")
	}
	next.Output = old.Output
	if err := h.CommitNative("antigravity", nativeBatch(next), old.At+1000); err != nil {
		t.Fatal(err)
	}
	view, err := h.NativeUsage()
	if err != nil || len(view.Rows) != 1 || *view.Rows[0].Input != 130 || *view.Rows[0].Output != 5 || *view.Rows[0].USD >= *before.Rows[0].USD {
		t.Fatalf("correction failed: %#v %v", view, err)
	}
	var corrected nativeusage.Event
	var raw string
	if err := h.db.QueryRow(`SELECT event FROM native_usage WHERE id=?`, old.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(raw), &corrected); err != nil {
		t.Fatal(err)
	}
	want := old
	want.Input -= 900
	want.ParserRevision, want.ModelEnum = nativeusage.AntigravityRevision, 900
	if !reflect.DeepEqual(corrected, want) {
		t.Fatalf("provenance changed: %+v", corrected)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h, err = Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for i := 0; i < 2; i++ {
		if err := h.CommitNative("antigravity", nativeBatch(next, old), old.At+1000); err != nil {
			t.Fatal(err)
		}
	}
	var replay string
	if err := h.db.QueryRow(`SELECT event FROM native_usage WHERE id=?`, old.ID).Scan(&replay); err != nil {
		t.Fatal(err)
	}
	if raw != replay {
		t.Fatal("replay changed corrected ledger")
	}
	if n, _ := h.Count("usage"); n != 0 {
		t.Fatal("OCX ledger changed")
	}
}

func TestAntigravityCorrectionRequiresMatchingLegacyVector(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		for _, staleEnum := range []int64{0, 10, 101} {
			old := nativeEvent("matching-legacy")
			old.Client, old.Provider, old.Evidence = "antigravity", "antigravity", "antigravity-generation"
			old.Input, old.CacheRead, old.CacheWrite, old.CacheWrite1h = 100, 0, 0, 0
			correct := old
			correct.Input, correct.ParserRevision, correct.ModelEnum = 80, nativeusage.AntigravityRevision, 20
			stale := correct
			stale.Input, stale.ModelEnum = 60, staleEnum
			sequence := []nativeusage.Event{stale, correct}
			if reverse {
				sequence = []nativeusage.Event{correct, stale}
			}
			got := old
			for i := 0; i < 2; i++ {
				for _, e := range sequence {
					got = mergeNative(got, e)
				}
			}
			if !reflect.DeepEqual(got, correct) {
				t.Fatalf("reverse=%v enum=%d got=%+v", reverse, staleEnum, got)
			}
		}
	}
}

func TestAntigravityCorrectionCannotEraseConflict(t *testing.T) {
	old := nativeEvent("conflict-correction")
	old.Client, old.Provider = "antigravity", "antigravity"
	old.Route, old.Evidence = nativeusage.Conflict, "conflicting-source"
	next := old
	next.Route, next.Evidence = nativeusage.Direct, "antigravity-generation"
	next.ParserRevision, next.ModelEnum = nativeusage.AntigravityRevision, 10
	if got := mergeNative(old, next); !reflect.DeepEqual(got, old) {
		t.Fatal("conflict revived")
	}
}

func nativeEvent(id string) nativeusage.Event {
	return nativeusage.Event{ID: nativeusage.Hash(id), Client: "claude", Provider: "anthropic", PriceProvider: "anthropic", Model: "native-test", At: 1800000000000, Input: 130, Output: 5, CacheRead: 100, CacheWrite: 20, CacheWrite1h: 15, Route: nativeusage.Direct, Evidence: "anthropic-request-header"}
}
func nativeBatch(e ...nativeusage.Event) nativeusage.Batch {
	return nativeusage.Batch{Events: e, Cursors: map[string]nativeusage.Cursor{nativeusage.Hash("path"): {Revision: 1, Offset: 100, Size: 100}}}
}

// collected reads one transcript row as collection stored it.
func collected(t *testing.T, h *History, e nativeusage.Event) (stored nativeusage.Event, usd *float64, basis string) {
	t.Helper()
	var raw string
	if err := h.db.QueryRow(`SELECT event,usd,basis FROM native_usage WHERE id=?`, e.ID).Scan(&raw, &usd, &basis); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		t.Fatal(err)
	}
	return stored, usd, basis
}

func nativeCount(t *testing.T, h *History) (n int) {
	t.Helper()
	if err := h.db.QueryRow(`SELECT count(*) FROM native_usage`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func nativeRate(t *testing.T, h *History) {
	t.Helper()
	_, err := h.InsertEvidence(Evidence{Provider: "anthropic", Model: "native-test", Status: "official", SourceURL: cachePtr(claudePriceSource), Rates: [4]*float64{cachePtr(10.0), cachePtr(50.0), cachePtr(1.0), cachePtr(12.5)}, FirstRevision: "test", FirstSeenAt: 1800000000000})
	if err != nil {
		t.Fatal(err)
	}
}

func TestNativeIdempotenceStreamingConflictAndReopen(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	nativeRate(t, h)
	e := nativeEvent("one")
	if err = h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	if err = h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	v, err := h.NativeUsage()
	if err != nil || len(v.Rows) != 0 || nativeCount(t, h) != 1 {
		t.Fatal(v, err)
	}
	if _, usd, _ := collected(t, h, e); usd != nil {
		t.Fatal("Claude transcript valued", *usd)
	}
	newer := e
	newer.Output = 10
	if err = h.CommitNative("claude", nativeBatch(newer, e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	if stored, _, _ := collected(t, h, e); nativeCount(t, h) != 1 || stored.Output != 10 {
		t.Fatal("old clone reduced usage", stored)
	}
	if n, _ := h.Count("usage"); n != 0 {
		t.Fatal("native polluted OCX", n)
	}
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}
	h, err = Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err = h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	if stored, _, _ := collected(t, h, e); nativeCount(t, h) != 1 || stored.Output != 10 {
		t.Fatal("restart duplicate", stored)
	}
	proxy := newer
	proxy.Route = nativeusage.Proxy
	if err = h.CommitNative("claude", nativeBatch(proxy, e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	v, _ = h.NativeUsage()
	if len(v.Rows) != 0 || v.Summary["claude"].Conflicts != 1 {
		t.Fatal("demotion undone by old clone", v)
	}
}

func TestNativeAtomicityPendingAndRetention(t *testing.T) {
	h := openTemp(t)
	nativeRate(t, h)
	e := nativeEvent("pending")
	e.Route = nativeusage.Unknown
	bad := nativeEvent("bad")
	bad.Input = -1
	if err := h.CommitNative("claude", nativeBatch(e, bad), e.At+1000); err == nil {
		t.Fatal("invalid batch committed")
	}
	cur, _ := h.NativeCursors("claude")
	if len(cur) != 0 {
		t.Fatal("cursor advanced on rollback")
	}
	if err := h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	v, _ := h.NativeUsage()
	if len(v.Rows) != 0 || v.Summary["claude"].Pending != 1 || v.Summary["claude"].PendingUSD != nil {
		t.Fatal(v)
	}
	if err := h.Maintain(e.At + 100*86400000); err != nil {
		t.Fatal(err)
	}
	if v, _ = h.NativeUsage(); v.Summary["claude"].Pending != 0 || nativeCount(t, h) != 0 {
		t.Fatal("retention", v)
	}
	if err := h.CommitNative("claude", nativeBatch(e), e.At+100*86400000); err != nil {
		t.Fatal(err)
	}
	if v, _ = h.NativeUsage(); v.Summary["claude"].Pending != 0 || nativeCount(t, h) != 0 {
		t.Fatal("rescan resurrected excluded usage")
	}
}

// Antigravity transcripts are still valued: a price that becomes known fills
// an unknown amount without rereading the source. Claude Code rows stay unvalued.
func TestNativePriceBecomesKnownWithoutSourceReplay(t *testing.T) {
	h := openTemp(t)
	e := nativeEvent("later-price")
	e.Client, e.Provider = "antigravity", "antigravity"
	c := nativeEvent("later-price-claude")
	if err := h.CommitNative("antigravity", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	if err := h.CommitNative("claude", nativeBatch(c), c.At+1000); err != nil {
		t.Fatal(err)
	}
	if _, usd, _ := collected(t, h, e); usd != nil {
		t.Fatal("invented price")
	}
	nativeRate(t, h)
	for i := 0; i < 2; i++ {
		for _, client := range []string{"antigravity", "claude"} {
			if err := h.CommitNative(client, nativeusage.Batch{}, e.At+1000); err != nil {
				t.Fatal(err)
			}
		}
	}
	// $10/M uncached, $50/M output, $1/M read, $12.5/M 5m,
	// $20/M 1h => 10*10 + 5*50 + 100*1 + 5*12.5 + 15*20.
	if _, usd, _ := collected(t, h, e); usd == nil || math.Abs(*usd-812.5/1e6) > 1e-12 {
		t.Fatal("unchanged source stayed unpriced", usd)
	}
	if _, usd, basis := collected(t, h, c); usd != nil || basis != NativeNotValued {
		t.Fatal("Claude transcript repriced", usd, basis)
	}
	cur, _ := h.NativeCursors("antigravity")
	if cur[nativeusage.Hash("path")].Offset != 100 {
		t.Fatal("repricing moved source cursor")
	}
}

func TestNativeIncomparableTokensAndTierConflictStayExcluded(t *testing.T) {
	for _, kind := range []string{"tokens", "tier"} {
		t.Run(kind, func(t *testing.T) {
			h := openTemp(t)
			e := nativeEvent(kind)
			other := e
			if kind == "tokens" {
				other.Input++
				other.Output--
			} else {
				other.Tier = "priority"
			}
			if err := h.CommitNative("claude", nativeBatch(e, other, e), e.At+1000); err != nil {
				t.Fatal(err)
			}
			v, _ := h.NativeUsage()
			if len(v.Rows) != 0 || v.Summary["claude"].Conflicts != 1 {
				t.Fatal(v)
			}
		})
	}
}
