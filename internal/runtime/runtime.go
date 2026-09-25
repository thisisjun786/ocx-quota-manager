package runtime

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

const failureNote = "수집 작업이 중단되어 마지막 기록을 표시합니다."

type Runtime struct {
	Clock      clock.Clock
	Store      store.Store
	Transport  transport.Transport
	Interval   time.Duration
	Direct     []string
	Home       string
	CodexHome  string
	ClaudeHome string

	mu                sync.Mutex
	published         atomic.Value // contract.Snapshot
	sched             *collect.Scheduler
	cancel            context.CancelFunc
	done              chan struct{}
	identities        map[string]runtimeIdentity
	localObservations map[string]localObservation
	poll              sync.Mutex
	Catalog           *catalogLoader
}

func New(clk clock.Clock, st store.Store, tr transport.Transport) *Runtime {
	if clk == nil {
		clk = clock.System{}
	}
	if tr == nil {
		tr = collect.NewHTTPSTransport()
	}
	rt := &Runtime{Clock: clk, Store: st, Transport: tr, Interval: 10 * time.Second, sched: collect.NewScheduler(clk, tr)}
	rt.publish(rt.bootSnapshot())
	return rt
}

func (rt *Runtime) bootSnapshot() contract.Snapshot {
	now := rt.Clock.Now().UTC().Format(time.RFC3339Nano)
	stale := true
	status := "collecting"
	return contract.Snapshot{
		SchemaVersion:          contract.SchemaVersion,
		ObservedAt:             &now,
		RefreshIntervalSeconds: intPtr(10),
		Warnings:               []string{"저장된 쿼타 기록을 불러오고 있습니다."},
		Providers:              []contract.Provider{},
		Analytics: map[string]any{
			"status": status, "usageStale": stale, "lastCollectedAt": nil,
		},
	}
}

func (rt *Runtime) publish(s contract.Snapshot) {
	s = sanitizeSnapshot(s)
	if err := contract.ValidateSnapshot(s); err != nil {
		return
	}
	// Atomic replace of the last completed public DTO. Request path only loads this.
	rt.published.Store(s)
}

func (rt *Runtime) Snapshot() contract.Snapshot {
	v, _ := rt.published.Load().(contract.Snapshot)
	if v.ObservedAt == nil {
		return rt.bootSnapshot()
	}
	age := rt.Clock.Now().UTC().Sub(parseOrNow(*v.ObservedAt, rt.Clock.Now()))
	limit := rt.Interval * 3
	if limit < 30*time.Second {
		limit = 30 * time.Second
	}
	if age <= limit {
		return v
	}
	warnings := append([]string{}, v.Warnings...)
	if !contains(warnings, failureNote) {
		warnings = append(warnings, failureNote)
	}
	v.Warnings = warnings
	if m, ok := v.Analytics.(map[string]any); ok {
		cp := map[string]any{}
		for k, val := range m {
			cp[k] = val
		}
		cp["status"] = "error"
		cp["usageStale"] = true
		v.Analytics = cp
	}
	return v
}

// EnableCatalog turns on the public price catalog for models the source-owned
// table does not price. dataDir holds the refreshed copy; fallback is read
// when no copy exists yet.
func (rt *Runtime) EnableCatalog(dataDir, fallback string) {
	rt.Catalog = &catalogLoader{DataDir: dataDir, Fallback: fallback}
}

// CycleForTest runs one collect/publish cycle. Production uses Start.
func (rt *Runtime) CycleForTest(ctx context.Context) {
	rt.cycle(ctx)
}

func (rt *Runtime) Start(ctx context.Context) {
	rt.restoreDirectOutcomes()
	ctx, rt.cancel = context.WithCancel(ctx)
	rt.done = make(chan struct{})
	go func() {
		defer close(rt.done)
		rt.cycle(ctx)
		t := time.NewTicker(rt.Interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				rt.cycle(ctx)
			}
		}
	}()
}

func (rt *Runtime) cycle(ctx context.Context) {
	if !rt.poll.TryLock() {
		return
	}
	defer rt.poll.Unlock()
	now := rt.Clock.Now().UTC()
	local, err := (collect.Reader{Home: rt.Home, CodexHome: rt.CodexHome, ClaudeHome: rt.ClaudeHome}).LoadLocal(now)
	if err != nil {
		rt.markFailure()
		return
	}
	// An unreadable credential source is not an authoritative empty roster.
	// Keep the last public snapshot without reusing credentials for new calls.
	for _, key := range []string{"ocxConfig", "ocxAuth", "ocxCodexAccounts", "codexAuth", "claudeCredentials"} {
		switch local.Files[key] {
		case collect.FileMalformed, collect.FileUnreadable, collect.FileOversized:
			rt.markFailure()
			return
		}
	}
	var rows []collect.Reading
	if len(rt.Direct) > 0 {
		rows = rt.sched.Collect(ctx, local.Bindings, append(append([]string{}, rt.Direct...), "ollama-cloud"))
	}
	epochs, epochErr := rt.bindingEpochs(local.Bindings, now.UnixMilli())
	storeFailed := epochErr != nil
	if rt.Store != nil {
		for _, row := range rows {
			if !persistable(row) {
				continue
			}
			obs := directObservation(row)
			if epoch, ok := epochs[row.Provider+"\x00"+row.Account]; ok {
				obs.Epoch = &epoch
			}
			if err := rt.Store.InsertObservation(obs); err != nil {
				storeFailed = true
			}
		}
	}
	providers := collect.MergeDirect(local.Providers, rows, now)
	applyReadingEpochs(providers, rows, epochs)
	if st, ok := rt.Store.(ollamaStore); ok {
		if err := persistOllama(st, local.Bindings, rows); err != nil {
			storeFailed = true
		}
	}
	if len(rt.Direct) > 0 {
		outcomes := rt.sched.Outcomes()
		attachDirectStatus(providers, outcomes, now)
		if err := rt.persistDirectOutcomes(outcomes); err != nil {
			storeFailed = true
		}
	}
	if err := rt.persistLocalObservations(providers, epochs, now.UnixMilli()); err != nil {
		storeFailed = true
	}
	if rt.Catalog != nil {
		if c := rt.Catalog.Load(ctx, now); c != nil {
			if h, ok := rt.Store.(interface{ SetCatalog(*store.Catalog) }); ok {
				h.SetCatalog(c)
			}
		}
	}
	usageStatus, ingestErr := rt.ingestUsage(now)
	if ingestErr == nil {
		if err := MaintainIfDue(rt.Store, now); err != nil {
			storeFailed = true
		}
	}
	var hist usageStore
	if us, ok := rt.Store.(usageStore); ok {
		hist = us
	}
	if ingestErr == nil && !storeFailed {
		if err := updateCacheReference(hist, now); err != nil {
			storeFailed = true
		}
	}
	var computed map[string]any
	var analysisErr error
	if ingestErr == nil && !storeFailed {
		computed, providers, analysisErr = attachAnalyticsWith(providers, hist, now, usageStatus, local.Bindings)
	}
	iso := now.Format(time.RFC3339Nano)
	status := "ok"
	if storeFailed || ingestErr != nil || analysisErr != nil {
		status = "error"
	}
	analytics := map[string]any{
		"status": status, "usageStale": storeFailed || usageStatus == "error", "lastCollectedAt": iso,
	}
	for k, v := range usageTimes(hist, now, ingestErr == nil && usageStatus == "ok") {
		analytics[k] = v
	}
	for k, v := range computed {
		analytics[k] = v
	}
	if status == "error" {
		previous, _ := rt.published.Load().(contract.Snapshot)
		analytics, providers = retainAnalysis(previous, providers)
	}
	src := "opencodex-local-snapshot"
	rt.publish(contract.Snapshot{
		SchemaVersion:          contract.SchemaVersion,
		ObservedAt:             &iso,
		Source:                 &src,
		RefreshIntervalSeconds: intPtr(int(rt.Interval / time.Second)),
		Warnings:               local.Warnings,
		Providers:              providers,
		Analytics:              analytics,
	})
}

func project(rows []collect.Reading, now time.Time) []contract.Provider {
	by := map[string][]collect.Reading{}
	order := []string{}
	for _, r := range rows {
		if _, ok := by[r.Provider]; !ok {
			order = append(order, r.Provider)
		}
		by[r.Provider] = append(by[r.Provider], r)
	}
	var out []contract.Provider
	for _, id := range order {
		accs := map[string][]collect.Reading{}
		accOrder := []string{}
		for _, r := range by[id] {
			if _, ok := accs[r.Account]; !ok {
				accOrder = append(accOrder, r.Account)
			}
			accs[r.Account] = append(accs[r.Account], r)
		}
		p := contract.Provider{ID: id, Name: id, Enabled: true, Accounts: []contract.Account{}}
		for _, aid := range accOrder {
			status := "ok"
			var updated *string
			acc := contract.Account{ID: aid, Label: aid, Status: status, Windows: []contract.Window{}}
			for _, r := range accs[aid] {
				if r.Kind == collect.WindowFailed {
					acc.Status = "stale"
				}
				if r.Kind == collect.WindowEmpty || r.Kind == collect.WindowInvalid {
					continue
				}
				if r.WindowID == "" {
					continue
				}
				if r.ObservedAt > 0 {
					iso := time.UnixMilli(r.ObservedAt).UTC().Format(time.RFC3339Nano)
					if updated == nil || iso > *updated {
						updated = &iso
					}
				}
				var remain *float64
				if r.RemainingPercent != nil {
					v := *r.RemainingPercent
					remain = &v
				}
				var reset *string
				if r.ResetAt != nil {
					s := time.UnixMilli(*r.ResetAt).UTC().Format(time.RFC3339Nano)
					reset = &s
				}
				stale := r.Kind != collect.WindowOK
				acc.Windows = append(acc.Windows, contract.Window{
					ID: r.WindowID, Label: r.Label, RemainingPercent: remain, Stale: &stale, ResetAt: reset,
				})
			}
			if updated == nil {
				iso := now.UTC().Format(time.RFC3339Nano)
				updated = &iso
			}
			acc.UpdatedAt = updated
			if acc.Status == "ok" && len(acc.Windows) == 0 {
				acc.Status = "unavailable"
			}
			p.Accounts = append(p.Accounts, acc)
		}
		out = append(out, p)
	}
	if out == nil {
		out = []contract.Provider{}
	}
	return out
}

func (rt *Runtime) markFailure() {
	cur := rt.Snapshot()
	warnings := append([]string{}, cur.Warnings...)
	if !contains(warnings, failureNote) {
		warnings = append(warnings, failureNote)
	}
	cur.Warnings = warnings
	if m, ok := cur.Analytics.(map[string]any); ok {
		cp := map[string]any{}
		for k, v := range m {
			cp[k] = v
		}
		cp["status"] = "error"
		cp["usageStale"] = true
		cur.Analytics = cp
	}
	rt.publish(cur)
}

func (rt *Runtime) Close(ctx context.Context) error {
	if rt.cancel != nil {
		rt.cancel()
	}
	if rt.done != nil {
		select {
		case <-rt.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if rt.Store != nil {
		return rt.Store.Close()
	}
	return nil
}

func persistable(row collect.Reading) bool {
	return !row.Cached && !row.Hidden && row.Kind == collect.WindowOK && row.WindowID != "" && row.UsedPercent != nil
}

func sanitizeSnapshot(s contract.Snapshot) contract.Snapshot {
	if s.Providers == nil {
		s.Providers = []contract.Provider{}
		return s
	}
	providers := make([]contract.Provider, 0, len(s.Providers))
	for _, p := range s.Providers {
		if p.ID == "" {
			continue
		}
		accounts := make([]contract.Account, 0, len(p.Accounts))
		for _, a := range p.Accounts {
			if a.ID == "" {
				continue
			}
			windows := make([]contract.Window, 0, len(a.Windows))
			for _, w := range a.Windows {
				if w.ID == "" {
					continue
				}
				windows = append(windows, w)
			}
			a.Windows = windows
			accounts = append(accounts, a)
		}
		p.Accounts = accounts
		providers = append(providers, p)
	}
	s.Providers = providers
	return s
}

func intPtr(n int) *int { return &n }

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func parseOrNow(s string, now time.Time) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339, s)
	}
	if err != nil {
		return now
	}
	return t
}
