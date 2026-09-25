// port-harness drives JUN-272 collect/DB cases against the same runtime the
// quota-manager binary uses. Fake transport only; no live provider calls.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/httpserver"
	rt "github.com/thisisjun786/ocx-quota-manager/internal/runtime"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
	"github.com/thisisjun786/ocx-quota-manager/webembed"
)

type Request struct {
	Mode       string     `json:"mode"`
	Home       string     `json:"home"`
	CodexHome  string     `json:"codexHome"`
	ClaudeHome string     `json:"claudeHome"`
	Data       string     `json:"data"`
	NowMS      int64      `json:"nowMs"`
	Direct     []string   `json:"direct"`
	Fake       []fakeSpec `json:"fake"`
	Cycles     int        `json:"cycles"`
	Host       string     `json:"host"`
	Port       int        `json:"port"`
	DelayMS    int        `json:"delayMs"`
	SlowDBMS   int        `json:"slowDbMs"`
	Writes     dbWrites   `json:"writes"`
}

type fakeSpec struct {
	Host   string `json:"host"`
	Status int    `json:"status"`
	Body   string `json:"body"`
	Err    string `json:"err"`
}

type dbWrites struct {
	Usage          []usageIn `json:"usage"`
	Observations   []obsIn   `json:"observations"`
	Evidence       []eviIn   `json:"evidence"`
	DuplicateUsage []string  `json:"duplicateUsage"`
}

type usageIn struct {
	ID, Provider, Account, Model, Basis string
	At                                  int64
	Input, Output, Cached, Tokens, USD  *float64
}

type obsIn struct {
	Provider, Account, Window, Basis string
	At                               int64
	ObservedPercent                  float64
	Reset                            *int64
}

type eviIn struct {
	Provider, Model, Status, FirstRevision string
	FirstSeenAt                            int64
	Input, Output                          *float64
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		return errors.New("port-harness: empty stdin")
	}
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		return err
	}
	if req.NowMS == 0 {
		req.NowMS = 1_800_000_000_000
	}
	if req.Host == "" {
		req.Host = "127.0.0.1"
	}
	switch req.Mode {
	case "snapshot":
		return encode(runSnapshot(req))
	case "db-write":
		return encode(runDBWrite(req))
	case "db-read":
		return encode(runDBRead(req))
	case "cases":
		return encode(runCases(req))
	case "serve":
		return runServe(req)
	case "rss":
		return encode(map[string]any{"rssKb": rssKB(), "allocBytes": allocBytes(), "note": "this is harness-process RSS, not the quota-manager binary"})
	default:
		return fmt.Errorf("unknown mode %q", req.Mode)
	}
}

func encode(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

func runSnapshot(req Request) map[string]any {
	hist, err := store.Open(req.Data, store.OpenOptions{})
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	defer hist.Close()
	var st store.Store = hist
	if req.SlowDBMS > 0 {
		st = &delayHistory{History: hist, delay: time.Duration(req.SlowDBMS) * time.Millisecond}
	}
	fake := buildFake(req)
	clk := &clock.Var{T: time.UnixMilli(req.NowMS).UTC()}
	app := rt.New(clk, st, fake)
	app.Home = req.Home
	app.CodexHome = req.CodexHome
	app.ClaudeHome = req.ClaudeHome
	app.Direct = req.Direct
	cycles := req.Cycles
	if cycles <= 0 {
		cycles = 1
	}
	var walls []float64
	var cpuUsec []int64
	var writeBytes []int64
	ctx := context.Background()
	for i := 0; i < cycles; i++ {
		cpuBefore := rusageUsec()
		writeBefore := ioWriteBytes()
		t0 := time.Now()
		app.CycleForTest(ctx)
		walls = append(walls, time.Since(t0).Seconds()*1000)
		cpuAfter, writeAfter := rusageUsec(), ioWriteBytes()
		cpuDelta, writeDelta := int64(-1), int64(-1)
		if cpuBefore >= 0 && cpuAfter >= cpuBefore {
			cpuDelta = cpuAfter - cpuBefore
		}
		if writeBefore >= 0 && writeAfter >= writeBefore {
			writeDelta = writeAfter - writeBefore
		}
		cpuUsec = append(cpuUsec, cpuDelta)
		writeBytes = append(writeBytes, writeDelta)
	}
	snap := app.Snapshot()
	return map[string]any{
		"ok":            true,
		"snapshot":      snap,
		"collectWallMs": walls,
		"cpuUsec":       cpuUsec,
		"writeBytes":    writeBytes,
		"externalCalls": fake.CallCount(),
		"rssKb":         rssKB(),
		"allocBytes":    allocBytes(),
		"resourceNote":  "cpuUsec and writeBytes are deltas around CycleForTest only, matching the Node collector timing; writeBytes is /proc/self/io wchar volume, not file-size footprint",
	}
}

func runDBWrite(req Request) map[string]any {
	hist, err := store.Open(req.Data, store.OpenOptions{})
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	defer hist.Close()
	for _, u := range req.Writes.Usage {
		row := store.Usage{ID: u.ID, At: u.At, Provider: u.Provider, Input: u.Input, Output: u.Output, Cached: u.Cached, Tokens: u.Tokens, USD: u.USD}
		if u.Account != "" {
			a := u.Account
			row.Account = &a
		}
		if u.Model != "" {
			m := u.Model
			row.Model = &m
		}
		if u.Basis != "" {
			b := u.Basis
			row.Basis = &b
		}
		if err := hist.InsertUsage(row); err != nil {
			return map[string]any{"ok": false, "error": err.Error()}
		}
	}
	for _, o := range req.Writes.Observations {
		row := store.Observation{
			Provider: o.Provider, Account: o.Account, Window: o.Window, At: o.At, Basis: o.Basis,
			ObservedPercent: o.ObservedPercent, Reset: o.Reset,
			LimitState: "missing", WindowSemantics: "unknown", PrecisionEvidence: "unknown",
			Reconciliation: "unverified", UsedAccumulation: "unknown",
		}
		if err := hist.InsertObservation(row); err != nil {
			return map[string]any{"ok": false, "error": err.Error()}
		}
	}
	for _, e := range req.Writes.Evidence {
		ev := store.Evidence{
			Provider: e.Provider, Model: e.Model, Status: e.Status,
			Rates:      [4]*float64{e.Input, e.Output, nil, nil},
			Conditions: []string{}, Unsupported: []string{},
			FirstRevision: e.FirstRevision, FirstSeenAt: e.FirstSeenAt,
		}
		if _, err := hist.InsertEvidence(ev); err != nil {
			return map[string]any{"ok": false, "error": err.Error()}
		}
	}
	before, _ := hist.Count("usage")
	for _, id := range req.Writes.DuplicateUsage {
		_ = hist.InsertUsage(store.Usage{ID: id, At: req.NowMS, Provider: "openai"})
	}
	after, _ := hist.Count("usage")
	dump := dumpHistory(hist)
	dump["ok"] = true
	dump["duplicateChangedCount"] = after != before
	return dump
}

func runDBRead(req Request) map[string]any {
	hist, err := store.Open(req.Data, store.OpenOptions{})
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	defer hist.Close()
	dump := dumpHistory(hist)
	dump["ok"] = true
	return dump
}

func dumpHistory(hist *store.History) map[string]any {
	usage, _ := hist.ListUsage()
	obs, _ := hist.ListObservations()
	ev, _ := hist.ListEvidence()
	cur, hasCur := hist.UsageCursor()
	tables, _ := hist.Tables()
	schemaErr := hist.HasRequiredSchema()
	counts := map[string]int{}
	for _, name := range []string{"usage", "quota_observations", "price_evidence", "usage_prices", "samples", "identity_epochs", "meta"} {
		n, _ := hist.Count(name)
		counts[name] = n
	}
	usageOut := make([]map[string]any, 0, len(usage))
	for _, u := range usage {
		usageOut = append(usageOut, map[string]any{
			"id": u.ID, "at": u.At, "provider": u.Provider,
			"account": u.Account, "model": u.Model, "usd": u.USD, "basis": u.Basis,
			"input": u.Input, "output": u.Output, "tokens": u.Tokens,
			"cacheEstimated": u.CacheEstimated, "estimatedCachedTokens": u.EstimatedCachedTokens, "noCacheUsd": u.NoCacheUSD,
		})
	}
	obsOut := make([]map[string]any, 0, len(obs))
	for _, o := range obs {
		obsOut = append(obsOut, map[string]any{
			"provider": o.Provider, "account": o.Account, "window": o.Window,
			"at": o.At, "observedPercent": o.ObservedPercent, "basis": o.Basis,
		})
	}
	evOut := make([]map[string]any, 0, len(ev))
	for _, e := range ev {
		evOut = append(evOut, map[string]any{"provider": e.Provider, "model": e.Model, "status": e.Status, "rates": e.Rates})
	}
	out := map[string]any{
		"usage": usageOut, "observations": obsOut, "evidence": evOut,
		"tables": tables, "counts": counts,
		"schemaOK": schemaErr == nil,
	}
	if schemaErr != nil {
		out["schemaError"] = schemaErr.Error()
	}
	if hasCur {
		out["cursor"] = cur
	}
	return out
}

type caseResult struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Detail any    `json:"detail,omitempty"`
	Error  string `json:"error,omitempty"`
}

func runCases(req Request) map[string]any {
	if req.Data == "" {
		return map[string]any{"ok": false, "error": "data dir required"}
	}
	var results []caseResult
	results = append(results, caseFailIsolated(req))
	results = append(results, caseRealZero(req))
	results = append(results, caseEmpty(req))
	results = append(results, casePartial(req))
	results = append(results, caseRestart(req))
	results = append(results, caseOneOutage(req))
	results = append(results, caseLate(req))
	results = append(results, caseSlowDB(req))
	results = append(results, caseRefreshNoExtra(req))
	ok := true
	for _, r := range results {
		if !r.OK {
			ok = false
		}
	}
	return map[string]any{"ok": ok, "cases": results, "rssKb": rssKB()}
}

func caseFailIsolated(req Request) caseResult {
	home, data := caseDirs(req, "fail")
	writeDirectHome(home)
	fake := &collect.Fake{}
	fake.SetHost("chatgpt.com", transport.Response{}, errors.New("refused"))
	app, hist, err := boot(req, home, data, fake, []string{"openai"}, 0)
	if err != nil {
		return caseResult{ID: "fail", Error: err.Error()}
	}
	defer hist.Close()
	app.CycleForTest(context.Background())
	snap := app.Snapshot()
	n, _ := hist.Count("quota_observations")
	if n != 0 {
		return caseResult{ID: "fail", Detail: fmt.Sprintf("stored %d observations for a failed collect", n)}
	}
	if secretIn(snap) {
		return caseResult{ID: "fail", Detail: "secret leaked"}
	}
	return caseResult{ID: "fail", OK: true, Detail: map[string]any{"observations": n, "providers": len(snap.Providers)}}
}

func caseRealZero(req Request) caseResult {
	home, data := caseDirs(req, "zero")
	writeDirectHome(home)
	fake := &collect.Fake{}
	fake.SetHost("chatgpt.com", transport.Response{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":0,"limit_window_seconds":604800}}}`)}, nil)
	app, hist, err := boot(req, home, data, fake, []string{"openai"}, 0)
	if err != nil {
		return caseResult{ID: "real0", Error: err.Error()}
	}
	defer hist.Close()
	app.CycleForTest(context.Background())
	snap := app.Snapshot()
	acc := findAcc(snap, "openai", "key:default")
	if acc == nil || len(acc.Windows) == 0 || acc.Windows[0].RemainingPercent == nil || *acc.Windows[0].RemainingPercent != 100 {
		return caseResult{ID: "real0", Detail: acc}
	}
	n, _ := hist.Count("quota_observations")
	if n < 1 {
		return caseResult{ID: "real0", Detail: "measured zero was not stored"}
	}
	rows, _ := hist.ListObservations()
	if len(rows) == 0 || rows[0].ObservedPercent != 0 {
		return caseResult{ID: "real0", Detail: rows}
	}
	return caseResult{ID: "real0", OK: true, Detail: map[string]any{"remaining": *acc.Windows[0].RemainingPercent, "stored": rows[0].ObservedPercent}}
}

func caseEmpty(req Request) caseResult {
	home, data := caseDirs(req, "empty")
	writeDirectHome(home)
	fake := &collect.Fake{}
	fake.SetHost("chatgpt.com", transport.Response{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{}}`)}, nil)
	app, hist, err := boot(req, home, data, fake, []string{"openai"}, 0)
	if err != nil {
		return caseResult{ID: "empty", Error: err.Error()}
	}
	defer hist.Close()
	app.CycleForTest(context.Background())
	n, _ := hist.Count("quota_observations")
	if n != 0 {
		return caseResult{ID: "empty", Detail: "empty window stored as observation"}
	}
	snap := app.Snapshot()
	if snap.SchemaVersion != 1 {
		return caseResult{ID: "empty", Detail: "schema"}
	}
	return caseResult{ID: "empty", OK: true, Detail: map[string]any{"observations": n, "providers": len(snap.Providers)}}
}

func casePartial(req Request) caseResult {
	home, data := caseDirs(req, "partial")
	writeDirectHome(home)
	fake := &collect.Fake{}
	fake.SetHost("chatgpt.com", transport.Response{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":40,"limit_window_seconds":604800}}}`)}, nil)
	app, hist, err := boot(req, home, data, fake, []string{"openai"}, 0)
	if err != nil {
		return caseResult{ID: "partial", Error: err.Error()}
	}
	defer hist.Close()
	app.CycleForTest(context.Background())
	snap := app.Snapshot()
	acc := findAcc(snap, "openai", "key:default")
	if acc == nil || len(acc.Windows) == 0 || acc.Windows[0].RemainingPercent == nil || *acc.Windows[0].RemainingPercent != 60 {
		return caseResult{ID: "partial", Detail: acc}
	}
	return caseResult{ID: "partial", OK: true, Detail: map[string]any{"remaining": *acc.Windows[0].RemainingPercent}}
}

func caseRestart(req Request) caseResult {
	home, data := caseDirs(req, "restart")
	writeDirectHome(home)
	fake := &collect.Fake{}
	fake.SetHost("chatgpt.com", transport.Response{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":25,"limit_window_seconds":604800}}}`)}, nil)
	app, hist, err := boot(req, home, data, fake, []string{"openai"}, 0)
	if err != nil {
		return caseResult{ID: "restart", Error: err.Error()}
	}
	app.CycleForTest(context.Background())
	first := app.Snapshot()
	_ = hist.Close()
	hist2, err := store.Open(data, store.OpenOptions{})
	if err != nil {
		return caseResult{ID: "restart", Error: err.Error()}
	}
	defer hist2.Close()
	app2 := rt.New(&clock.Var{T: time.UnixMilli(req.NowMS).UTC()}, hist2, fake)
	app2.Home, app2.CodexHome, app2.ClaudeHome, app2.Direct = home, home, filepath.Join(home, "noclaude"), []string{"openai"}
	bootSnap := app2.Snapshot()
	if bootSnap.SchemaVersion != 1 {
		return caseResult{ID: "restart", Detail: "boot snapshot missing"}
	}
	app2.CycleForTest(context.Background())
	second := app2.Snapshot()
	acc := findAcc(second, "openai", "key:default")
	if acc == nil || len(acc.Windows) == 0 {
		return caseResult{ID: "restart", Detail: map[string]any{"first": first, "second": second}}
	}
	return caseResult{ID: "restart", OK: true, Detail: map[string]any{"bootProviders": len(bootSnap.Providers), "after": acc.Windows[0].RemainingPercent}}
}

func caseOneOutage(req Request) caseResult {
	home, data := caseDirs(req, "outage")
	writeBothHome(home)
	fake := &collect.Fake{}
	fake.SetHost("chatgpt.com", transport.Response{}, errors.New("openai down"))
	fake.SetHost("api.anthropic.com", transport.Response{Status: 200, Body: []byte(`{"five_hour":{"utilization":40}}`)}, nil)
	app, hist, err := boot(req, home, data, fake, []string{"openai", "anthropic"}, 0)
	if err != nil {
		return caseResult{ID: "one-outage", Error: err.Error()}
	}
	defer hist.Close()
	app.CycleForTest(context.Background())
	snap := app.Snapshot()
	if contract.ValidateSnapshot(snap) != nil {
		return caseResult{ID: "one-outage", Detail: "snapshot failed validation after one-provider outage"}
	}
	claude := findAcc(snap, "anthropic", "a1")
	if claude == nil {
		// cache-projected anthropic may still be present from local
		if len(snap.Providers) == 0 {
			return caseResult{ID: "one-outage", Detail: "no providers after isolated outage"}
		}
	}
	rows, _ := hist.ListObservations()
	for _, r := range rows {
		if r.Provider == "openai" && r.ObservedPercent == 0 && r.Window == "" {
			return caseResult{ID: "one-outage", Detail: "unknown openai stored as 0"}
		}
	}
	return caseResult{ID: "one-outage", OK: true, Detail: map[string]any{"providers": len(snap.Providers), "observations": len(rows), "calls": fake.CallCount()}}
}

func caseLate(req Request) caseResult {
	home, data := caseDirs(req, "late")
	writeDirectHome(home)
	fake := &collect.Fake{Delay: 800 * time.Millisecond}
	fake.SetHost("chatgpt.com", transport.Response{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":10,"limit_window_seconds":604800}}}`)}, nil)
	app, hist, err := boot(req, home, data, fake, []string{"openai"}, 0)
	if err != nil {
		return caseResult{ID: "late", Error: err.Error()}
	}
	defer hist.Close()
	srv, err := httpserver.New(httpserver.Options{Host: "127.0.0.1", Port: 18911, Public: webembed.FS(), Snapshot: app.Snapshot})
	if err != nil {
		return caseResult{ID: "late", Error: err.Error()}
	}
	if err := srv.Listen(); err != nil {
		return caseResult{ID: "late", Error: err.Error()}
	}
	defer srv.Close()
	done := make(chan struct{})
	go func() {
		app.CycleForTest(context.Background())
		close(done)
	}()
	t0 := time.Now()
	res, err := http.Get("http://" + srv.Addr() + "/api/v1/snapshot")
	httpMs := time.Since(t0).Seconds() * 1000
	if err != nil {
		return caseResult{ID: "late", Error: err.Error()}
	}
	res.Body.Close()
	<-done
	if httpMs > 400 {
		return caseResult{ID: "late", Detail: fmt.Sprintf("snapshot blocked on late collect: %.1fms", httpMs)}
	}
	return caseResult{ID: "late", OK: true, Detail: map[string]any{"httpMs": httpMs}}
}

func caseSlowDB(req Request) caseResult {
	home, data := caseDirs(req, "slowdb")
	writeDirectHome(home)
	fake := &collect.Fake{}
	fake.SetHost("chatgpt.com", transport.Response{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":15,"limit_window_seconds":604800}}}`)}, nil)
	hist, err := store.Open(data, store.OpenOptions{})
	if err != nil {
		return caseResult{ID: "slow-db", Error: err.Error()}
	}
	defer hist.Close()
	st := &delayHistory{History: hist, delay: 600 * time.Millisecond}
	clk := &clock.Var{T: time.UnixMilli(req.NowMS).UTC()}
	app := rt.New(clk, st, fake)
	app.Home, app.CodexHome, app.ClaudeHome, app.Direct = home, home, filepath.Join(home, "noclaude"), []string{"openai"}
	srv, err := httpserver.New(httpserver.Options{Host: "127.0.0.1", Port: 18912, Public: webembed.FS(), Snapshot: app.Snapshot})
	if err != nil {
		return caseResult{ID: "slow-db", Error: err.Error()}
	}
	if err := srv.Listen(); err != nil {
		return caseResult{ID: "slow-db", Error: err.Error()}
	}
	defer srv.Close()
	done := make(chan struct{})
	go func() {
		app.CycleForTest(context.Background())
		close(done)
	}()
	t0 := time.Now()
	res, err := http.Get("http://" + srv.Addr() + "/api/v1/snapshot")
	httpMs := time.Since(t0).Seconds() * 1000
	if err != nil {
		return caseResult{ID: "slow-db", Error: err.Error()}
	}
	res.Body.Close()
	<-done
	if httpMs > 400 {
		return caseResult{ID: "slow-db", Detail: fmt.Sprintf("snapshot blocked on slow DB: %.1fms", httpMs)}
	}
	return caseResult{ID: "slow-db", OK: true, Detail: map[string]any{"httpMs": httpMs}}
}

func caseRefreshNoExtra(req Request) caseResult {
	home, data := caseDirs(req, "refresh")
	writeDirectHome(home)
	fake := &collect.Fake{}
	fake.SetHost("chatgpt.com", transport.Response{Status: 200, Body: []byte(`{"account_id":"account","rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":604800}}}`)}, nil)
	app, hist, err := boot(req, home, data, fake, []string{"openai"}, 0)
	if err != nil {
		return caseResult{ID: "refresh-no-extra", Error: err.Error()}
	}
	defer hist.Close()
	app.CycleForTest(context.Background())
	before := fake.CallCount()
	srv, err := httpserver.New(httpserver.Options{Host: "127.0.0.1", Port: 18913, Public: webembed.FS(), Snapshot: app.Snapshot})
	if err != nil {
		return caseResult{ID: "refresh-no-extra", Error: err.Error()}
	}
	if err := srv.Listen(); err != nil {
		return caseResult{ID: "refresh-no-extra", Error: err.Error()}
	}
	defer srv.Close()
	for i := 0; i < 5; i++ {
		res, err := http.Get("http://" + srv.Addr() + "/api/v1/snapshot")
		if err != nil {
			return caseResult{ID: "refresh-no-extra", Error: err.Error()}
		}
		res.Body.Close()
	}
	after := fake.CallCount()
	if after != before {
		return caseResult{ID: "refresh-no-extra", Detail: fmt.Sprintf("HTTP refresh increased transport calls %d -> %d", before, after)}
	}
	return caseResult{ID: "refresh-no-extra", OK: true, Detail: map[string]any{"calls": after, "httpGets": 5}}
}

func runServe(req Request) error {
	hist, err := store.Open(req.Data, store.OpenOptions{})
	if err != nil {
		return err
	}
	defer hist.Close()
	fake := buildFake(req)
	clk := &clock.Var{T: time.UnixMilli(req.NowMS).UTC()}
	app := rt.New(clk, hist, fake)
	app.Home, app.CodexHome, app.ClaudeHome, app.Direct = req.Home, req.CodexHome, req.ClaudeHome, req.Direct
	app.CycleForTest(context.Background())
	port := req.Port
	if port == 0 {
		port = 18910
	}
	srv, err := httpserver.New(httpserver.Options{Host: req.Host, Port: port, Public: webembed.FS(), Snapshot: app.Snapshot})
	if err != nil {
		return err
	}
	if err := srv.Listen(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "port-harness listen %s\n", srv.Addr())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	return srv.Close()
}

func boot(req Request, home, data string, fake *collect.Fake, direct []string, slowMS int) (*rt.Runtime, *store.History, error) {
	hist, err := store.Open(data, store.OpenOptions{})
	if err != nil {
		return nil, nil, err
	}
	var st store.Store = hist
	if slowMS > 0 {
		st = &delayHistory{History: hist, delay: time.Duration(slowMS) * time.Millisecond}
	}
	clk := &clock.Var{T: time.UnixMilli(req.NowMS).UTC()}
	app := rt.New(clk, st, fake)
	app.Home = home
	app.CodexHome = home
	app.ClaudeHome = filepath.Join(home, "noclaude")
	app.Direct = direct
	return app, hist, nil
}

func buildFake(req Request) *collect.Fake {
	fake := &collect.Fake{Delay: time.Duration(req.DelayMS) * time.Millisecond}
	for _, spec := range req.Fake {
		if spec.Err != "" {
			fake.SetHost(spec.Host, transport.Response{}, errors.New(spec.Err))
			continue
		}
		status := spec.Status
		if status == 0 {
			status = 200
		}
		fake.SetHost(spec.Host, transport.Response{Status: status, Body: []byte(spec.Body)}, nil)
	}
	return fake
}

func caseDirs(req Request, name string) (home, data string) {
	root := req.Data
	if root == "" {
		root = os.TempDir()
	}
	home = filepath.Join(root, name, "home")
	data = filepath.Join(root, name, "data")
	_ = os.MkdirAll(home, 0o700)
	_ = os.MkdirAll(data, 0o700)
	return home, data
}

func writeDirectHome(home string) {
	_ = os.WriteFile(filepath.Join(home, "codex-accounts.json"), []byte(`{"key:default":{"credential":{"accessToken":"sk-test","chatgptAccountId":"account"}}}`), 0600)
	_ = os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"providers":{"openai":{}},"codexAccounts":[{"id":"key:default"}]}`), 0o600)
}

func writeBothHome(home string) {
	writeDirectHome(home)
	_ = os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"providers":{"openai":{},"anthropic":{}},"codexAccounts":[{"id":"key:default"}]}`), 0o600)
	_ = os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"anthropic":{"activeAccountId":"a1","accounts":[{"id":"a1","credential":{"access":"sk-ant"}}]}}`), 0o600)
}

func findAcc(snap contract.Snapshot, provider, account string) *contract.Account {
	for i := range snap.Providers {
		if snap.Providers[i].ID != provider {
			continue
		}
		for j := range snap.Providers[i].Accounts {
			if snap.Providers[i].Accounts[j].ID == account {
				return &snap.Providers[i].Accounts[j]
			}
		}
	}
	return nil
}

func secretIn(snap contract.Snapshot) bool {
	raw, _ := json.Marshal(snap)
	return strings.Contains(string(raw), "sk-test") || strings.Contains(string(raw), "SECRET")
}

func rssKB() int64 {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				n, _ := strconv.ParseInt(fields[1], 10, 64)
				return n
			}
		}
	}
	return 0
}

func allocBytes() uint64 {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return ms.Alloc
}

type delayHistory struct {
	*store.History
	delay time.Duration
}

func (d *delayHistory) InsertObservation(row store.Observation) error {
	if d.delay > 0 {
		time.Sleep(d.delay)
	}
	return d.History.InsertObservation(row)
}

func (d *delayHistory) InsertUsage(row store.Usage) error {
	if d.delay > 0 {
		time.Sleep(d.delay)
	}
	return d.History.InsertUsage(row)
}
