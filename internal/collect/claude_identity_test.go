package collect

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
)

func TestClaudeNativeIdentityDeduplication(t *testing.T) {
	for _, tc := range []struct {
		name       string
		nativeUUID string
		ocxUUID    string
		noConfig   bool
		reauth     bool
		noToken    bool
		wantNative bool
	}{
		{name: "same UUID with different tokens", nativeUUID: "physical", ocxUUID: "physical"},
		{name: "different UUID", nativeUUID: "other", ocxUUID: "physical", wantNative: true},
		{name: "missing native identity", ocxUUID: "physical", wantNative: true},
		{name: "missing OCX identity", nativeUUID: "physical", wantNative: true},
		{name: "both identities missing", wantNative: true},
		{name: "reauth does not bypass OCX", nativeUUID: "physical", ocxUUID: "physical", reauth: true},
		{name: "missing token does not duplicate roster", nativeUUID: "physical", ocxUUID: "physical", noToken: true},
		{name: "unconfigured OCX account keeps native", nativeUUID: "physical", ocxUUID: "physical", noConfig: true, wantNative: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given two credential sources, with deliberately different tokens.
			home, native := writeSnapshotFixture(t)
			credential := map[string]any{"access": "OCX_TOKEN", "accountId": tc.ocxUUID}
			if tc.noToken {
				delete(credential, "access")
			}
			writeJSON(t, filepath.Join(home, "auth.json"), map[string]any{
				"anthropic": map[string]any{"accounts": []any{map[string]any{
					"id": "a1", "credential": credential, "needsReauth": tc.reauth,
				}}},
			})
			if tc.noConfig {
				writeJSON(t, filepath.Join(home, "config.json"), map[string]any{"providers": map[string]any{}})
			}
			writeJSON(t, filepath.Join(native, ".credentials.json"), map[string]any{
				"claudeAiOauth": map[string]any{"accessToken": "NATIVE_TOKEN"},
			})
			if tc.nativeUUID != "" {
				writeJSON(t, native+".json", map[string]any{
					"oauthAccount": map[string]any{"accountUuid": tc.nativeUUID},
				})
			}
			now := time.UnixMilli(fixtureNowMS).UTC()

			// When the real reader and scheduler process both sources.
			local, err := (Reader{Home: home, ClaudeHome: native}).LoadLocal(now)
			if err != nil {
				t.Fatal(err)
			}
			fake := &Fake{}
			rows := NewScheduler(clock.Fixed{T: now}, fake).Collect(context.Background(), local.Bindings, []string{"anthropic"})
			providers := MergeDirect(local.Providers, rows, now)

			// Then only a distinct or unidentified native account is collected.
			nativeFound := false
			for _, b := range local.Bindings {
				if b.AccountID == "claude-native" {
					nativeFound = true
				}
			}
			if nativeFound != tc.wantNative {
				t.Fatalf("native binding = %t, want %t", nativeFound, tc.wantNative)
			}
			wantCalls := 0
			if tc.wantNative {
				wantCalls++
			}
			if !tc.noConfig && !tc.reauth && !tc.noToken {
				wantCalls++
			}
			if len(fake.Calls) != wantCalls {
				t.Fatalf("external requests = %d, want %d", len(fake.Calls), wantCalls)
			}
			for _, p := range providers {
				for _, a := range p.Accounts {
					if !tc.wantNative && a.ID == "claude-native" {
						t.Fatal("duplicate native account reappeared after merging direct readings")
					}
				}
			}
		})
	}
}
