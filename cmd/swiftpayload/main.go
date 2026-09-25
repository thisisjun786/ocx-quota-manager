package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
)

// Writes a credential-free schemaVersion 1 snapshot for the existing Swift decoder.
// Linux generation is not a Mac execution result.
func main() {
	now := "2027-01-15T08:00:00.000Z"
	zero := 0.0
	snap := contract.Snapshot{
		SchemaVersion: 1,
		ObservedAt:    &now,
		Providers: []contract.Provider{{
			ID: "openai", Name: "OpenAI", Enabled: true, DefaultModel: nil,
			Accounts: []contract.Account{{
				ID: "__main__", Label: "main", Plan: nil, Status: "ok", UpdatedAt: &now,
				Windows: []contract.Window{{
					ID: "weekly", Label: "주간", RemainingPercent: &zero, ResetAt: nil, UsageScope: nil,
				}},
			}},
		}},
	}
	if err := contract.ValidateSnapshot(snap); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(snap)
}
