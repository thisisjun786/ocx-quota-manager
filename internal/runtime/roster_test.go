package runtime

import (
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"testing"
	"time"
)

type rosterMemory struct{ data map[string]any }

func (m *rosterMemory) Meta(k string) (any, bool)     { v, ok := m.data[k]; return v, ok }
func (m *rosterMemory) SetMeta(k string, v any) error { m.data[k] = v; return nil }
func TestRoster_reportsRemovalAfterBaseline(t *testing.T) {
	// Given
	now := time.UnixMilli(1800000000000)
	m := &rosterMemory{data: map[string]any{}}
	p := []contract.Provider{{ID: "cursor", SupportedModels: []string{"old", "new"}, Analytics: map[string]any{}}}
	if err := recordRoster(p, nil, m, now); err != nil {
		t.Fatal(err)
	}
	// When
	p[0].SupportedModels = []string{"new"}
	if err := recordRoster(p, nil, m, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	attachRoster(p, m)
	// Then
	view := p[0].Analytics.(map[string]any)["modelRoster"].(map[string]any)
	if view["listedCount"] != 1 || view["knownCount"] != 2 || view["status"] != "ok" {
		t.Fatalf("roster: %+v", view)
	}
	changes := view["changes"].([]map[string]any)
	if len(changes) != 1 || changes[0]["change"] != "removed" || changes[0]["model"] != "old" {
		t.Fatalf("changes: %+v", changes)
	}
}
