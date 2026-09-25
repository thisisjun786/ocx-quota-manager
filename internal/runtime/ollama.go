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

// Ollama Cloud reports a share of each window plus a per-model request
// counter, but no tokens. Matching isolated single-model runs against the
// usage log gives tokens and API-equivalent dollars per percentage point.
// Ported from src/ollama.mjs calibrateOllama.

const (
	ollamaMaxGap      = 3 * time.Minute
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
		if r.Provider != "ollama-cloud" || r.Cached || r.Kind != collect.WindowOK || r.UsedPercent == nil || r.ModelRequests == nil {
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
			}
			a.Ollama = map[string]any{"windows": windows, "observations": len(obs)}
		}
	}
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
