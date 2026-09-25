package runtime

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

type usageStore interface {
	IngestJSONL(path string, now int64) (int, error)
	ListObservations() ([]store.Observation, error)
	ListUsage() ([]store.Usage, error)
	ListEvidence() ([]store.Evidence, error)
	UsageCursor() (store.UsageCursor, bool)
	Meta(key string) (any, bool)
}

func (rt *Runtime) usagePath() string {
	if rt.Home == "" {
		return ""
	}
	return filepath.Join(rt.Home, "usage.jsonl")
}

func (rt *Runtime) ingestUsage(now time.Time) (status string, err error) {
	us, ok := rt.Store.(usageStore)
	if !ok {
		return "absent", nil
	}
	path := rt.usagePath()
	if path == "" {
		return "absent", nil
	}
	_, statErr := os.Stat(path)
	_, ever := us.Meta("usageCursor")
	if errors.Is(statErr, os.ErrNotExist) {
		if ever {
			return "error", statErr
		}
		return "absent", nil
	}
	if statErr != nil {
		return "error", statErr
	}
	if _, err := us.IngestJSONL(path, now.UnixMilli()); err != nil {
		return "error", err
	}
	return "ok", nil
}

func attachAnalytics(providers []contract.Provider, hist usageStore, now time.Time, usageStatus string) (map[string]any, []contract.Provider, error) {
	return attachAnalyticsWith(providers, hist, now, usageStatus, nil)
}

// analysisPeriods are the trailing spans every per-window, per-provider and
// top-level figure is published for.
var analysisPeriods = []string{calc.PeriodOneHour, calc.PeriodFiveHour, calc.PeriodTwentyFourHour, calc.PeriodWeekly, calc.PeriodMonthly}

// analysisInput is the history read once per cycle and shared by every step.
type analysisInput struct {
	hist         usageStore
	now          time.Time
	nowMS        int64
	usageNow     int64 // end of the usage log actually read
	usageStale   bool
	usage        []store.Usage
	priced       []calc.AppliedPrice
	unknown      int
	evidence     []store.Evidence
	byWindow     map[string][]calc.Point
	usagePeriods usagePeriodResult
	// usageObservedThrough bounds capacity pairing to the log that was read.
	observedThrough *int64
}

func loadAnalysisInput(providers []contract.Provider, hist usageStore, now time.Time, usageStatus string) (*analysisInput, error) {
	in := &analysisInput{hist: hist, now: now, nowMS: now.UTC().UnixMilli()}
	var obs []store.Observation
	if hist != nil {
		var err error
		if obs, err = hist.ListObservations(); err != nil {
			return nil, fmt.Errorf("read observations: %w", err)
		}
		if in.usage, err = hist.ListUsage(); err != nil {
			return nil, fmt.Errorf("read usage: %w", err)
		}
		if in.evidence, err = hist.ListEvidence(); err != nil {
			return nil, fmt.Errorf("read price evidence: %w", err)
		}
	}
	in.priced, in.unknown = priceUsage(in.usage, in.evidence, in.nowMS)
	in.usageNow = in.nowMS
	if hist != nil {
		if at, ok := metaMillis(hist, "usageObservedThrough"); ok && at < in.usageNow {
			in.usageNow = at
		}
		if through, ok := hist.Meta("usageObservedThrough"); ok {
			if boundary, ok := through.(float64); ok {
				b := int64(boundary)
				in.observedThrough = &b
			}
		}
	}
	in.usageStale = usageStatus == "error" || in.nowMS-in.usageNow > forecastStaleMs
	in.usagePeriods = buildUsagePeriods(in.usage, in.priced, providers, hist, in.usageNow)
	in.byWindow = observationPoints(obs)
	return in, nil
}

// observationPoints groups stored observations by provider, account and window.
func observationPoints(obs []store.Observation) map[string][]calc.Point {
	byWindow := map[string][]calc.Point{}
	deref := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	for _, o := range obs {
		key := o.Provider + "\x00" + o.Account + "\x00" + o.Window
		reset := int64(0)
		if o.Reset != nil {
			reset = *o.Reset
		}
		byWindow[key] = append(byWindow[key], calc.Point{
			At: o.At, Reset: reset, Used: o.ObservedPercent, ObservedPercent: o.ObservedPercent,
			Epoch: o.Epoch, WindowSemantics: o.WindowSemantics, CycleKey: deref(o.CycleKey),
			Source: deref(o.Source), SourceVersion: deref(o.SourceVersion), Method: deref(o.Method),
			ScopeKey: deref(o.ScopeKey), Unit: deref(o.Unit),
			LimitValue: o.LimitValue, LimitState: o.LimitState,
			UsedAccumulation: o.UsedAccumulation, Reconciliation: o.Reconciliation,
		})
	}
	return byWindow
}

// windowPoints returns this window's observations for the identity epoch it
// currently carries; readings from a replaced credential never mix in.
func (in *analysisInput) windowPoints(providerID, accountID string, w *contract.Window) []calc.Point {
	filtered := []calc.Point{}
	for _, point := range in.byWindow[providerID+"\x00"+accountID+"\x00"+w.ID] {
		if (point.Epoch == nil && w.IdentityEpoch == nil) || (point.Epoch != nil && w.IdentityEpoch != nil && *point.Epoch == *w.IdentityEpoch) {
			filtered = append(filtered, point)
		}
	}
	return filtered
}

// topPeriodsTracker keeps, per period, the first window sample that has a
// measured consumption; it backs the single-account coverage figure.
type topPeriodsTracker map[string]any

func newTopPeriods() topPeriodsTracker {
	top := topPeriodsTracker{}
	for _, key := range analysisPeriods {
		top[key] = map[string]any{"deltaPp": nil, "spanHours": calc.PeriodHours[key], "coverage": nil, "basis": ""}
	}
	return top
}

func (top topPeriodsTracker) offer(key string, sample calc.PeriodSample) {
	if sample.DeltaPp == nil {
		return
	}
	if prev, ok := top[key].(map[string]any); ok && prev["deltaPp"] == nil {
		top[key] = periodDTO(sample)
	}
}

// attachWindowAnalytics sets one window's consumption, forecast and capacity
// and returns its input to the provider consumption total.
func (in *analysisInput) attachWindowAnalytics(providerID string, a *contract.Account, w *contract.Window, top topPeriodsTracker) calc.WindowInput {
	pts := in.windowPoints(providerID, a.ID, w)
	historicalDTO, _ := historicalConsumption(pts, in.nowMS)
	periods := calc.ConsumePeriods(pts, in.nowMS)
	projected := map[string]any{}
	samples := map[string]*calc.PeriodSample{}
	for _, key := range analysisPeriods {
		sample := periods[key]
		projected[key] = periodDTO(sample)
		cp := sample
		samples[key] = &cp
		top.offer(key, sample)
	}
	wide := w.ID == "weekly" || w.ID == "monthly" || w.ID == "five-hour" || w.ID == "short"
	dto := map[string]any{
		"providerWide":                 wide,
		"consumptionPeriods":           projected,
		"historicalConsumptionPeriods": historicalDTO,
	}
	w.Analytics = dto
	var capacityPoints []calc.Point
	if in.observedThrough != nil {
		for _, point := range pts {
			if point.At <= *in.observedThrough {
				capacityPoints = append(capacityPoints, point)
			}
		}
	}
	capacityWindow := *w
	if a.Status == "reauth" || a.Status == "paused" {
		stale := true
		capacityWindow.Stale = &stale
	}
	for key, value := range windowForecast(capacityWindow, pts, in.nowMS) {
		dto[key] = value
	}
	for key, value := range windowCapacity(providerID, a.ID, capacityWindow, capacityPoints, in.usage, in.priced, in.nowMS) {
		dto[key] = value
	}
	return calc.WindowInput{ID: w.ID, ProviderWide: wide, Periods: samples}
}

// providerModelPrices lists evidence for the provider, adding the source-owned
// quote for any configured model that has no stored evidence yet.
func (in *analysisInput) providerModelPrices(p *contract.Provider) []map[string]any {
	prices := evidenceFor(p.ID, in.evidence)
	for _, model := range p.SupportedModels {
		found := false
		for _, price := range prices {
			if price["model"] == model {
				found = true
				break
			}
		}
		if !found {
			if price, ok := store.ModelPriceEvidence(p.ID, model, in.nowMS); ok {
				prices = append(prices, evidenceItem(price))
			}
		}
	}
	return prices
}

// attachProviderAnalytics fills one provider and its accounts and windows, and
// returns the provider's recommendations by period.
func (in *analysisInput) attachProviderAnalytics(p *contract.Provider, top topPeriodsTracker) map[string]any {
	pace := usagePace(p.ID, nil, in.usage, in.priced, in.usageNow)
	pace["stale"] = in.usageStale
	analytics := map[string]any{"modelPrices": in.providerModelPrices(p), "periods": in.usagePeriods.providers[p.ID], "pace": pace}
	p.Analytics = analytics
	var accInputs []calc.AccountInput
	var quotaAccounts []*contract.Account
	for j := range p.Accounts {
		a := &p.Accounts[j]
		accPace := usagePace(p.ID, &a.ID, in.usage, in.priced, in.usageNow)
		accPace["stale"] = in.usageStale
		accAnalytics := map[string]any{"periods": in.usagePeriods.accounts[usageAccount{p.ID, a.ID}], "pace": accPace}
		a.Analytics = accAnalytics
		sub := subscription(p.ID, a.Plan)
		monthly, _ := sub["monthlyUsd"].(*float64)
		attachSubscription(accAnalytics, sub, in.usagePeriods.providers[p.ID])
		var wins []calc.WindowInput
		for k := range a.Windows {
			wins = append(wins, in.attachWindowAnalytics(p.ID, a, &a.Windows[k], top))
		}
		quotaAccounts = append(quotaAccounts, a)
		accInputs = append(accInputs, calc.AccountInput{Status: a.Status, MonthlyUSD: monthly, Windows: wins})
	}
	// One consumption total per period feeds both the published figure and
	// the account estimate.
	byPeriod := map[string]any{}
	consumption := map[string]any{}
	for _, key := range analysisPeriods {
		total := calc.SumConsumption(accInputs, key)
		consumption[key] = consumptionDTO(total)
		byPeriod[key] = recDTO(calc.RecommendFromTotal(accInputs, total))
	}
	analytics["quotaRecommendations"] = byPeriod
	analytics["quotaConsumption"] = consumption
	analytics["quotaSeries"] = in.quotaSeries(p.ID, quotaAccounts, consumption)
	attachProviderDetails(p, in.usage, in.priced, in.usageNow)
	return byPeriod
}

// configuredModels lists every configured model once per provider, in order.
func configuredModels(providers []contract.Provider) []string {
	models := []string{}
	seen := map[string]bool{}
	for _, p := range providers {
		for _, m := range p.SupportedModels {
			if !seen[p.ID+"/"+m] {
				seen[p.ID+"/"+m] = true
				models = append(models, m)
			}
		}
	}
	return models
}

// attachAnalyticsWith builds the whole analytics DTO in four steps: read the
// history once, fill each provider (accounts, windows, consumption total and
// account estimate), run the tracked features that keep durable state, and
// assemble the top-level summary. Bindings name each Ollama account's readings.
func attachAnalyticsWith(providers []contract.Provider, hist usageStore, now time.Time, usageStatus string, bindings []collect.Binding) (map[string]any, []contract.Provider, error) {
	in, err := loadAnalysisInput(providers, hist, now, usageStatus)
	if err != nil {
		return nil, providers, err
	}
	top := newTopPeriods()
	models := configuredModels(providers)
	providerRecs := map[string]map[string]any{}
	for i := range providers {
		providerRecs[providers[i].ID] = in.attachProviderAnalytics(&providers[i], top)
	}
	analytics := in.summaryDTO(providers, providerRecs, top, models, usageStatus)
	if err := in.attachTrackedFeatures(providers, analytics, bindings); err != nil {
		return nil, providers, err
	}
	analytics["costs"] = costBreakdown(in.usage, in.priced, providers, in.usageNow, displayLocation)
	analytics["accounts"] = accountRoster(providers, in.usage, in.priced, in.usageNow)
	analytics["subscriptionMonthlyUsd"] = subscriptionTotal(providers)
	analytics["usageStale"] = in.usageStale
	if len(providers) != 1 || len(providers[0].Accounts) != 1 {
		for key := range top {
			analytics["coverage"].(map[string]any)[key] = nil
		}
	}
	return analytics, providers, nil
}

func (in *analysisInput) summaryDTO(providers []contract.Provider, providerRecs map[string]map[string]any, top topPeriodsTracker, models []string, usageStatus string) map[string]any {
	usageDTO := map[string]any{"status": usageStatus, "requests": len(in.usage)}
	if in.hist != nil {
		if cur, ok := in.hist.UsageCursor(); ok {
			usageDTO["cursor"] = map[string]any{"offset": cur.Offset, "ino": cur.Ino}
		}
	}
	totals := calc.SumUsage(in.priced, usageTokens(in.usage))
	return map[string]any{
		"usage":                usageDTO,
		"periods":              in.usagePeriods.top,
		"quotaRecommendations": topRecommendationDTO(providerRecs, analysisPeriods),
		"modelRoster":          models,
		"priceEvidence":        evidenceDTO(in.evidence),
		"priceGaps":            in.unknown,
		"ollamaComparison":     calc.CompareOllama(ollamaTokens(in.usage), nil, &totals),
		"coverage":             coverageDTO(top),
		"forecast":             forecastDTO(singleProviderRecs(providerRecs)),
	}
}

// attachTrackedFeatures runs the features that keep durable state between
// cycles (model roster, price gaps, Cursor cache reference, Ollama readings).
func (in *analysisInput) attachTrackedFeatures(providers []contract.Provider, analytics map[string]any, bindings []collect.Binding) error {
	if err := recordRoster(providers, in.usage, in.hist, in.now); err != nil {
		return fmt.Errorf("record model roster: %w", err)
	}
	analytics["modelRosterState"] = attachRoster(providers, in.hist)
	gapSummary, err := attachPriceGaps(providers, in.usage, in.priced, in.hist, in.now)
	if err != nil {
		return err
	}
	analytics["priceGapsState"] = gapSummary
	attachCacheAssumption(providers, in.hist, in.now, in.usageStale)
	if in.hist != nil && len(bindings) > 0 {
		attachOllama(providers, in.hist, bindings, in.usage, in.priced, in.now)
	}
	return nil
}

func singleProviderRecs(byProvider map[string]map[string]any) map[string]any {
	if len(byProvider) != 1 {
		return nil
	}
	for _, recs := range byProvider {
		return recs
	}
	return nil
}

func periodDTO(s calc.PeriodSample) map[string]any {
	return map[string]any{
		"deltaPp":          s.DeltaPp,
		"spanHours":        s.SpanHours,
		"observedHours":    s.ObservedHours,
		"coverage":         s.Coverage,
		"basis":            s.Basis,
		"periodEndedAt":    s.PeriodEndedAt,
		"resetGapCount":    s.ResetGapCount,
		"recoveredDeltaPp": s.RecoveredDeltaPp,
		"recoveredHours":   s.RecoveredHours,
	}
}

// topRecommendationDTO keeps one entry per period without adding providers.
// Different plans are not one account-unit, so a cross-provider sum is not a count.
// A single provider keeps its own recommendation; several stay collecting.
func topRecommendationDTO(byProvider map[string]map[string]any, keys []string) map[string]any {
	out := map[string]any{}
	var only map[string]any
	if len(byProvider) == 1 {
		for _, recs := range byProvider {
			only = recs
		}
	}
	for _, key := range keys {
		if only != nil {
			if entry, ok := only[key].(map[string]any); ok {
				out[key] = entry
				continue
			}
		}
		hours := calc.PeriodHours[key]
		out[key] = map[string]any{
			"status": "collecting", "basisPeriod": key, "periodHours": hours,
			"windowId": "", "capacityHours": 0.0,
			"currentAccounts": 0, "sampleAccounts": 0,
			"minimumAccounts": (*int)(nil), "recommendedAccounts": (*int)(nil),
			"additionalAccounts": (*int)(nil), "totalConsumedPp": (*float64)(nil),
			"estimatedMonthlyUsd": (*float64)(nil), "usageStale": false,
			"reason": "제공자별 쿼타 소모는 서로 다른 한도라 합산하지 않습니다.",
		}
	}
	return out
}

// consumptionDTO is the one published quota-consumption figure per period.
// The summary cell renders it and the account estimate is derived from it.
func consumptionDTO(t calc.ConsumptionTotal) map[string]any {
	return map[string]any{
		"period": t.Period, "periodHours": t.PeriodHours, "windowId": t.WindowID,
		"deltaPp": t.DeltaPp, "accounts": t.Accounts, "measuredAccounts": t.Measured,
		"unobservedAccounts": t.Unobserved, "coverage": t.CoverageMean, "spanHours": t.SpanHoursMean,
		"partial": t.Partial, "observedIncrease": t.ObservedIncrease,
		"recoveredDeltaPp": t.RecoveredPp, "resetGaps": t.ResetGaps,
	}
}

func recDTO(r calc.AccountNeed) map[string]any {
	return map[string]any{
		"status": r.Status, "basisPeriod": r.BasisPeriod, "periodHours": r.PeriodHours,
		"windowId": r.WindowID, "capacityHours": r.CapacityHours,
		"currentAccounts": r.CurrentAccounts, "sampleAccounts": r.SampleAccounts,
		"minimumAccounts": r.MinimumAccounts, "recommendedAccounts": r.RecommendedAccounts,
		"additionalAccounts": r.AdditionalAccounts, "totalConsumedPp": r.TotalConsumedPp,
		"estimatedMonthlyUsd": r.EstimatedMonthlyUSD, "usageStale": r.UsageStale, "reason": r.Reason,
	}
}

func evidenceFor(provider string, rows []store.Evidence) []map[string]any {
	var out []map[string]any
	for _, e := range rows {
		if e.Provider != provider {
			continue
		}
		out = append(out, evidenceItem(e))
	}
	return out
}

func evidenceDTO(rows []store.Evidence) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, e := range rows {
		out = append(out, evidenceItem(e))
	}
	return out
}

func evidenceItem(e store.Evidence) map[string]any {
	return map[string]any{
		"model": e.Model, "status": e.Status, "unit": "usd-per-million-tokens",
		"rates":     map[string]any{"input": e.Rates[0], "output": e.Rates[1], "cacheRead": e.Rates[2], "cacheWrite": e.Rates[3]},
		"sourceUrl": e.SourceURL, "checkedAt": e.CheckedAt, "effectiveFrom": e.EffectiveFrom, "effectiveTo": e.EffectiveTo,
		"conditions": e.Conditions, "unsupported": e.Unsupported, "conflict": e.Conflict, "reason": e.Reason,
	}
}

func usageTokens(rows []store.Usage) []float64 {
	out := make([]float64, len(rows))
	for i, u := range rows {
		if u.Tokens != nil {
			out[i] = *u.Tokens
		}
	}
	return out
}

func ollamaTokens(rows []store.Usage) *float64 {
	var sum float64
	var n int
	for _, u := range rows {
		if u.Provider != "ollama" && u.Provider != "ollama-cloud" {
			continue
		}
		if u.Tokens != nil {
			sum += *u.Tokens
			n++
		}
	}
	if n == 0 {
		return nil
	}
	return &sum
}

func coverageDTO(periods map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range periods {
		m, _ := v.(map[string]any)
		out[k] = m["coverage"]
	}
	return out
}

func forecastDTO(byPeriod map[string]any) map[string]any {
	entry, _ := byPeriod[calc.PeriodTwentyFourHour].(map[string]any)
	var needed *int
	status := "collecting"
	basis := calc.PeriodTwentyFourHour
	if entry != nil {
		switch v := entry["recommendedAccounts"].(type) {
		case *int:
			if v != nil {
				needed = v
			}
		case int:
			needed = &v
		}
		if s, ok := entry["status"].(string); ok {
			status = s
		}
		if b, ok := entry["basisPeriod"].(string); ok && b != "" {
			basis = b
		}
	}
	return map[string]any{
		"neededAccounts": needed,
		"basisPeriod":    basis,
		"status":         status,
	}
}
