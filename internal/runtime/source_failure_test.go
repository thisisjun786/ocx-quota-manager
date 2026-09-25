package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
)

func TestInvalidCredentialSourceKeepsRosterAndRecovers(t *testing.T) {
	for _, name := range []string{"config.json", "auth.json", "codex-accounts.json"} {
		t.Run(name, func(t *testing.T) {
			home, native := writeRuntimeFixture(t)
			clk := &clock.Var{T: time.UnixMilli(1800000000000)}
			rt := New(clk, openProbeStore(t), &collect.Fake{})
			rt.Home = home
			rt.CodexHome = native
			rt.cycle(context.Background())
			before := rt.Snapshot()
			old, _ := json.Marshal(before.Providers)
			path := filepath.Join(home, name)
			valid, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			for _, bad := range []string{"{", "null", strings.Repeat(" ", 8<<20) + "{}"} {
				mustWrite(t, path, bad)
				clk.T = clk.T.Add(time.Minute)
				rt.cycle(context.Background())
				got := rt.Snapshot()
				body, _ := json.Marshal(got.Providers)
				if string(body) != string(old) || got.Analytics.(map[string]any)["status"] != "error" || *got.ObservedAt != *before.ObservedAt {
					t.Fatal("failed source replaced lastgood")
				}
			}
			mustWrite(t, path, string(valid))
			rt.cycle(context.Background())
			if rt.Snapshot().Analytics.(map[string]any)["status"] != "ok" {
				t.Fatal("did not recover")
			}
		})
	}
}
