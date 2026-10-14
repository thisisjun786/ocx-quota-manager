package store

import (
	"reflect"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
)

// sameAsFullRead checks the cached view against one read from every stored row.
func sameAsFullRead(t *testing.T, h *History, step string) NativeView {
	t.Helper()
	got, err := h.NativeUsage()
	if err != nil {
		t.Fatal(step, err)
	}
	h.cacheMu.Lock()
	h.native = nil
	h.cacheMu.Unlock()
	want, err := h.NativeUsage()
	if err != nil {
		t.Fatal(step, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: cached view\n%+v\nfull read\n%+v", step, got.Summary, want.Summary)
	}
	return want
}

func viewCached(h *History) bool {
	h.cacheMu.Lock()
	defer h.cacheMu.Unlock()
	return h.native != nil
}

func TestAntigravityCommitsKeepTheClaudePartOfTheView(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	nativeRate(t, h)
	base := time.Now().UnixMilli() - 86400000
	ev := func(id, evidence string, route nativeusage.Route, at int64) nativeusage.Event {
		e := nativeEvent(id)
		e.Route, e.Evidence, e.At = route, evidence, at
		return e
	}
	ag := func(id, evidence string, route nativeusage.Route, at int64) nativeusage.Event {
		e := ev(id, evidence, route, at)
		e.Client, e.Provider = "antigravity", "antigravity"
		return e
	}
	// A direct row valued by an earlier release is settled on the next open.
	settled := ev("settled", "anthropic-request-header", nativeusage.Direct, base-5000)
	if err = h.CommitNative("claude", nativeBatch(settled), base); err != nil {
		t.Fatal(err)
	}
	storedAmount(t, h, settled.ID, .002)
	if _, err = h.db.Exec(`DELETE FROM native_settled; DELETE FROM meta WHERE key=?`, NativeSettledKey); err != nil {
		t.Fatal(err)
	}
	h.Close()
	if h, err = Open(dir, OpenOptions{}); err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err = h.CommitNative("claude", nativeBatch(ev("pending", "request-id-absent", nativeusage.Unknown, base)), base); err != nil {
		t.Fatal(err)
	}
	sameAsFullRead(t, h, "start")

	steps := []struct {
		name   string
		events []nativeusage.Event
		cached bool
	}{
		{"new antigravity rows", []nativeusage.Event{
			ag("ag-direct", "antigravity-generation", nativeusage.Direct, base+100),
			ag("ag-pending", "request-id-absent", nativeusage.Unknown, base+200),
			ag("ag-early", "antigravity-generation", nativeusage.Direct, base-100),
		}, true},
		{"antigravity row conflicts", func() []nativeusage.Event {
			e := ag("ag-direct", "antigravity-generation", nativeusage.Direct, base+100)
			e.Model = "native-other"
			return []nativeusage.Event{e}
		}(), true},
		{"claude row", []nativeusage.Event{ev("marker", "ocx-request-marker", nativeusage.Proxy, base)}, false},
	}
	for _, step := range steps {
		if _, err := h.NativeUsage(); err != nil {
			t.Fatal(err)
		}
		if err = h.CommitNative(step.events[0].Client, nativeBatch(step.events...), base+10000); err != nil {
			t.Fatal(step.name, err)
		}
		if viewCached(h) != step.cached {
			t.Fatalf("%s: view kept %v, want %v", step.name, viewCached(h), step.cached)
		}
		sameAsFullRead(t, h, step.name)
	}
	v := sameAsFullRead(t, h, "end")
	// The settled Claude Code row and the remaining direct Antigravity row reach
	// costs, settled first; the conflict and the pending row are left out.
	if len(v.Rows) != 2 || v.Rows[0].ID != settled.ID || len(v.Excluded) != 2 || v.Summary["claude"].Proxy != 1 || v.Summary["antigravity"].Conflicts != 1 {
		t.Fatalf("rows %+v excluded %+v summary %+v", v.Rows, v.Excluded, v.Summary)
	}
}

func TestCursorReferenceRefetchesOnlyCursorRows(t *testing.T) {
	h := openTemp(t)
	for _, u := range []Usage{
		{ID: "c1", At: 1_000, Provider: "cursor", Tokens: fp(1), USD: fp(9), Basis: strPtr("official")},
		{ID: "a1", At: 2_000, Provider: "anthropic", Tokens: fp(1), USD: fp(4), Basis: strPtr("official")},
	} {
		if err := h.InsertUsage(u); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.ListUsage(); err != nil {
		t.Fatal(err)
	}
	if err := h.SetMeta("cursorCacheReference", map[string]any{"appliedRate": 0.5}); err != nil {
		t.Fatal(err)
	}
	h.cacheMu.Lock()
	valid := h.usage.valid
	h.cacheMu.Unlock()
	if !valid {
		t.Fatal("a reference without cursor cache costs dropped the usage cache")
	}
	if _, err := h.db.Exec("INSERT INTO cursor_cache_costs VALUES ('c1',2,1,1000)"); err != nil {
		t.Fatal(err)
	}
	if err := h.SetMeta("cursorCacheReference", map[string]any{"appliedRate": 0.25}); err != nil {
		t.Fatal(err)
	}
	rows, err := h.ListUsage()
	if err != nil || len(rows) != 2 || *rows[0].USD != 1.75 || !rows[0].CacheEstimated || *rows[1].USD != 4 {
		t.Fatalf("%v %+v", err, rows)
	}
}
