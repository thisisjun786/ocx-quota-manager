package runtime

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/nativeusage"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

type nativeStore interface {
	NativeCursors(string) (map[string]nativeusage.Cursor, error)
	NativeCutoff(int64) int64
	CommitNative(string, nativeusage.Batch, int64) error
	NativeUsage() (store.NativeView, error)
}

type nativeStatus struct {
	Status         string `json:"status"`
	PendingFiles   int    `json:"pendingFiles"`
	InvalidRecords int    `json:"invalidRecords"`
	FailedFiles    int    `json:"failedFiles"`
	ObservedAt     string `json:"observedAt"`
	store.NativeSummary
}

func (rt *Runtime) markFailureWithNative(ctx context.Context, now time.Time) {
	rt.markFailure()
	if !rt.NativeEnabled {
		return
	}
	status, warnings := rt.collectNative(ctx, now)
	snapshot := rt.Snapshot()
	analytics := map[string]any{}
	if previous, ok := snapshot.Analytics.(map[string]any); ok {
		for k, v := range previous {
			analytics[k] = v
		}
	}
	analytics["nativeUsage"] = status
	if err := rt.attachNativeCosts(analytics, snapshot.Providers, now); err != nil {
		warnings = append(warnings, "도구별 비용 집계가 지연되고 있습니다.")
	}
	snapshot.Analytics = analytics
	snapshot.Warnings = append([]string{failureNote, "OCX 수집 오류와 별도로 외부 도구 사용량을 수집하고 있습니다."}, warnings...)
	rt.publish(snapshot)
}

func (rt *Runtime) collectNative(ctx context.Context, now time.Time) (map[string]nativeStatus, []string) {
	out := map[string]nativeStatus{}
	warnings := []string{}
	h, ok := rt.Store.(nativeStore)
	if !rt.NativeEnabled || !ok {
		return out, warnings
	}
	child := func(home, dir string) string {
		if home == "" {
			return ""
		}
		return filepath.Join(home, dir)
	}
	sources := []nativeusage.Source{
		{Client: "claude", Roots: []string{child(rt.ClaudeHome, "projects"), child(rt.ClaudeHome, "transcripts")}},
		{Client: "codex", Roots: []string{child(rt.CodexHome, "sessions"), child(rt.CodexHome, "archived_sessions")}},
		{Client: "antigravity", Roots: []string{child(rt.GeminiHome, "antigravity-cli/conversations"), child(rt.GeminiHome, "antigravity/conversations")}},
	}
	for _, source := range sources {
		s := nativeStatus{Status: "absent", ObservedAt: now.UTC().Format(time.RFC3339Nano)}
		cursors, err := h.NativeCursors(source.Client)
		if err == nil {
			var b nativeusage.Batch
			scanCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			b, err = nativeusage.Scan(scanCtx, source, cursors, h.NativeCutoff(now.UnixMilli()), now.UnixMilli())
			cancel()
			// A deadline may interrupt the current file after previous files were
			// completed. Persist that completed work so a large history cannot
			// restart the same batch forever. No failed file advances its cursor.
			if commitErr := h.CommitNative(source.Client, b, now.UnixMilli()); commitErr != nil {
				err = commitErr
			}
			s.PendingFiles, s.InvalidRecords, s.FailedFiles = b.Pending, b.Invalid, b.Failed
			if b.Present {
				s.Status = "ok"
			}
			if b.Pending > 0 {
				s.Status = "collecting"
			}
			if b.Failed > 0 || b.Invalid > 0 {
				s.Status = "partial"
			}
		}
		if err != nil {
			s.Status = "error"
		}
		out[source.Client] = s
	}
	view, err := h.NativeUsage()
	if err != nil {
		warnings = append(warnings, "도구별 사용량 기록을 읽지 못했습니다.")
		return out, warnings
	}
	labels := map[string]string{"claude": "Claude Code", "codex": "Codex", "antigravity": "Antigravity"}
	for _, source := range sources {
		s := out[source.Client]
		s.NativeSummary = view.Summary[source.Client]
		out[source.Client] = s
		label := labels[source.Client]
		if s.Pending+s.Conflicts > 0 {
			amount := ""
			if s.PendingUSD != nil {
				amount = fmt.Sprintf(" (별도 API 환산액 $%.2f)", *s.PendingUSD)
			}
			warnings = append(warnings, fmt.Sprintf("%s 사용량 %d건%s은 경로를 확인할 수 없어 중복 방지를 위해 통합 비용에서 제외했습니다.", label, s.Pending+s.Conflicts, amount))
		}
		if s.Status == "error" || s.Status == "partial" {
			warnings = append(warnings, label+" 사용량 수집이 일부 지연되어 확인된 기록만 표시합니다.")
		}
		if s.PendingFiles > 0 {
			warnings = append(warnings, label+" 과거 사용량을 순차 수집하고 있습니다.")
		}
	}
	return out, warnings
}

// Costs have their own collection clock. An OCX outage freezes OCX coverage,
// never the independently collected native usage. Quota calibration continues
// to consume only the original usageStore's OCX rows.
func (rt *Runtime) attachNativeCosts(analytics map[string]any, providers []contract.Provider, now time.Time) error {
	if !rt.NativeEnabled {
		return nil
	}
	ns, ok := rt.Store.(nativeStore)
	if !ok {
		return nil
	}
	view, err := ns.NativeUsage()
	if err != nil {
		return err
	}
	us, ok := rt.Store.(usageStore)
	if !ok {
		return nil
	}
	ocx, err := us.ListUsage()
	if err != nil {
		return err
	}
	evidence, err := us.ListEvidence()
	if err != nil {
		return err
	}
	bound := now.UnixMilli()
	if ms, ok := metaMillis(us, "usageObservedThrough"); ok && ms < bound {
		bound = ms
	}
	rows := make([]store.Usage, 0, len(ocx)+len(view.Rows))
	for _, r := range ocx {
		if r.At <= bound {
			rows = append(rows, r)
		}
	}
	prices, _ := priceUsage(rows, evidence, now.UnixMilli())
	for _, r := range view.Rows {
		rows = append(rows, r)
		prices = append(prices, calc.AppliedPrice{USD: r.USD, Origin: calc.OriginStored, Priced: r.USD != nil, UnknownPrice: r.USD == nil, EffectiveAt: r.At})
	}
	order := make([]int, len(rows))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(i, j int) bool { return rows[order[i]].At < rows[order[j]].At })
	sortedRows := make([]store.Usage, len(rows))
	sortedPrices := make([]calc.AppliedPrice, len(rows))
	for i, j := range order {
		sortedRows[i] = rows[j]
		sortedPrices[i] = prices[j]
	}
	analytics["costs"] = costBreakdown(sortedRows, sortedPrices, providers, now.UnixMilli(), displayLocation)
	return nil
}
