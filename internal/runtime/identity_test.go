package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"testing"
	"time"
)

func TestEpochBindingSurvivesRefreshButNotReplacement(t *testing.T) {
	h := openProbeStore(t)
	rt := New(nil, h, nil)
	now := int64(1800000000000)
	b := collect.Binding{Provider: "openai", AccountID: "a", Token: "synthetic-one", AccountRef: repairPtr("physical-one")}
	first, err := rt.bindingEpochs([]collect.Binding{b}, now)
	if err != nil {
		t.Fatal(err)
	}
	b.Token = "synthetic-refreshed"
	same, err := rt.bindingEpochs([]collect.Binding{b}, now+1)
	if err != nil || same["openai\x00a"] != first["openai\x00a"] {
		t.Fatal("refresh changed identity", same, err)
	}
	restarted := New(nil, h, nil)
	again, err := restarted.bindingEpochs([]collect.Binding{b}, now+2)
	if err != nil || again["openai\x00a"] != first["openai\x00a"] {
		t.Fatal("durable identity lost", again, err)
	}
	b.AccountRef = repairPtr("physical-two")
	changed, err := restarted.bindingEpochs([]collect.Binding{b}, now+3)
	if err != nil || changed["openai\x00a"] == first["openai\x00a"] {
		t.Fatal("replacement inherited identity", changed, err)
	}
	b.Provider = "devin"
	b.AccountRef = nil
	initial, err := rt.bindingEpochs([]collect.Binding{b}, now+4)
	if err != nil {
		t.Fatal(err)
	}
	next, err := New(nil, h, nil).bindingEpochs([]collect.Binding{b}, now+5)
	if err != nil || next["devin\x00a"] == initial["devin\x00a"] {
		t.Fatal("unverifiable restart inherited identity", next, err)
	}
	var count int
	if err := h.DB().QueryRow("SELECT count(*) FROM identity_epochs WHERE basis='key_material' AND physicalDigest IS NOT NULL").Scan(&count); err != nil || count != 0 {
		t.Fatal("token evidence persisted", count, err)
	}
}

func TestReadingEpochRequiresExactPublishedReading(t *testing.T) {
	now := int64(1800000000000)
	reset := now + 3600000
	for _, kind := range []string{"same", "time", "reset"} {
		t.Run(kind, func(t *testing.T) {
			p := []contract.Provider{{ID: "openai", Accounts: []contract.Account{{ID: "a", UpdatedAt: repairPtr(time.UnixMilli(now).UTC().Format(time.RFC3339Nano)), Windows: []contract.Window{{ID: "weekly", RemainingPercent: repairPtr(80.0), ResetAt: repairPtr(time.UnixMilli(reset).UTC().Format(time.RFC3339Nano))}}}}}}
			r := collect.Reading{Provider: "openai", Account: "a", WindowID: "weekly", Kind: collect.WindowOK, ObservedAt: now, RemainingPercent: repairPtr(80.0), ResetAt: &reset, Cached: true}
			if kind == "time" {
				r.ObservedAt--
			}
			if kind == "reset" {
				v := reset - 1
				r.ResetAt = &v
			}
			applyReadingEpochs(p, []collect.Reading{r}, map[string]int64{"openai\x00a": 1})
			if (p[0].Accounts[0].Windows[0].IdentityEpoch != nil) != (kind == "same") {
				t.Fatal("mismatched reading inherited epoch", kind)
			}
		})
	}
}
