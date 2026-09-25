package runtime

import (
	"strings"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

// Preserve the declared measurement contract. A reset timestamp alone does not
// establish fixed-window semantics (for example, OpenCode's rolling window).
func directObservation(row collect.Reading) store.Observation {
	source, version := row.Provider+"/"+row.Endpoint, "go-percent-1"
	method, scope, unit := "calculated_percent", row.WindowID, "percent"
	semantics := "unknown"
	switch row.Provider + "/" + row.Endpoint {
	case "anthropic/oauth-usage":
		version, method, scope = "anthropic-oauth-usage-1", "reported_percent", "all"
		if strings.HasPrefix(row.WindowID, "custom-") {
			scope = strings.TrimPrefix(row.WindowID, "custom-")
		}
		if row.ResetAt != nil {
			semantics = "fixed_reset"
		}
	case "devin/user-status":
		version, method, scope = "devin-user-status-1", "reported_percent", "all"
		if row.ResetAt != nil {
			semantics = "fixed_reset"
		}
	case "xai/grok-credits":
		version, method, scope = "xai-grok-credits-1", "reported_percent", "all"
		if row.ResetAt != nil {
			semantics = "fixed_reset"
		}
	case "openai/wham-usage":
		// The parser currently omits the wire duration-declaration flag. Do not
		// upgrade a default weekly name to a verified fixed reset window.
		method, scope = "reported_percent", "all"
	case "cursor/period-usage", "opencode-go/usage":
		method = "reported_percent"
		if row.Provider == "opencode-go" && row.WindowID == "five-hour" {
			semantics = "sliding"
		}
	}
	o := store.Observation{Provider: row.Provider, Account: row.Account, Window: row.WindowID, At: row.ObservedAt,
		Basis: string(row.Kind), WindowSemantics: semantics, LimitState: "missing", PrecisionEvidence: "unknown",
		Reconciliation: "unverified", UsedAccumulation: "unknown", ObservedPercent: *row.UsedPercent,
		Source: &source, SourceVersion: &version, Method: &method, ScopeKey: &scope, Unit: &unit, Reset: row.ResetAt}
	if method == "reported_percent" {
		o.ReportedPercent = row.UsedPercent
	} else {
		o.CalculatedPercent = row.UsedPercent
	}
	if row.ResetAt != nil {
		cycle := time.UnixMilli(*row.ResetAt).UTC().Format(time.RFC3339Nano)
		o.CycleKey = &cycle
	}
	return o
}
