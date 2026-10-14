package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

// Ollama Cloud reports a remaining share per window on /api/balance. The
// legacy /api/usage surface also carried per-model request counters, but no
// tokens. Matching isolated single-model runs against the usage log gives
// tokens and API-equivalent dollars per percentage point. Ported from
// src/ollama.mjs calibrateOllama; balance-based readings calibrate nothing.

const (
	// Direct reads poll each account every five minutes, so one missed poll
	// still keeps a run continuous.
	ollamaMaxGap      = 11 * time.Minute
	ollamaMinSpan     = 5 * time.Minute
	ollamaMinDeltaPp  = 0.2
	ollamaHistoryDays = 30
)

var ollamaWindows = [][3]string{{"session", "five-hour", "5시간"}, {"weekly", "weekly", "주간"}}

type ollamaStore interface {
	InsertOllamaObservation(source string, at int64, limits map[string]store.OllamaWindow) error
	ListOllamaObservations(source string, from int64) ([]store.OllamaObservation, error)
}

// ollamaSource matches the Node salt so readings stored before the Go port
// continue the same series for the same credential.
func ollamaSource(token string) string {
	sum := sha256.Sum256([]byte("quota-monitor-ollama\x00" + token))
	return hex.EncodeToString(sum[:])
}

// persistOllama stores one fresh Ollama reading per account.
func persistOllama(st ollamaStore, bindings []collect.Binding, rows []collect.Reading) error {
	tokens := map[string]string{}
	for _, b := range bindings {
		if b.Provider == "ollama-cloud" {
			tokens[b.AccountID] = b.Token
		}
	}
	type key struct {
		account string
		at      int64
	}
	byAccount := map[key]map[string]store.OllamaWindow{}
	for _, r := range rows {
		// /api/balance carries no per-model request counters. A nil
		// ModelRequests map must still persist, or usage deltas and
		// forecasts would skip every balance-based reading.
		if r.Provider != "ollama-cloud" || r.Cached || r.Kind != collect.WindowOK || r.UsedPercent == nil {
			continue
		}
		name := ""
		for _, w := range ollamaWindows {
			if w[1] == r.WindowID {
				name = w[0]
			}
		}
		if name == "" {
			continue
		}
		k := key{r.Account, r.ObservedAt}
		if byAccount[k] == nil {
			byAccount[k] = map[string]store.OllamaWindow{}
		}
		byAccount[k][name] = store.OllamaWindow{Used: *r.UsedPercent, Fraction: r.Fraction, Models: r.ModelRequests}
	}
	for k, limits := range byAccount {
		token, ok := tokens[k.account]
		if !ok || token == "" {
			continue
		}
		if err := st.InsertOllamaObservation(ollamaSource(token), k.at, limits); err != nil {
			return err
		}
	}
	return nil
}

type ollamaModel struct {
	Model             string   `json:"model"`
	Intervals         int      `json:"intervals"`
	Requests          int64    `json:"requests"`
	DeltaPp           float64  `json:"deltaPp"`
	InputTokens       float64  `json:"inputTokens"`
	OutputTokens      float64  `json:"outputTokens"`
	InputTokensPerPp  float64  `json:"inputTokensPerPp"`
	OutputTokensPerPp float64  `json:"outputTokensPerPp"`
	APIUsdPerPp       *float64 `json:"apiUsdPerPp"`
	ObservedAt        string   `json:"observedAt"`
	apiUsd            float64
	priced            bool
}

// calibrateOllama keeps only runs where exactly one model's counter moved and
// the usage log holds exactly that many calls of that model with tokens.
func calibrateOllama(obs []store.OllamaObservation, rows []store.Usage, prices []calc.AppliedPrice, window string) []ollamaModel {
	totals := map[string]*ollamaModel{}
	if len(obs) == 0 {
		return nil
	}
	start := obs[0]
	for i := 1; i < len(obs); i++ {
		end, prev := obs[i], obs[i-1]
		a, okA := start.Limits[window]
		b, okB := end.Limits[window]
		p, okP := prev.Limits[window]
		reset := !okA || !okB || !okP || end.At <= prev.At || end.At-prev.At > ollamaMaxGap.Milliseconds() || b.Used < p.Used
		for m, n := range p.Models {
			if b.Models[m] < n {
				reset = true
			}
		}
		if reset {
			start = end
			continue
		}
		delta := b.Used - a.Used
		if end.At-start.At < ollamaMinSpan.Milliseconds() || delta < ollamaMinDeltaPp {
			continue
		}
		type change struct {
			model string
			n     int64
		}
		var changes []change
		for m, n := range b.Models {
			if d := n - a.Models[m]; d > 0 {
				changes = append(changes, change{m, d})
			}
		}
		lo := sort.Search(len(rows), func(i int) bool { return rows[i].At > start.At })
		models := map[string]bool{}
		var window []int
		for i := lo; i < len(rows) && rows[i].At <= end.At; i++ {
			if rows[i].Provider != "ollama-cloud" {
				continue
			}
			window = append(window, i)
			if rows[i].Model != nil {
				models[*rows[i].Model] = true
			}
		}
		if len(changes) == 1 {
			c := changes[0]
			matched := 0
			for _, i := range window {
				u := rows[i]
				if u.Model != nil && *u.Model == c.model && u.Input != nil && u.Output != nil && *u.Input+*u.Output > 0 {
					matched++
				}
			}
			if int64(len(window)) == c.n && int64(matched) == c.n {
				t := totals[c.model]
				if t == nil {
					t = &ollamaModel{Model: c.model, priced: true}
					totals[c.model] = t
				}
				t.Intervals++
				t.Requests += c.n
				t.DeltaPp += delta
				t.ObservedAt = time.UnixMilli(end.At).UTC().Format(time.RFC3339Nano)
				for _, i := range window {
					t.InputTokens += *rows[i].Input
					t.OutputTokens += *rows[i].Output
					if prices[i].USD == nil {
						t.priced = false
					} else {
						t.apiUsd += *prices[i].USD
					}
				}
				start = end
			}
		}
		if len(changes) > 1 || len(models) > 1 {
			start = end
		}
	}
	out := make([]ollamaModel, 0, len(totals))
	for _, t := range totals {
		if t.DeltaPp <= 0 {
			continue
		}
		t.InputTokensPerPp = t.InputTokens / t.DeltaPp
		t.OutputTokensPerPp = t.OutputTokens / t.DeltaPp
		if t.priced {
			v := t.apiUsd / t.DeltaPp
			if !math.IsNaN(v) && !math.IsInf(v, 0) {
				t.APIUsdPerPp = &v
			}
		}
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Model < out[j].Model })
	return out
}

// attachOllama sets account.ollama for every Ollama Cloud account whose
// readings are stored under its credential.
func attachOllama(providers []contract.Provider, hist any, bindings []collect.Binding, rows []store.Usage, prices []calc.AppliedPrice, now time.Time) {
	st, ok := hist.(ollamaStore)
	if !ok {
		return
	}
	tokens := map[string]string{}
	for _, b := range bindings {
		if b.Provider == "ollama-cloud" {
			tokens[b.AccountID] = b.Token
		}
	}
	from := now.Add(-ollamaHistoryDays * 24 * time.Hour).UnixMilli()
	for i := range providers {
		if providers[i].ID != "ollama-cloud" {
			continue
		}
		for j := range providers[i].Accounts {
			a := &providers[i].Accounts[j]
			token := tokens[a.ID]
			if token == "" {
				continue
			}
			obs, err := ollamaCache.read(st, ollamaSource(token), from)
			if err != nil {
				continue
			}
			windows := []map[string]any{}
			for _, w := range ollamaWindows {
				models := calibrateOllama(obs, rows, prices, w[0])
				if models == nil {
					models = []ollamaModel{}
				}
				windows = append(windows, map[string]any{"id": w[1], "label": w[2], "models": models})
				for k := range a.Windows {
					if a.Windows[k].ID == w[1] {
						applyOllamaWindow(&a.Windows[k], obs, models, w[0], now.UnixMilli())
					}
				}
			}
			a.Ollama = map[string]any{"windows": windows, "observations": len(obs)}
		}
	}
}

// applyOllamaWindow keeps consumption estimates compatible with legacy
// resetless history: only adjacent nondecreasing readings contribute.
// Balance readings preserve their reset in the window, and capacity still
// requires the legacy per-model counters from calibrated runs.
func applyOllamaWindow(w *contract.Window, obs []store.OllamaObservation, models []ollamaModel, name string, now int64) {
	dto, ok := w.Analytics.(map[string]any)
	if !ok {
		dto = map[string]any{}
		w.Analytics = dto
	}
	periods := map[string]any{}
	for key, sample := range ollamaConsumption(obs, name, now) {
		periods[key] = periodDTO(sample)
	}
	dto["consumptionPeriods"] = periods
	hours := forecastWindowHours(*w)
	history := []calc.Point{}
	for _, o := range obs {
		if v, ok := o.Limits[name]; ok && o.At >= now-int64(hours*calc.HourMs) && o.At <= now {
			history = append(history, calc.Point{At: o.At, Used: v.Used})
		}
	}
	sampled := sampleForecastHistory(history)
	for _, p := range sampled {
		delete(p, "resetAt")
	}
	dto["history"] = sampled
	dto["status"] = "collecting"
	dto["reason"] = "연속 관측된 증가분만 추정합니다. 감소·공백은 제외합니다."
	dto["forecastReason"] = dto["reason"]
	applyOllamaForecast(dto, w, obs, name, hours, now)
	dto["capacityApiUsd"], dto["remainingApiUsd"], dto["capacityBasis"] = nil, nil, nil
	dto["capacityReason"] = "한도 추산에는 제공사 호출 수와 토큰 로그가 일치하는 단일 모델 구간이 필요합니다."
	delta, usd, observedAt := 0.0, 0.0, ""
	for _, m := range models {
		if !m.priced || m.DeltaPp <= 0 {
			return
		}
		delta += m.DeltaPp
		usd += m.apiUsd
		if m.ObservedAt > observedAt {
			observedAt = m.ObservedAt
		}
	}
	if delta <= 0 || usd <= 0 {
		return
	}
	capacity := usd / delta * 100
	dto["capacityApiUsd"] = capacity
	if w.RemainingPercent != nil && (w.Stale == nil || !*w.Stale) {
		dto["remainingApiUsd"] = capacity * *w.RemainingPercent / 100
	}
	dto["matchedApiUsd"] = usd
	dto["matchedDeltaPp"] = delta
	dto["capacityObservedDeltaPp"] = delta
	dto["capacityObservedAt"] = observedAt
	dto["capacityBasis"] = "workload-estimate"
	dto["confidence"] = "low"
	reason := "제공사 호출 수와 토큰 로그가 일치한 구간의 API 환산액 ÷ 관측 증가분 × 100입니다. " +
		"관측된 모델·입출력 비율을 유지한다는 가정이며 공식 한도나 청구액이 아닙니다. " +
		"리셋·이동 구간 여부와 캐시 할인을 확인할 수 없어 오차가 큽니다. "
	if delta < 2 {
		reason += "소량 변화라 반올림·갱신 지연의 영향도 큽니다. "
	}
	dto["capacityReason"] = reason + "리셋 시각을 확인할 수 없습니다."
}

// applyOllamaForecast projects exhaustion from the 7-day observed-increase
// rate, like other providers, but without a reset instant. The only reset fact
// used is the window length: exhaustion farther away than one window cannot
// happen before the window resets or rolls over.
func applyOllamaForecast(dto map[string]any, w *contract.Window, obs []store.OllamaObservation, name string, windowHours float64, now int64) {
	weekly := ollamaConsumption(obs, name, now)[calc.PeriodWeekly]
	dto["forecastObservedHours"] = weekly.ObservedHours
	dto["forecastDeltaPp"] = weekly.DeltaPp
	if w.Stale != nil && *w.Stale || w.RemainingPercent == nil || len(obs) == 0 {
		return
	}
	last := obs[len(obs)-1]
	v, ok := last.Limits[name]
	remain := *w.RemainingPercent
	if !ok || now-last.At > forecastStaleMs || math.Abs((100-remain)-math.Min(100, v.Used)) > 1e-6 {
		forecastNote(dto, "현재 측정값과 일치하는 최신 관측을 기다리고 있습니다.")
		return
	}
	measuredAt := time.UnixMilli(last.At).UTC().Format(time.RFC3339Nano)
	dto["forecastObservedAt"] = measuredAt
	if remain == 0 {
		dto["status"], dto["exhaustsAt"], dto["resetBeforeExhaustion"] = "ok", measuredAt, false
		forecastNote(dto, "마지막 관측에서 한도를 모두 사용했습니다. 리셋 시각은 제공되지 않습니다.")
		return
	}
	if weekly.DeltaPp == nil || weekly.ObservedHours*calc.HourMs < float64(forecastMinRateMs) {
		forecastNote(dto, "소진 예상은 15분 이상 관측이 필요합니다. 리셋 시각은 제공되지 않습니다.")
		return
	}
	rate := *weekly.DeltaPp / weekly.ObservedHours
	dto["forecastRatePpHour"] = rate
	if rate == 0 {
		dto["status"], dto["resetBeforeExhaustion"] = "ok", true
		forecastNote(dto, "관측된 소모가 0이라 소진 시각은 없습니다.")
		return
	}
	if *weekly.DeltaPp < forecastMinDeltaPp {
		dto["forecastRatePpHour"] = nil
		forecastNote(dto, "소진 예상은 2%p 이상 변화가 필요합니다. 리셋 시각은 제공되지 않습니다.")
		return
	}
	hoursLeft := remain / rate
	dto["status"] = "ok"
	dto["exhaustsAt"] = time.UnixMilli(last.At + int64(hoursLeft*calc.HourMs)).UTC().Format(time.RFC3339Nano)
	if windowHours > 0 && hoursLeft > windowHours {
		dto["resetBeforeExhaustion"] = true
		forecastNote(dto, "최근 7일 관측 증가분의 평균 속도로는 한 창 길이 안에 소진되지 않습니다. 리셋 시각은 제공되지 않습니다.")
		return
	}
	forecastNote(dto, "최근 7일 관측 증가분의 평균 속도로 계산했습니다. 리셋 시각이 제공되지 않아 그 전에 리셋될 수도 있습니다.")
}

// ollamaConsumption sums only adjacent, nondecreasing readings; a decline or
// counter rollover is not a proven reset, and gaps are never recovered.
func ollamaConsumption(obs []store.OllamaObservation, name string, now int64) map[string]calc.PeriodSample {
	type interval struct {
		from, to int64
		delta    float64
	}
	var intervals []interval
	for i := 1; i < len(obs); i++ {
		before, after := obs[i-1], obs[i]
		a, okA := before.Limits[name]
		b, okB := after.Limits[name]
		gap := after.At - before.At
		if !okA || !okB || gap <= 0 || gap > ollamaMaxGap.Milliseconds() || after.At > now || b.Used < a.Used {
			continue
		}
		dropped := false
		for m, n := range a.Models {
			if b.Models[m] < n {
				dropped = true
			}
		}
		if !dropped {
			intervals = append(intervals, interval{before.At, after.At, b.Used - a.Used})
		}
	}
	out := map[string]calc.PeriodSample{}
	for key, hours := range calc.PeriodHours {
		from := now - int64(hours*calc.HourMs)
		var delta float64
		var observed, first, last int64
		seen := false
		for _, iv := range intervals {
			start := max(from, iv.from)
			elapsed := iv.to - start
			if elapsed <= 0 {
				continue
			}
			observed += elapsed
			delta += iv.delta * float64(elapsed) / float64(iv.to-iv.from)
			if !seen {
				first, seen = start, true
			}
			last = iv.to
		}
		s := calc.PeriodSample{Key: key, ObservedHours: float64(observed) / calc.HourMs, PeriodEndedAt: now, Basis: "observed-increase"}
		if observed >= ollamaMinSpan.Milliseconds() {
			d := delta
			s.DeltaPp = &d
		}
		if seen {
			s.SpanHours = float64(last-first) / calc.HourMs
			c := math.Min(1, float64(observed)/(hours*calc.HourMs))
			s.Coverage = &c
		}
		out[key] = s
	}
	return out
}

// ollamaObsCache keeps each source's readings and reads only newer rows each
// cycle; readings are append-only apart from retention, which only trims the
// oldest and is applied by filtering on from.
type ollamaObsCache struct {
	mu   sync.Mutex
	rows map[string][]store.OllamaObservation
}

var ollamaCache = &ollamaObsCache{rows: map[string][]store.OllamaObservation{}}

func (c *ollamaObsCache) read(st ollamaStore, source string, from int64) ([]store.OllamaObservation, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	have := c.rows[source]
	after := from
	if n := len(have); n > 0 && have[n-1].At >= from {
		after = have[n-1].At + 1
	} else {
		have = nil
	}
	fresh, err := st.ListOllamaObservations(source, after)
	if err != nil {
		return nil, err
	}
	have = append(have, fresh...)
	start := sort.Search(len(have), func(i int) bool { return have[i].At >= from })
	have = append([]store.OllamaObservation(nil), have[start:]...)
	c.rows[source] = have
	return have, nil
}
