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
	if n := costRequests(t, rt); n != 2 {
		t.Fatal("inside the window: OCX row plus one direct call", n)
	}
	s := claudeNativeStatus(t, rt)
	if s.Included != 1 || s.Proxy != 1 || s.Pending != 0 || s.ProxyByEvidence["configured-ocx-cutover"] != 1 {
		t.Fatalf("%+v", s.NativeSummary)
	}
	p, ok := s.RoutePolicy.(*routePolicyStatus)
	if !ok || p == nil || p.From != time.UnixMilli(at-60000).UTC().Format(time.RFC3339Nano) || p.Until != nil || p.Basis != "operator-cutover" {
		t.Fatal("route policy status", s.RoutePolicy)
	}
	if w := rt.Snapshot().Warnings; len(w) != 0 {
		t.Fatal(w)
	}

	until := at
	if err := h.SetMeta(store.ClaudeRoutePolicyKey, map[string]any{"route": "ocx", "from": at - 60000, "until": until, "basis": "operator-cutover"}); err != nil {
		t.Fatal(err)
	}
	rt.cycle(context.Background())
	if n := costRequests(t, rt); n != 2 {
		t.Fatal("outside the window the record is pending, the direct call stays included", n)
	}
	s = claudeNativeStatus(t, rt)
	if s.Included != 1 || s.Proxy != 0 || s.Pending != 1 || !reflect.DeepEqual(s.PendingByReason, map[string]int{"request-id-absent": 1}) {
		t.Fatalf("%+v", s.NativeSummary)
	}
	want := "Claude Code 기록 1건은 직접 호출인지 OCX 경유인지 확인할 근거가 없어 비용에서 제외했습니다(요청 ID 없음 1건)."
	if w := rt.Snapshot().Warnings; len(w) != 1 || w[0] != want {
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
			[]string{"Claude Code 기록 6건은 직접 호출인지 OCX 경유인지 확인할 근거가 없어 비용에서 제외했습니다(요청 ID 없음 3건, 알 수 없는 요청 ID 1건, 재확인 대기 2건)."}},
		{store.NativeSummary{Pending: 3, PendingByReason: map[string]int{"route-unverified": 1, "antigravity-unknown": 2}},
			[]string{"Claude Code 기록 3건은 직접 호출인지 OCX 경유인지 확인할 근거가 없어 비용에서 제외했습니다(재확인 대기 1건, 기타 2건)."}},
		{store.NativeSummary{Conflicts: 2, ConflictByReason: map[string]int{"conflicting-source": 2}},
			[]string{"Claude Code 기록 2건은 같은 호출의 출처 정보가 서로 달라 비용에서 제외했습니다."}},
		{store.NativeSummary{Pending: 1, Conflicts: 1, PendingByReason: map[string]int{"request-id-unrecognized": 1}},
			[]string{"Claude Code 기록 1건은 직접 호출인지 OCX 경유인지 확인할 근거가 없어 비용에서 제외했습니다(알 수 없는 요청 ID 1건).", "Claude Code 기록 1건은 같은 호출의 출처 정보가 서로 달라 비용에서 제외했습니다."}},
	} {
		got := nativeExclusionWarnings("Claude Code", tc.s)
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
