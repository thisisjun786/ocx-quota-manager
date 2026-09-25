package runtime

import (
	"sort"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

// Cost breakdown and account roster, the two views an operator reaches for
// first: where the API-equivalent spend goes, and which account needs
// attention. Both read the already-priced usage rows; nothing is re-priced.

var breakdownPeriods = []struct {
	key   string
	hours int64
}{{"day", 24}, {"week", 7 * 24}, {"month", 30 * 24}}

const breakdownDays = 30

type costCell struct {
	Requests      int     `json:"requests"`
	Tokens        float64 `json:"tokens"`
	InputTokens   float64 `json:"inputTokens"`
	OutputTokens  float64 `json:"outputTokens"`
	CachedTokens  float64 `json:"cachedTokens"`
	APIUsd        float64 `json:"apiUsd"`
	Unpriced      int     `json:"unpricedRequests"`
	Tokenless     int     `json:"tokenlessRequests"`
	LastAt        int64   `json:"-"`
	LastRequestAt *string `json:"lastRequestAt,omitempty"`
}

func (c *costCell) add(u store.Usage, p calc.AppliedPrice) {
	c.Requests++
	if u.Tokens != nil {
		c.Tokens += *u.Tokens
	}
	if u.Input != nil {
		c.InputTokens += *u.Input
	}
	if u.Output != nil {
		c.OutputTokens += *u.Output
	}
	if u.Cached != nil {
		c.CachedTokens += *u.Cached
	}
	switch {
	case p.USD != nil:
		c.APIUsd += *p.USD
	case u.Input == nil || u.Output == nil:
		// The provider never reported token counts, so no price can apply.
		c.Tokenless++
	default:
		c.Unpriced++
	}
	if u.At > c.LastAt {
		c.LastAt = u.At
	}
}

type costRow struct {
	Key        string  `json:"key"`
	Provider   string  `json:"provider"`
	Name       string  `json:"name"`
	Configured *bool   `json:"configured,omitempty"`
	Share      float64 `json:"share"`
	costCell
}

type costPeriod struct {
	Hours     int64     `json:"hours"`
	From      string    `json:"from"`
	To        string    `json:"to"`
	Total     costCell  `json:"total"`
	Providers []costRow `json:"providers"`
	Models    []costRow `json:"models"`
	Accounts  []costRow `json:"accounts"`
}

type costDay struct {
	Date       string             `json:"date"`
	APIUsd     float64            `json:"apiUsd"`
	Requests   int                `json:"requests"`
	ByProvider map[string]float64 `json:"byProvider"`
}

func isoMillis(ms int64) string {
	return time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
}

func accountLabels(providers []contract.Provider) (map[string]string, map[string]string) {
	names := map[string]string{}
	labels := map[string]string{}
	for _, p := range providers {
		names[p.ID] = p.Name
		for _, a := range p.Accounts {
			labels[p.ID+"\x00"+a.ID] = a.Label
		}
	}
	return names, labels
}

// costBreakdown groups priced usage by provider, model and account for the
// last day, week and month ending at now, plus a daily series for the month.
// rows must be ordered by time and aligned with prices.
func costBreakdown(rows []store.Usage, prices []calc.AppliedPrice, providers []contract.Provider, now int64, loc *time.Location) map[string]any {
	names, labels := accountLabels(providers)
	periods := map[string]any{}
	for _, period := range breakdownPeriods {
		from := now - period.hours*calc.HourMs
		start := sort.Search(len(rows), func(i int) bool { return rows[i].At > from })
		total := costCell{}
		byProvider := map[string]*costRow{}
		byModel := map[string]*costRow{}
		byAccount := map[string]*costRow{}
		get := func(m map[string]*costRow, key, provider, name string) *costRow {
			r, ok := m[key]
			if !ok {
				r = &costRow{Key: key, Provider: provider, Name: name}
				m[key] = r
			}
			return r
		}
		for i := start; i < len(rows) && rows[i].At <= now; i++ {
			u, p := rows[i], prices[i]
			total.add(u, p)
			pname := names[u.Provider]
			if pname == "" {
				pname = u.Provider
			}
			get(byProvider, u.Provider, u.Provider, pname).add(u, p)
			model := "(unknown)"
			if u.Model != nil && *u.Model != "" {
				model = *u.Model
			}
			get(byModel, u.Provider+"/"+model, u.Provider, model).add(u, p)
			account, label := "", "계정 미확인"
			if u.Account != nil && *u.Account != "" {
				account = *u.Account
				label = labels[u.Provider+"\x00"+account]
				if label == "" {
					label = account
				}
			}
			get(byAccount, u.Provider+"\x00"+account, u.Provider, label).add(u, p)
		}
		periods[period.key] = costPeriod{
			Hours: period.hours, From: isoMillis(from), To: isoMillis(now), Total: finishCell(total),
			Providers: finishRows(byProvider, total.APIUsd, names),
			Models:    limitRows(finishRows(byModel, total.APIUsd, nil), 40),
			Accounts:  finishRows(byAccount, total.APIUsd, nil),
		}
	}
	series := map[string]any{}
	for _, b := range seriesSpecs {
		series[b.period] = bucketSeries(rows, prices, now, loc, b)
	}
	return map[string]any{"periods": periods, "daily": dailySeries(rows, prices, now, loc), "series": series, "currency": "USD", "basis": "api-equivalent",
		"removedProviders": removedProviders(rows, prices, names, now)}
}

type removedProvider struct {
	Provider      string  `json:"provider"`
	Requests      int     `json:"requests"`
	APIUsd        float64 `json:"apiUsd"`
	LastRequestAt string  `json:"lastRequestAt"`
}

// removedProviders lists providers with usage in the last 30 days that the
// current OCX configuration no longer names. Their quota is not read any more,
// so the screen says so instead of silently dropping them.
func removedProviders(rows []store.Usage, prices []calc.AppliedPrice, names map[string]string, now int64) []removedProvider {
	from := now - 30*24*calc.HourMs
	start := sort.Search(len(rows), func(i int) bool { return rows[i].At > from })
	by := map[string]*removedProvider{}
	for i := start; i < len(rows) && rows[i].At <= now; i++ {
		u := rows[i]
		if _, ok := names[u.Provider]; ok || u.Provider == "unknown" || u.Provider == "" {
			continue
		}
		r := by[u.Provider]
		if r == nil {
			r = &removedProvider{Provider: u.Provider}
			by[u.Provider] = r
		}
		r.Requests++
		if prices[i].USD != nil {
			r.APIUsd += *prices[i].USD
		}
		if at := isoMillis(u.At); at > r.LastRequestAt {
			r.LastRequestAt = at
		}
	}
	out := []removedProvider{}
	for _, r := range by {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastRequestAt > out[j].LastRequestAt })
	return out
}

func finishCell(c costCell) costCell {
	if c.LastAt > 0 {
		s := isoMillis(c.LastAt)
		c.LastRequestAt = &s
	}
	return c
}

// finishRows sorts by amount, then requests. With names given, providers the
// current configuration does not list are marked as such so removed providers
// stay visible with their past spend.
func finishRows(m map[string]*costRow, total float64, names map[string]string) []costRow {
	out := make([]costRow, 0, len(m))
	for _, r := range m {
		r.costCell = finishCell(r.costCell)
		if total > 0 {
			r.Share = r.APIUsd / total
		}
		if names != nil && r.Provider != "unknown" {
			_, ok := names[r.Provider]
			configured := ok
			r.Configured = &configured
		}
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].APIUsd != out[j].APIUsd {
			return out[i].APIUsd > out[j].APIUsd
		}
		if out[i].Requests != out[j].Requests {
			return out[i].Requests > out[j].Requests
		}
		return out[i].Key < out[j].Key
	})
	return out
}

func limitRows(rows []costRow, n int) []costRow {
	if len(rows) > n {
		return rows[:n]
	}
	return rows
}

// seriesSpec sets the bar size of the cost chart for each selectable span:
// 24 hours in 1-hour bars, 7 days in 5-hour bars, 30 days in 1-day bars.
type seriesSpec struct {
	period string
	bucket time.Duration
	span   time.Duration
}

var seriesSpecs = []seriesSpec{
	{"day", time.Hour, 24 * time.Hour},
	{"week", 5 * time.Hour, 7 * 24 * time.Hour},
	{"month", 24 * time.Hour, 30 * 24 * time.Hour},
}

type costBucket struct {
	From       string             `json:"from"`
	To         string             `json:"to"`
	APIUsd     float64            `json:"apiUsd"`
	Requests   int                `json:"requests"`
	Tokens     float64            `json:"tokens"`
	Unpriced   int                `json:"unpricedRequests"`
	ByProvider map[string]float64 `json:"byProvider"`
	ByModel    map[string]float64 `json:"byModel"`
}

// bucketSeries splits the span ending at now into bars (see seriesEdges) and
// totals the priced usage in each, by provider and model.
func bucketSeries(rows []store.Usage, prices []calc.AppliedPrice, now int64, loc *time.Location, spec seriesSpec) map[string]any {
	edges, labels := seriesEdges(now, loc, spec)
	count := len(edges) - 1
	buckets := make([]costBucket, count)
	for i := range buckets {
		buckets[i] = costBucket{From: labels[i], To: labels[i+1], ByProvider: map[string]float64{}, ByModel: map[string]float64{}}
	}
	lo := sort.Search(len(rows), func(i int) bool { return rows[i].At > edges[0] })
	for i := lo; i < len(rows) && rows[i].At <= now; i++ {
		idx := sort.Search(count, func(k int) bool { return edges[k+1] >= rows[i].At })
		if idx >= count {
			continue
		}
		b := &buckets[idx]
		b.Requests++
		if rows[i].Tokens != nil {
			b.Tokens += *rows[i].Tokens
		}
		if prices[i].USD == nil {
			b.Unpriced++
			continue
		}
		b.APIUsd += *prices[i].USD
		b.ByProvider[rows[i].Provider] += *prices[i].USD
		model := "(unknown)"
		if rows[i].Model != nil && *rows[i].Model != "" {
			model = *rows[i].Model
		}
		b.ByModel[rows[i].Provider+"/"+model] += *prices[i].USD
	}
	return map[string]any{"bucketHours": spec.bucket.Hours(), "buckets": buckets}
}

func dailySeries(rows []store.Usage, prices []calc.AppliedPrice, now int64, loc *time.Location) []costDay {
	end := time.UnixMilli(now).In(loc)
	first := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, -(breakdownDays - 1))
	days := make([]costDay, breakdownDays)
	for i := range days {
		days[i] = costDay{Date: first.AddDate(0, 0, i).Format("2006-01-02"), ByProvider: map[string]float64{}}
	}
	from := first.UnixMilli()
	start := sort.Search(len(rows), func(i int) bool { return rows[i].At >= from })
	for i := start; i < len(rows) && rows[i].At <= now; i++ {
		t := time.UnixMilli(rows[i].At).In(loc)
		idx := int(time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc).Sub(first).Hours()/24 + 0.5)
		if idx < 0 || idx >= breakdownDays {
			continue
		}
		days[idx].Requests++
		if prices[i].USD != nil {
			days[idx].APIUsd += *prices[i].USD
			days[idx].ByProvider[rows[i].Provider] += *prices[i].USD
		}
	}
	return days
}

type accountWindow struct {
	ID               string   `json:"id"`
	Label            string   `json:"label"`
	RemainingPercent *float64 `json:"remainingPercent"`
	ResetAt          *string  `json:"resetAt"`
	Stale            bool     `json:"stale"`
}

type accountRow struct {
	Provider      string          `json:"provider"`
	ProviderName  string          `json:"providerName"`
	ID            string          `json:"id"`
	Label         string          `json:"label"`
	Plan          *string         `json:"plan"`
	Status        string          `json:"status"`
	Health        string          `json:"health"`
	Reason        string          `json:"reason"`
	Active        *bool           `json:"active,omitempty"`
	UpdatedAt     *string         `json:"updatedAt"`
	Lowest        *accountWindow  `json:"lowest"`
	NextReset     *string         `json:"nextResetAt"`
	Windows       []accountWindow `json:"windows"`
	Day           costCell        `json:"day"`
	Week          costCell        `json:"week"`
	LastRequestAt *string         `json:"lastRequestAt"`
}

// Health folds status and remaining quota into one severity for sorting and
// colour: critical < 10% or needing a login, warning < 30%, ok otherwise.
func accountHealth(a contract.Account, lowest *accountWindow) (string, string) {
	switch a.Status {
	case "reauth":
		return "critical", "다시 로그인해야 합니다"
	case "paused":
		return "idle", "OCX에서 일시 중지된 계정입니다"
	case "unavailable":
		return "unknown", "이 계정은 한도를 조회할 수 없습니다"
	case "collecting":
		return "unknown", "첫 한도를 읽는 중입니다"
	}
	if lowest == nil || lowest.RemainingPercent == nil {
		return "unknown", "한도 정보가 없습니다"
	}
	r := *lowest.RemainingPercent
	switch {
	// A failed lookup keeps the previous reading, which still expires on its own
	// clock; it is not a reason to call a healthy account urgent.
	case r < 10:
		return "critical", lowest.Label + " 한도가 거의 소진되었습니다"
	case r < 30:
		return "warning", lowest.Label + " 한도가 30% 미만입니다"
	}
	return "ok", "정상"
}

var healthRank = map[string]int{"critical": 0, "warning": 1, "ok": 2, "unknown": 3, "idle": 4}

func accountRoster(providers []contract.Provider, rows []store.Usage, prices []calc.AppliedPrice, now int64) []accountRow {
	type key struct{ p, a string }
	day, week := map[key]*costCell{}, map[key]*costCell{}
	last := map[key]int64{}
	from := now - 7*24*calc.HourMs
	start := sort.Search(len(rows), func(i int) bool { return rows[i].At > from })
	for i := start; i < len(rows) && rows[i].At <= now; i++ {
		u := rows[i]
		if u.Account == nil {
			continue
		}
		k := key{u.Provider, *u.Account}
		if week[k] == nil {
			week[k], day[k] = &costCell{}, &costCell{}
		}
		week[k].add(u, prices[i])
		if u.At > now-24*calc.HourMs {
			day[k].add(u, prices[i])
		}
		if u.At > last[k] {
			last[k] = u.At
		}
	}
	out := []accountRow{}
	for _, p := range providers {
		for _, a := range p.Accounts {
			row := accountRow{Provider: p.ID, ProviderName: p.Name, ID: a.ID, Label: a.Label, Plan: a.Plan, Status: a.Status, Active: a.Active, UpdatedAt: a.UpdatedAt, Windows: []accountWindow{}}
			var nextReset time.Time
			for _, w := range a.Windows {
				aw := accountWindow{ID: w.ID, Label: w.Label, RemainingPercent: w.RemainingPercent, ResetAt: w.ResetAt, Stale: w.Stale != nil && *w.Stale}
				row.Windows = append(row.Windows, aw)
				if w.RemainingPercent != nil && (row.Lowest == nil || row.Lowest.RemainingPercent == nil || *w.RemainingPercent < *row.Lowest.RemainingPercent) {
					cp := aw
					row.Lowest = &cp
				}
				if w.ResetAt != nil {
					if t, err := contract.ParseISO(*w.ResetAt); err == nil && t.UnixMilli() > now && (nextReset.IsZero() || t.Before(nextReset)) {
						nextReset = t
					}
				}
			}
			if !nextReset.IsZero() {
				s := nextReset.UTC().Format(time.RFC3339Nano)
				row.NextReset = &s
			}
			row.Health, row.Reason = accountHealth(a, row.Lowest)
			k := key{p.ID, a.ID}
			if c := day[k]; c != nil {
				row.Day = finishCell(*c)
			}
			if c := week[k]; c != nil {
				row.Week = finishCell(*c)
			}
			if at := last[k]; at > 0 {
				s := isoMillis(at)
				row.LastRequestAt = &s
			}
			out = append(out, row)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if healthRank[out[i].Health] != healthRank[out[j].Health] {
			return healthRank[out[i].Health] < healthRank[out[j].Health]
		}
		li, lj := 101.0, 101.0
		if out[i].Lowest != nil && out[i].Lowest.RemainingPercent != nil {
			li = *out[i].Lowest.RemainingPercent
		}
		if out[j].Lowest != nil && out[j].Lowest.RemainingPercent != nil {
			lj = *out[j].Lowest.RemainingPercent
		}
		return li < lj
	})
	return out
}
