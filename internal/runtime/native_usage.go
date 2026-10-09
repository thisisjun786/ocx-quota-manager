package runtime

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
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
	WaitingFiles   int    `json:"waitingFiles"`
	InvalidRecords int    `json:"invalidRecords"`
	FailedFiles    int    `json:"failedFiles"`
	ObservedAt     string `json:"observedAt"`
	store.NativeSummary
	// Set only on Claude Code, where a typed nil pointer encodes as null;
	// other sources omit it.
	RoutePolicy any `json:"routePolicy,omitempty"`
}

type routePolicyStatus struct {
	From  string  `json:"from"`
	Until *string `json:"until"`
	Basis string  `json:"basis"`
}

func routePolicyView(p *store.ClaudeRoutePolicy) *routePolicyStatus {
	if p == nil {
		return nil
	}
	out := &routePolicyStatus{From: time.UnixMilli(p.From).UTC().Format(time.RFC3339Nano), Basis: "operator-cutover"}
	if p.Until != nil {
		until := time.UnixMilli(*p.Until).UTC().Format(time.RFC3339Nano)
		out.Until = &until
	}
	return out
}

// nativeExclusionWarnings explains why candidates of a client whose transcripts
// add to costs (Antigravity) were left out. Proxy rows are OCX's own records and
// need no explanation. The counts cover the retained history, while the cost
// screen shows a period, so the text says so.
func nativeExclusionWarnings(label string, s store.NativeSummary) []string {
	var out []string
	if s.Pending > 0 {
		var reasons []string
		known := 0
		for _, r := range []struct{ key, text string }{
			{"request-id-absent", "요청 ID 없음"}, {"request-id-unrecognized", "알 수 없는 요청 ID"}, {"route-unverified", "재확인 대기"},
		} {
			if n := s.PendingByReason[r.key]; n > 0 {
				reasons = append(reasons, fmt.Sprintf("%s %d건", r.text, n))
				known += n
			}
		}
		other := 0
		for _, n := range s.PendingByReason {
			other += n
		}
		if other -= known; other > 0 {
			reasons = append(reasons, fmt.Sprintf("기타 %d건", other))
		}
		detail := ""
		if len(reasons) > 0 {
			detail = "(" + strings.Join(reasons, ", ") + ")"
		}
		out = append(out, fmt.Sprintf("%s 기록 %d건(보존 기간 전체)은 직접 호출인지 OCX 경유인지 확인할 근거가 없어 대화 기록으로는 비용에 더하지 않았습니다%s.", label, s.Pending, detail))
	}
	if s.Conflicts > 0 {
		out = append(out, fmt.Sprintf("%s 기록 %d건(보존 기간 전체)은 같은 호출의 출처 정보가 서로 달라 대화 기록으로는 비용에 더하지 않았습니다.", label, s.Conflicts))
	}
	return out
}

// directEvidenceWarnings reports Claude Code transcript rows that carry an
// Anthropic request ID (req_) but were not settled into costs. Costs come from
// OCX's usage log alone. The rows are counted once by ID and not added to
// costs; no amount is estimated. The text states what the transcript shows and
// what to check, and makes no claim about the path the call took.
func directEvidenceWarnings(s store.NativeSummary) []string {
	n := s.UnsettledDirectNew + s.UnsettledDirectPast
	if n == 0 || s.UnsettledDirectFirst == nil || s.UnsettledDirectLast == nil {
		return nil
	}
	var kinds []string
	if s.UnsettledDirectNew > 0 {
		kinds = append(kinds, fmt.Sprintf("비용 기준 전환 이후 발생 %d건", s.UnsettledDirectNew))
	}
	if s.UnsettledDirectPast > 0 {
		kinds = append(kinds, fmt.Sprintf("전환 이전 시각이지만 늦게 읽힌 기록 %d건", s.UnsettledDirectPast))
	}
	when := func(raw string) string {
		t, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return raw
		}
		return t.In(displayLocation).Format("01-02 15:04")
	}
	return []string{fmt.Sprintf("Claude Code 대화 기록에서 Anthropic 요청 ID(req_)가 남은 응답 %d건(%s, %s~%s)을 확인했습니다. 비용은 OCX 사용 기록으로만 집계하므로 이 기록은 더하지 않았습니다. 같은 호출이 OCX 사용 기록에 있는지와 Claude Code의 호출 경로를 확인하세요.",
		n, strings.Join(kinds, " · "), when(*s.UnsettledDirectFirst), when(*s.UnsettledDirectLast))}
}

// annotateNativeExcluded counts, per cost period, the native candidates that period
// leaves out (pending or conflicting route evidence), so the screen can state what
// its total does not include. OCX-routed candidates are already OCX's rows.
func annotateNativeExcluded(costs map[string]any, excluded []store.NativeExcluded, now int64) {
	periods, _ := costs["periods"].(map[string]any)
	for _, period := range breakdownPeriods {
		p, ok := periods[period.key].(costPeriod)
		if !ok {
			continue
		}
		from := now - period.hours*calc.HourMs
		counts := map[string]int{}
		for _, e := range excluded {
			if e.At > from && e.At <= now {
				counts[e.Client]++
			}
		}
		p.NativeExcluded = counts
		periods[period.key] = p
	}
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
		{Client: "antigravity", Roots: []string{child(rt.GeminiHome, "antigravity-cli/conversations"), child(rt.GeminiHome, "antigravity/conversations")}},
	}
	// This deployment's Codex traffic is entirely routed through OCX. Its
	// authoritative usage is already ingested there; reading the local client
	// transcripts would duplicate the same calls and create false exclusions.
	out["codex"] = nativeStatus{Status: "via-ocx", ObservedAt: now.UTC().Format(time.RFC3339Nano), NativeSummary: store.NativeSummary{}.Complete()}
	for _, source := range sources {
		s := nativeStatus{Status: "absent", ObservedAt: now.UTC().Format(time.RFC3339Nano), NativeSummary: store.NativeSummary{}.Complete()}
		if source.Client == "claude" {
			s.RoutePolicy = (*routePolicyStatus)(nil)
		}
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
			s.WaitingFiles = b.Waiting
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
	labels := map[string]string{"claude": "Claude Code", "antigravity": "Antigravity"}
	for _, source := range sources {
		s := out[source.Client]
		s.NativeSummary = view.Summary[source.Client].Complete()
		if source.Client == "claude" {
			s.RoutePolicy = routePolicyView(view.ClaudePolicy)
		}
		out[source.Client] = s
		label := labels[source.Client]
		if source.Client == "claude" {
			// Claude Code transcripts no longer add to costs: their unresolved
			// routes need no cost warning, only new direct evidence does.
			warnings = append(warnings, directEvidenceWarnings(s.NativeSummary)...)
		} else {
			warnings = append(warnings, nativeExclusionWarnings(label, s.NativeSummary)...)
		}
		if s.Status == "error" {
			warnings = append(warnings, label+" 사용량을 읽지 못했습니다.")
		} else if s.FailedFiles > 0 {
			warnings = append(warnings, fmt.Sprintf("%s 사용량 파일 %d개를 읽지 못했습니다.", label, s.FailedFiles))
		} else if s.InvalidRecords > 0 {
			warnings = append(warnings, fmt.Sprintf("%s 사용 기록 %d건의 형식을 확인해야 합니다.", label, s.InvalidRecords))
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
	rows = applyOllamaCacheAssumption(rows)
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
	costs := costBreakdown(sortedRows, sortedPrices, providers, now.UnixMilli(), displayLocation)
	annotateNativeExcluded(costs, view.Excluded, now.UnixMilli())
	analytics["costs"] = costs
	return nil
}
