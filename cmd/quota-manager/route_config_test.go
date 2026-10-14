package main

import (
	"testing"

	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func TestClaudeRoutePolicyConfig(t *testing.T) {
	h, err := store.Open(t.TempDir(), store.OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	at := int64(1791500000000) // 2026-10-08T22:53:20Z
	e := nativeusage.Event{ID: nativeusage.Hash("absent"), Client: "claude", Provider: "anthropic", PriceProvider: "anthropic", Model: "claude-test", At: at, Input: 10, Output: 1, Route: nativeusage.Unknown, Evidence: "request-id-absent"}
	if err = h.CommitNative("claude", nativeusage.Batch{Events: []nativeusage.Event{e}}, at+1000); err != nil {
		t.Fatal(err)
	}
	proxy := func() int {
		v, err := h.NativeUsage()
		if err != nil {
			t.Fatal(err)
		}
		return v.Summary["claude"].ProxyByEvidence["configured-ocx-cutover"]
	}
	if proxy() != 0 {
		t.Fatal("policy without configuration")
	}
	if err = configureClaudeRoute(h, "2026-10-09T04:42:18+09:00", ""); err != nil {
		t.Fatal(err)
	}
	got, _ := h.Meta(store.ClaudeRoutePolicyKey)
	m := got.(map[string]any)
	if m["from"] != float64(1791488538000) || m["until"] != nil || m["route"] != "ocx" || m["basis"] != "operator-cutover" {
		t.Fatal(m)
	}
	if proxy() != 1 {
		t.Fatal("policy change did not refresh the native view")
	}
	if err = configureClaudeRoute(h, "", ""); err != nil {
		t.Fatal(err)
	}
	if again, _ := h.Meta(store.ClaudeRoutePolicyKey); again.(map[string]any)["from"] != m["from"] {
		t.Fatal("empty override lost the policy")
	}
	if err = configureClaudeRoute(h, "2026-10-08T00:00:00Z", "2026-10-08T22:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if got, _ = h.Meta(store.ClaudeRoutePolicyKey); got.(map[string]any)["until"] != float64(1791496800000) {
		t.Fatal(got)
	}
	if proxy() != 0 {
		t.Fatal("record after until counted as OCX")
	}
	for _, tc := range [][2]string{
		{"2026-10-08T00:00:00Z", "2026-10-08T00:00:00Z"},
		{"2026-10-08T00:00:00Z", "2026-10-07T00:00:00Z"},
		{"2026-10-08T00:00:00", ""},
		{"yesterday", ""},
		{"2026-10-08T00:00:00Z", "tomorrow"},
		{"", "2026-10-08T00:00:00Z"},
	} {
		if configureClaudeRoute(h, tc[0], tc[1]) == nil {
			t.Fatal("accepted", tc)
		}
	}
	if err = configureClaudeRoute(h, "off", ""); err != nil {
		t.Fatal(err)
	}
	if got, _ = h.Meta(store.ClaudeRoutePolicyKey); got != nil {
		t.Fatal("off did not clear", got)
	}
	if proxy() != 0 {
		t.Fatal("cleared policy still applied")
	}
}
