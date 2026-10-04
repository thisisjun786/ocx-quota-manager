package store

import (
	"math"
	"testing"

	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
)

func nativeEvent(id string) nativeusage.Event {
	return nativeusage.Event{ID: nativeusage.Hash(id), Client: "claude", Provider: "anthropic", PriceProvider: "anthropic", Model: "native-test", At: 1800000000000, Input: 130, Output: 5, CacheRead: 100, CacheWrite: 20, CacheWrite1h: 15, Route: nativeusage.Direct, Evidence: "anthropic-request-header"}
}
func nativeBatch(e ...nativeusage.Event) nativeusage.Batch {
	return nativeusage.Batch{Events: e, Cursors: map[string]nativeusage.Cursor{nativeusage.Hash("path"): {Revision: 1, Offset: 100, Size: 100}}}
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
	if err != nil || len(v.Rows) != 1 {
		t.Fatal(v, err)
	}
	// $10/M uncached, $50/M output, $1/M read, $12.5/M 5m,
	// $20/M 1h => 10*10 + 5*50 + 100*1 + 5*12.5 + 15*20.
	want := 812.5 / 1e6
	if v.Rows[0].USD == nil || math.Abs(*v.Rows[0].USD-want) > 1e-12 {
		t.Fatalf("price %v want %v", v.Rows[0].USD, want)
	}
	newer := e
	newer.Output = 10
	if err = h.CommitNative("claude", nativeBatch(newer, e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	v, _ = h.NativeUsage()
	if len(v.Rows) != 1 || *v.Rows[0].Output != 10 {
		t.Fatal("old clone reduced usage", v)
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
	v, _ = h.NativeUsage()
	if len(v.Rows) != 1 || *v.Rows[0].Output != 10 {
		t.Fatal("restart duplicate", v)
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
	if len(v.Rows) != 0 || v.Summary["claude"].Pending != 1 || v.Summary["claude"].PendingUSD == nil {
		t.Fatal(v)
	}
	if err := h.Maintain(e.At + 100*86400000); err != nil {
		t.Fatal(err)
	}
	v, _ = h.NativeUsage()
	if len(v.Summary) != 0 {
		t.Fatal("retention", v)
	}
	if err := h.CommitNative("claude", nativeBatch(e), e.At+100*86400000); err != nil {
		t.Fatal(err)
	}
	v, _ = h.NativeUsage()
	if len(v.Summary) != 0 {
		t.Fatal("rescan resurrected excluded usage")
	}
}

func TestNativePriceBecomesKnownWithoutSourceReplay(t *testing.T) {
	h := openTemp(t)
	e := nativeEvent("later-price")
	if err := h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	v, _ := h.NativeUsage()
	if v.Rows[0].USD != nil {
		t.Fatal("invented price")
	}
	nativeRate(t, h)
	for i := 0; i < 2; i++ {
		if err := h.CommitNative("claude", nativeusage.Batch{}, e.At+1000); err != nil {
			t.Fatal(err)
		}
	}
	v, _ = h.NativeUsage()
	if v.Rows[0].USD == nil {
		t.Fatal("unchanged source stayed unpriced")
	}
	cur, _ := h.NativeCursors("claude")
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
