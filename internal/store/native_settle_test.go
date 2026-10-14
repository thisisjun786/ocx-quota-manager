package store

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
)

func TestClaudeTranscriptCostsSettleOnceAndNothingNewIsAdded(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	nativeRate(t, h)
	day := int64(86400000)
	before := time.Now().UnixMilli() - 2*day
	at := func(e nativeusage.Event, ms int64) nativeusage.Event { e.At = ms; return e }
	priced := at(nativeEvent("settled-priced"), before)
	unpriced := at(nativeEvent("settled-unpriced"), before+1)
	unpriced.Model = "native-unpriced"
	pending := at(nativeEvent("settled-pending"), before+2)
	pending.Route, pending.Evidence = nativeusage.Unknown, "request-id-absent"
	if err = h.CommitNative("claude", nativeBatch(priced, unpriced, pending), before+1000); err != nil {
		t.Fatal(err)
	}
	// A database written by the release that still valued transcripts and added
	// them to costs: one direct row priced, one left unknown.
	storedAmount(t, h, priced.ID, .0008125)
	storedAmount(t, h, unpriced.ID, nil)
	storedAmount(t, h, pending.ID, .003)
	if _, err = h.db.Exec(`DELETE FROM native_settled; DELETE FROM meta WHERE key=?`, NativeSettledKey); err != nil {
		t.Fatal(err)
	}
	h.Close()
	if h, err = Open(dir, OpenOptions{}); err != nil {
		t.Fatal(err)
	}
	defer func() { h.Close() }()
	_, pricedUSD, _ := collected(t, h, priced)
	costRows := func() map[string]Usage {
		t.Helper()
		v, err := h.NativeUsage()
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]Usage{}
		for _, r := range v.Rows {
			if _, dup := out[r.ID]; dup {
				t.Fatal("a settled row counted twice", r.ID)
			}
			out[r.ID] = r
		}
		return out
	}
	settled := costRows()
	if len(settled) != 2 || settled[priced.ID].USD == nil || *settled[priced.ID].USD != *pricedUSD || settled[unpriced.ID].USD != nil {
		t.Fatalf("settled rows %+v", settled)
	}
	v, _ := h.NativeUsage()
	// No amount is summed for Claude Code transcripts, not even as a reference.
	if s := v.Summary["claude"]; s.Included != 2 || s.Pending != 1 || s.PendingUSD != nil || s.SettledAt == nil || s.UnsettledDirectNew+s.UnsettledDirectPast != 0 || len(v.Excluded) != 0 {
		t.Fatalf("summary %+v excluded %+v", s, v.Excluded)
	}

	// Collection goes on; nothing it does afterwards reaches the totals: a
	// settled row read again with more output, a price that becomes known, a
	// new direct row and a late one dated before the settlement.
	grown := priced
	grown.Output += 100
	if _, err = h.InsertEvidence(Evidence{Provider: "anthropic", Model: "native-unpriced", Status: "official", SourceURL: cachePtr(claudePriceSource), Rates: [4]*float64{cachePtr(1.0), cachePtr(5.0), cachePtr(.1), cachePtr(1.25)}, FirstRevision: "test", FirstSeenAt: before}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	fresh := at(nativeEvent("fresh-direct"), now)
	late := at(nativeEvent("late-direct"), before+3)
	for i := 0; i < 3; i++ {
		if err = h.CommitNative("claude", nativeBatch(grown, fresh, late), now+1000); err != nil {
			t.Fatal(err)
		}
	}
	// Collection keeps the tokens it reads and the amount stored earlier, and
	// computes no new price, not even once a tariff is known.
	if stored, usd, basis := collected(t, h, priced); stored.Output != grown.Output || usd == nil || *usd != *pricedUSD || basis != "official" {
		t.Fatal("collection stopped or restated the stored amount", stored, usd, basis)
	}
	if _, usd, _ := collected(t, h, unpriced); usd != nil {
		t.Fatal("Claude transcript repriced")
	}
	for _, e := range []nativeusage.Event{fresh, late} {
		if _, usd, basis := collected(t, h, e); usd != nil || basis != NativeNotValued {
			t.Fatal("new Claude transcript valued", usd, basis)
		}
	}
	if !reflect.DeepEqual(costRows(), settled) {
		t.Fatal("settled totals rewritten")
	}
	v, _ = h.NativeUsage()
	s := v.Summary["claude"]
	first, last := time.UnixMilli(late.At).UTC().Format(time.RFC3339Nano), time.UnixMilli(fresh.At).UTC().Format(time.RFC3339Nano)
	if s.Included != 2 || s.UnsettledDirectNew != 1 || s.UnsettledDirectPast != 1 || *s.UnsettledDirectFirst != first || *s.UnsettledDirectLast != last {
		t.Fatalf("unsettled direct evidence %+v", s)
	}

	// Reopening never settles again.
	h.Close()
	if h, err = Open(dir, OpenOptions{}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(costRows(), settled) {
		t.Fatal("reopen settled again")
	}
	if v, _ = h.NativeUsage(); v.Summary["claude"].UnsettledDirectNew != 1 {
		t.Fatal("reopen", v.Summary["claude"])
	}

	// Settled rows expire with retention like the transcript rows.
	if err = h.Maintain(now + 100*day); err != nil {
		t.Fatal(err)
	}
	if rows := costRows(); len(rows) != 0 {
		t.Fatal("settled rows outlived retention", rows)
	}
}

func TestFreshDatabaseAddsNoTranscriptCosts(t *testing.T) {
	h := openTemp(t)
	nativeRate(t, h)
	e := nativeEvent("fresh-install")
	e.At = time.Now().UnixMilli()
	if err := h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	v, _ := h.NativeUsage()
	if s := v.Summary["claude"]; len(v.Rows) != 0 || s.Included != 0 || s.UnsettledDirectNew != 1 {
		t.Fatalf("%+v", s)
	}
}

// A history too full for the settlement copy does not open, says how to make
// room, and is left exactly as it was; with room it settles normally.
func TestSettlementThatDoesNotFitStopsTheOpenAndChangesNothing(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{MaxBytes: 4 << 20})
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().UnixMilli() - 86400000
	pages := func() (n int64) {
		h.db.QueryRow(`PRAGMA page_count`).Scan(&n)
		return n
	}
	for i := 0; pages() < 236; i++ {
		tx, _ := h.db.Begin()
		for j := 0; j < 50; j++ {
			e := nativeEvent(fmt.Sprintf("fill-%d-%d", i, j))
			e.At = at + int64(i*50+j)
			raw, _ := json.Marshal(e)
			if _, err := tx.Exec(`INSERT INTO native_usage VALUES(?,?,?,?,?,?,?)`, e.ID, "claude", e.At, "direct", string(raw), .001, "official"); err != nil {
				t.Fatal(err)
			}
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = h.db.Exec(`DELETE FROM native_settled; DELETE FROM meta WHERE key=?`, NativeSettledKey); err != nil {
		t.Fatal(err)
	}
	var valued int
	h.db.QueryRow(`SELECT count(*) FROM native_usage WHERE basis='official'`).Scan(&valued)
	h.Close()

	if _, err = Open(dir, OpenOptions{MaxBytes: 1 << 20}); err == nil || !strings.Contains(err.Error(), "QUOTA_DB_MAX_MIB") {
		t.Fatal("a history too full to settle must not open:", err)
	}
	if h, err = Open(dir, OpenOptions{MaxBytes: 4 << 20}); err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	v, err := h.NativeUsage()
	if s := v.Summary["claude"]; err != nil || len(v.Rows) != valued || s.SettledAt == nil {
		t.Fatalf("settled %d of %d: %+v %v", len(v.Rows), valued, s, err)
	}
}

// A settled row whose source later turns out conflicting stays in costs as
// settled, and the conflict still shows in the diagnostic counts.
func TestSettledRowStillShowsALaterConflict(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	e := nativeEvent("settled-then-conflict")
	e.At = time.Now().UnixMilli() - 86400000
	if err = h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	storedAmount(t, h, e.ID, .002)
	if _, err = h.db.Exec(`DELETE FROM native_settled; DELETE FROM meta WHERE key=?`, NativeSettledKey); err != nil {
		t.Fatal(err)
	}
	h.Close()
	if h, err = Open(dir, OpenOptions{}); err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	other := e
	other.Model = "native-other"
	if err = h.CommitNative("claude", nativeBatch(other), e.At+1000); err != nil {
		t.Fatal(err)
	}
	if _, _, basis := collected(t, h, e); basis != "official" {
		t.Fatal("stored valuation changed", basis)
	}
	v, _ := h.NativeUsage()
	if s := v.Summary["claude"]; len(v.Rows) != 1 || *v.Rows[0].USD != .002 || s.Included != 1 || s.Conflicts != 1 || s.Unpriced != 0 || s.UnsettledDirectNew+s.UnsettledDirectPast != 0 {
		t.Fatalf("rows %d summary %+v", len(v.Rows), s)
	}
}

// A settled row without an amount counts once as unpriced, also after its
// source turns conflicting.
func TestUnpricedSettledRowCountsOnce(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	e := nativeEvent("settled-unpriced-conflict")
	e.At = time.Now().UnixMilli() - 86400000
	if err = h.CommitNative("claude", nativeBatch(e), e.At+1000); err != nil {
		t.Fatal(err)
	}
	storedAmount(t, h, e.ID, nil)
	if _, err = h.db.Exec(`DELETE FROM native_settled; DELETE FROM meta WHERE key=?`, NativeSettledKey); err != nil {
		t.Fatal(err)
	}
	h.Close()
	if h, err = Open(dir, OpenOptions{}); err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	other := e
	other.Model = "native-other"
	if err = h.CommitNative("claude", nativeBatch(other), e.At+1000); err != nil {
		t.Fatal(err)
	}
	v, _ := h.NativeUsage()
	if s := v.Summary["claude"]; len(v.Rows) != 1 || v.Rows[0].USD != nil || s.Included != 1 || s.Conflicts != 1 || s.Unpriced != 1 {
		t.Fatalf("rows %d summary %+v", len(v.Rows), s)
	}
}
