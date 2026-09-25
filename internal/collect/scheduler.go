package collect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

type FlightKey struct {
	Provider string
	Account  string
	Endpoint string
	Identity string
}

type Schedule struct {
	NotBefore time.Time
	Failures  int
}

type Scheduler struct {
	Clock     clock.Clock
	Transport transport.Transport
	Adapters  []Adapter
	Limit     int
	mu        sync.Mutex
	inflight  map[FlightKey]bool
	cool      map[FlightKey]Schedule
	lastGood  map[FlightKey][]Reading
	latest    map[FlightKey][]Reading
	outcome   map[FlightKey]Outcome
	restored  map[string]Outcome
}

// Outcome is the last direct read of one account endpoint: when it ran, how it
// ended in the UI's status vocabulary, and when the next read is due.
type Outcome struct {
	Provider      string `json:"provider"`
	Account       string `json:"account"`
	Endpoint      string `json:"endpoint"`
	Status        string `json:"status"`
	LastAttemptAt int64  `json:"lastAttemptAt"`
	LastSuccessAt int64  `json:"lastSuccessAt,omitempty"`
	NextAttemptAt int64  `json:"nextAttemptAt"`
	Failures      int    `json:"failures"`
}

// Outcomes returns the latest outcome per endpoint for persistence and display.
func (s *Scheduler) Outcomes() []Outcome {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Outcome, 0, len(s.outcome))
	for key, o := range s.outcome {
		if c, ok := s.cool[key]; ok {
			o.NextAttemptAt = c.NotBefore.UnixMilli()
			o.Failures = c.Failures
		}
		out = append(out, o)
	}
	return out
}

// Restore seeds outcomes and back-off from a previous process so a restart
// neither forgets a failing credential nor retries it at once. Only entries
// that match a current binding's endpoint are applied, on its next Collect.
func (s *Scheduler) Restore(prior []Outcome) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.restored = map[string]Outcome{}
	for _, o := range prior {
		s.restored[o.Provider+"\x00"+o.Account+"\x00"+o.Endpoint] = o
	}
}

func (s *Scheduler) record(key FlightKey, status string, started int64, success bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o := s.outcome[key]
	o.Provider, o.Account, o.Endpoint = key.Provider, key.Account, key.Endpoint
	o.Status, o.LastAttemptAt = status, started
	if success {
		o.LastSuccessAt = started
	}
	s.outcome[key] = o
}

// statusFor maps an HTTP outcome to the UI's direct-status vocabulary.
func statusFor(status int) string {
	switch {
	case status == 401:
		return "unauthorized"
	case status == 403:
		return "access_denied"
	case status == 429:
		return "rate_limited"
	case status >= 500:
		return "server_error"
	default:
		return "unexpected_status"
	}
}

func NewScheduler(clk clock.Clock, tr transport.Transport) *Scheduler {
	if clk == nil {
		clk = clock.System{}
	}
	return &Scheduler{
		Clock: clk, Transport: tr, Adapters: append(Adapters(), ollamaAdapter()), Limit: 4,
		inflight: map[FlightKey]bool{}, cool: map[FlightKey]Schedule{}, lastGood: map[FlightKey][]Reading{}, latest: map[FlightKey][]Reading{}, outcome: map[FlightKey]Outcome{},
	}
}

func (s *Scheduler) Collect(ctx context.Context, bindings []Binding, enabled []string) []Reading {
	allow := map[string]bool{}
	for _, id := range enabled {
		if IsRegisteredDirect(id) || id == "ollama-cloud" {
			allow[id] = true
		}
	}
	var out []Reading
	var wg sync.WaitGroup
	sem := make(chan struct{}, s.Limit)
	var mu sync.Mutex
	counts := map[string]int{}
	for _, b := range bindings {
		counts[b.Provider+"\x00"+b.AccountID]++
	}
	for _, b := range bindings {
		if counts[b.Provider+"\x00"+b.AccountID] != 1 || !allow[b.Provider] || !allowedCredential(b) {
			continue
		}
		for _, ad := range s.Adapters {
			if ad.Provider() != b.Provider {
				continue
			}
			ref := ""
			if b.AccountRef != nil {
				ref = *b.AccountRef
			}
			identity := sha256.Sum256([]byte(b.Token + "\x00" + b.BaseURL + "\x00" + b.AuthMode + "\x00" + b.Organization + "\x00" + ref + "\x00" + string(b.Kind) + "\x00" + b.BaseStatus))
			key := FlightKey{Provider: b.Provider, Account: b.AccountID, Endpoint: ad.EndpointID(), Identity: hex.EncodeToString(identity[:])}
			s.applyRestored(key)
			if !s.tryBegin(key) {
				mu.Lock()
				out = append(out, s.cached(key)...)
				mu.Unlock()
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(b Binding, ad Adapter, key FlightKey) {
				defer wg.Done()
				defer func() { <-sem }()
				defer s.end(key)
				rows := s.fetch(ctx, b, ad, key)
				s.mu.Lock()
				s.latest[key] = append([]Reading(nil), rows...)
				s.mu.Unlock()
				mu.Lock()
				out = append(out, rows...)
				mu.Unlock()
			}(b, ad, key)
		}
	}
	wg.Wait()
	return out
}

func (s *Scheduler) applyRestored(key FlightKey) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name := key.Provider + "\x00" + key.Account + "\x00" + key.Endpoint
	prior, ok := s.restored[name]
	if !ok {
		return
	}
	delete(s.restored, name)
	if _, seen := s.outcome[key]; seen {
		return
	}
	s.outcome[key] = prior
	if prior.NextAttemptAt > 0 && prior.Failures > 0 {
		s.cool[key] = Schedule{NotBefore: time.UnixMilli(prior.NextAttemptAt), Failures: prior.Failures}
	}
}

func (s *Scheduler) tryBegin(key FlightKey) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight[key] {
		return false
	}
	if cool, ok := s.cool[key]; ok && s.Clock.Now().Before(cool.NotBefore) {
		return false
	}
	s.inflight[key] = true
	return true
}

func (s *Scheduler) end(key FlightKey) {
	s.mu.Lock()
	delete(s.inflight, key)
	s.mu.Unlock()
}

func (s *Scheduler) fetch(ctx context.Context, b Binding, ad Adapter, key FlightKey) []Reading {
	started := nowMs(s.Clock.Now())
	req, allowed := quotaRequest(b, ad)
	if !allowed {
		return nil
	}
	// Hold the key for the base interval while the request runs; the outcome
	// below replaces this with the real schedule.
	s.mu.Lock()
	failures := s.cool[key].Failures
	s.cool[key] = Schedule{NotBefore: s.Clock.Now().Add(pollInterval), Failures: failures}
	s.mu.Unlock()
	res, err := s.Transport.Do(ctx, req)
	finished := nowMs(s.Clock.Now())
	if err != nil {
		s.backoff(key, failures+1, 0)
		status := "network"
		if ctx.Err() != nil || strings.Contains(err.Error(), "deadline") || strings.Contains(err.Error(), "timeout") {
			status = "timeout"
		} else if strings.Contains(err.Error(), "redirect") {
			status = "redirect"
		} else if strings.Contains(err.Error(), "too large") {
			status = "oversized"
		}
		s.record(key, status, started, false)
		return s.failedOrLastGood(b, ad, key, WindowFailed, started, finished)
	}
	if b.Token != "" && strings.Contains(string(res.Body), b.Token) {
		s.backoff(key, failures+1, 0)
		s.record(key, "credential_echoed", started, false)
		return s.failedOrLastGood(b, ad, key, WindowInvalid, started, finished)
	}
	switch {
	case res.Status == 429:
		s.backoff(key, failures+1, retryAfter(res, pollInterval))
		s.record(key, statusFor(res.Status), started, false)
		return s.failedOrLastGood(b, ad, key, WindowFailed, started, finished)
	case res.Status == 401 || res.Status == 403:
		// The same credential will be refused again until it is replaced, and a
		// replaced credential gets a new flight key.
		s.backoff(key, failures+1, authCooldown)
		s.record(key, statusFor(res.Status), started, false)
		return s.failedOrLastGood(b, ad, key, WindowFailed, started, finished)
	case res.Status < 200 || res.Status >= 300:
		s.backoff(key, failures+1, 0)
		s.record(key, statusFor(res.Status), started, false)
		return s.failedOrLastGood(b, ad, key, WindowFailed, started, finished)
	}
	if b.Provider == "openai" {
		var body map[string]any
		_ = json.Unmarshal(res.Body, &body)
		if id, ok := body["account_id"].(string); b.AccountRef != nil && (id != *b.AccountRef || !ok) {
			s.record(key, "base_url_mismatch", started, false)
			return s.failedOrLastGood(b, ad, key, WindowInvalid, started, finished)
		}
	}
	rows, err := ad.Parse(res.Body, finished)
	if err != nil || len(rows) == 0 {
		status := "invalid_json"
		if err == nil {
			status = "observation_unavailable"
		}
		s.record(key, status, started, false)
		return s.failedOrLastGood(b, ad, key, WindowInvalid, started, finished)
	}
	okOnly := make([]Reading, 0, len(rows))
	for i := range rows {
		rows[i].Account = b.AccountID
		rows[i].Provider = ad.Provider()
		rows[i].Endpoint = ad.EndpointID()
		rows[i].StartedAt = started
		rows[i].FinishedAt = finished
		if rows[i].UsedPercent != nil && (math.IsNaN(*rows[i].UsedPercent) || math.IsInf(*rows[i].UsedPercent, 0) || *rows[i].UsedPercent < 0) {
			rows[i].UsedPercent = nil
			rows[i].RemainingPercent = nil
		}
		if rows[i].UsedPercent != nil && *rows[i].UsedPercent > 100 {
			capped := 100.0
			rows[i].UsedPercent = &capped
			rows[i].RemainingPercent = remain(rows[i].UsedPercent)
		}
		if rows[i].Kind == WindowInvalid {
			s.record(key, "invalid_json", started, false)
			return s.failedOrLastGood(b, ad, key, WindowInvalid, started, finished)
		}
		if rows[i].Kind == WindowOK && rows[i].WindowID != "" {
			okOnly = append(okOnly, rows[i])
		}
	}
	s.mu.Lock()
	s.lastGood[key] = okOnly
	s.cool[key] = Schedule{NotBefore: s.Clock.Now().Add(pollInterval)}
	s.mu.Unlock()
	s.record(key, "ok", started, true)
	return rows
}

const (
	pollInterval = 120 * time.Second
	maxBackoff   = 30 * time.Minute
	authCooldown = 30 * time.Minute
)

// backoff doubles the wait for each consecutive failure, up to maxBackoff,
// and never waits less than floor. Success clears the count (see fetch).
func (s *Scheduler) backoff(key FlightKey, failures int, floor time.Duration) {
	wait := pollInterval
	for i := 1; i < failures && wait < maxBackoff; i++ {
		wait *= 2
	}
	if wait > maxBackoff {
		wait = maxBackoff
	}
	if floor > wait {
		wait = floor
	}
	s.mu.Lock()
	s.cool[key] = Schedule{NotBefore: s.Clock.Now().Add(wait), Failures: failures}
	s.mu.Unlock()
}

func retryAfter(res transport.Response, localMax time.Duration) time.Duration {
	raw := ""
	if res.Headers != nil {
		raw = res.Headers.Get("Retry-After")
	}
	sec, err := strconv.Atoi(raw)
	if err != nil || sec <= 0 {
		return localMax
	}
	wait := time.Duration(sec) * time.Second
	if wait < localMax {
		return localMax
	}
	return wait
}

func (s *Scheduler) LastGood(key FlightKey) []Reading {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Reading(nil), s.lastGood[key]...)
}

// failedOrLastGood keeps the original observation time of a prior success.
// Empty/invalid success bodies are not rewritten onto last-good here; only
// transport and parse-path failures reuse the last good windows.
func (s *Scheduler) failedOrLastGood(b Binding, ad Adapter, key FlightKey, kind WindowKind, started, finished int64) []Reading {
	marker := Reading{Provider: b.Provider, Account: b.AccountID, Endpoint: ad.EndpointID(),
		Kind: kind, StartedAt: started, FinishedAt: finished, ObservedAt: started}
	s.mu.Lock()
	prev := append([]Reading(nil), s.lastGood[key]...)
	s.mu.Unlock()
	out := []Reading{marker}
	for _, row := range prev {
		if row.WindowID == "" {
			continue
		}
		row.Kind = WindowFailed
		row.StartedAt = started
		row.FinishedAt = finished
		out = append(out, row)
	}
	return out
}

func (s *Scheduler) cached(key FlightKey) []Reading {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows := append([]Reading(nil), s.latest[key]...)
	for i := range rows {
		rows[i].Cached = true
	}
	return rows
}
