package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

const ocxRequestID = "ocx-0123456789abcdef0123456789abcdef"

func addClaudeRecord(t *testing.T, rt *Runtime, id, request string, at int64) {
	t.Helper()
	dir := filepath.Join(rt.ClaudeHome, "projects", "project")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	row := map[string]any{"type": "assistant", "timestamp": time.UnixMilli(at).UTC().Format(time.RFC3339Nano), "message": map[string]any{"id": id, "model": "claude-test", "usage": map[string]any{"input_tokens": 100, "output_tokens": 10}}}
	if request != "" {
		row["requestId"] = request
	}
	data, _ := json.Marshal(row)
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), append(data, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
}

func claudeNativeStatus(t *testing.T, rt *Runtime) nativeStatus {
	t.Helper()
	return rt.Snapshot().Analytics.(map[string]any)["nativeUsage"].(map[string]nativeStatus)["claude"]
}

func ocxNativeRow(request string, at int64) map[string]any {
	return map[string]any{"requestId": request, "timestamp": at, "provider": "anthropic-native", "surface": "claude", "model": "claude-test", "usage": map[string]any{"inputTokens": 100, "outputTokens": 10}}
}

func TestClaudeViaOCXCountedOnceByRequestMarker(t *testing.T) {
	rt, _, clk := nativeRuntime(t)
	at := clk.Now().UnixMilli() - 1000
	writeUsageLog(t, rt.Home, []map[string]any{ocxNativeRow(ocxRequestID, at)})
	addClaudeRecord(t, rt, "msg_marker", ocxRequestID, at)
	rt.cycle(context.Background())
	if n := costRequests(t, rt); n != 1 {
		t.Fatal("OCX-relayed Claude call counted", n)
	}
	s := claudeNativeStatus(t, rt)
	if s.Proxy != 1 || s.Included != 0 || s.Pending != 0 || !reflect.DeepEqual(s.ProxyByEvidence, map[string]int{"ocx-request-marker": 1}) {
		t.Fatalf("%+v", s.NativeSummary)
	}
	if w := rt.Snapshot().Warnings; len(w) != 0 {
		t.Fatal("proxy rows warned", w)
	}
}

func TestClaudeRoutePolicyCountsWindowOnce(t *testing.T) {
	rt, h, clk := nativeRuntime(t)
	at := clk.Now().UnixMilli() - 1000
	writeUsageLog(t, rt.Home, []map[string]any{ocxNativeRow("ocx-fedcba9876543210fedcba9876543210", at)})
	addClaudeRecord(t, rt, "msg_absent", "", at)
	addClaudeRecord(t, rt, "msg_direct", "req_0123456789abcdef", at)
	if err := h.SetMeta(store.ClaudeRoutePolicyKey, map[string]any{"route": "ocx", "from": at - 60000, "until": nil, "basis": "operator-cutover"}); err != nil {
		t.Fatal(err)
	}
	rt.cycle(context.Background())
	// Costs come from OCX's log alone; the direct record is reported, not added.
	if n := costRequests(t, rt); n != 1 {
		t.Fatal("inside the window: the OCX row only", n)
	}
	s := claudeNativeStatus(t, rt)
	if s.Included != 0 || s.Proxy != 1 || s.Pending != 0 || s.ProxyByEvidence["configured-ocx-cutover"] != 1 || s.UnsettledDirectNew != 1 {
		t.Fatalf("%+v", s.NativeSummary)
	}
	p, ok := s.RoutePolicy.(*routePolicyStatus)
	if !ok || p == nil || p.From != time.UnixMilli(at-60000).UTC().Format(time.RFC3339Nano) || p.Until != nil || p.Basis != "operator-cutover" {
		t.Fatal("route policy status", s.RoutePolicy)
	}
	direct := directEvidenceWarnings(s.NativeSummary)
	if w := rt.Snapshot().Warnings; len(direct) != 1 || !reflect.DeepEqual(w, direct) {
		t.Fatal(w)
	}

	until := at
	if err := h.SetMeta(store.ClaudeRoutePolicyKey, map[string]any{"route": "ocx", "from": at - 60000, "until": until, "basis": "operator-cutover"}); err != nil {
		t.Fatal(err)
	}
	rt.cycle(context.Background())
	if n := costRequests(t, rt); n != 1 {
		t.Fatal("outside the window the record is pending; costs are unchanged", n)
	}
	s = claudeNativeStatus(t, rt)
	if s.Included != 0 || s.Proxy != 0 || s.Pending != 1 || !reflect.DeepEqual(s.PendingByReason, map[string]int{"request-id-absent": 1}) {
		t.Fatalf("%+v", s.NativeSummary)
	}
	// A pending record is diagnosis only: no cost warning, and the direct notice
	// is the same one, not a second.
	if w := rt.Snapshot().Warnings; !reflect.DeepEqual(w, direct) {
		t.Fatal(w)
	}
	raw, _ := json.Marshal(rt.Snapshot().Analytics.(map[string]any)["nativeUsage"])
	var decoded map[string]map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if policy, ok := decoded["claude"]["routePolicy"].(map[string]any); !ok || policy["until"] != time.UnixMilli(until).UTC().Format(time.RFC3339Nano) {
		t.Fatal(string(raw))
	}
	if _, ok := decoded["antigravity"]["routePolicy"]; ok {
		t.Fatal("route policy on antigravity")
	}

	if err := h.SetMeta(store.ClaudeRoutePolicyKey, nil); err != nil {
		t.Fatal(err)
	}
	rt.cycle(context.Background())
	raw, _ = json.Marshal(rt.Snapshot().Analytics.(map[string]any)["nativeUsage"])
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if policy, ok := decoded["claude"]["routePolicy"]; !ok || policy != nil {
		t.Fatal("cleared route policy must encode as null", string(raw))
	}
	for _, k := range []string{"proxyByEvidence", "pendingByReason", "conflictByReason"} {
		for _, client := range []string{"claude", "antigravity", "codex"} {
			if _, ok := decoded[client][k].(map[string]any); !ok {
				t.Fatal(client, k, string(raw))
			}
		}
	}
}

func TestNativeExclusionWarnings(t *testing.T) {
	for _, tc := range []struct {
		s    store.NativeSummary
		want []string
	}{
		{store.NativeSummary{Proxy: 4, ProxyByEvidence: map[string]int{"ocx-request-marker": 4}}, nil},
		{store.NativeSummary{Pending: 6, PendingByReason: map[string]int{"request-id-absent": 3, "request-id-unrecognized": 1, "route-unverified": 2}},
			[]string{"Antigravity 기록 6건(보존 기간 전체)은 직접 호출인지 OCX 경유인지 확인할 근거가 없어 대화 기록으로는 비용에 더하지 않았습니다(요청 ID 없음 3건, 알 수 없는 요청 ID 1건, 재확인 대기 2건)."}},
		{store.NativeSummary{Pending: 3, PendingByReason: map[string]int{"route-unverified": 1, "antigravity-unknown": 2}},
			[]string{"Antigravity 기록 3건(보존 기간 전체)은 직접 호출인지 OCX 경유인지 확인할 근거가 없어 대화 기록으로는 비용에 더하지 않았습니다(재확인 대기 1건, 기타 2건)."}},
		{store.NativeSummary{Conflicts: 2, ConflictByReason: map[string]int{"conflicting-source": 2}},
			[]string{"Antigravity 기록 2건(보존 기간 전체)은 같은 호출의 출처 정보가 서로 달라 대화 기록으로는 비용에 더하지 않았습니다."}},
		{store.NativeSummary{Pending: 1, Conflicts: 1, PendingByReason: map[string]int{"request-id-unrecognized": 1}},
			[]string{"Antigravity 기록 1건(보존 기간 전체)은 직접 호출인지 OCX 경유인지 확인할 근거가 없어 대화 기록으로는 비용에 더하지 않았습니다(알 수 없는 요청 ID 1건).", "Antigravity 기록 1건(보존 기간 전체)은 같은 호출의 출처 정보가 서로 달라 대화 기록으로는 비용에 더하지 않았습니다."}},
	} {
		got := nativeExclusionWarnings("Antigravity", tc.s)
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%+v\n got %q\nwant %q", tc.s, got, tc.want)
		}
		for _, w := range got {
			if strings.Contains(w, "확인해야 합니다") {
				t.Fatal("legacy warning", w)
			}
		}
	}
}

func TestCostPeriodsCountExcludedNativeRecords(t *testing.T) {
	now := int64(1800000000000)
	costs := costBreakdown(nil, nil, nil, now, time.UTC)
	hour := int64(3600000)
	annotateNativeExcluded(costs, []store.NativeExcluded{
		{Client: "claude", At: now - 40*24*hour}, // outside every period
		{Client: "claude", At: now - 20*24*hour},
		{Client: "claude", At: now - 3*24*hour},
		{Client: "claude", At: now - hour},
		{Client: "antigravity", At: now - hour},
		{Client: "claude", At: now - 24*hour}, // the day's boundary is exclusive, as for costs
	}, now)
	periods := costs["periods"].(map[string]any)
	for key, want := range map[string]map[string]int{
		"day":   {"claude": 1, "antigravity": 1},
		"week":  {"claude": 3, "antigravity": 1},
		"month": {"claude": 4, "antigravity": 1},
	} {
		if got := periods[key].(costPeriod).NativeExcluded; !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: %v want %v", key, got, want)
		}
	}
	raw, _ := json.Marshal(costs["periods"])
	if !strings.Contains(string(raw), `"nativeExcluded":{"antigravity":1,"claude":1}`) {
		t.Fatal(string(raw))
	}
	// Without native collection the field is absent.
	plain, _ := json.Marshal(costBreakdown(nil, nil, nil, now, time.UTC)["periods"])
	if strings.Contains(string(plain), "nativeExcluded") {
		t.Fatal(string(plain))
	}
}

func TestDirectEvidenceWarningsNameOnlyWhatTheTranscriptShows(t *testing.T) {
	if got := directEvidenceWarnings(store.NativeSummary{Pending: 9, Proxy: 3}); got != nil {
		t.Fatal("pending or proxy records warned", got)
	}
	first, last := "2026-10-09T03:00:00Z", "2026-10-09T05:30:00Z"
	got := directEvidenceWarnings(store.NativeSummary{UnsettledDirectNew: 2, UnsettledDirectPast: 1, UnsettledDirectFirst: &first, UnsettledDirectLast: &last})
	if len(got) != 1 {
		t.Fatal(got)
	}
	w := got[0]
	for _, want := range []string{"req_", "3건", "전환 이후 발생 2건", "늦게 읽힌 기록 1건", "더하지 않았습니다", "같은 호출이 OCX 사용 기록에 있는지"} {
		if !strings.Contains(w, want) {
			t.Fatalf("missing %q in %s", want, w)
		}
	}
	for _, claim := range []string{"거치지 않", "미경유", "남지 않", "처리한 응답", "$"} {
		if strings.Contains(w, claim) {
			t.Fatalf("overclaims %q: %s", claim, w)
		}
	}
}
