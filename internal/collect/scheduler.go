package collect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
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
	OnAttempt func(Attempt) error
	logErrors []error
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

// Attempt records only non-secret metadata for one external call.
type Attempt struct {
	StartedAt     int64  `json:"startedAt"`
	Provider      string `json:"provider"`
	Account       string `json:"account"`
	Endpoint      string `json:"endpoint"`
	Result        string `json:"result"`
	HTTPStatus    *int   `json:"httpStatus"`
	DurationMs    int64  `json:"durationMs"`
	RetryAfterMs  *int64 `json:"retryAfterMs"`
	NextAttemptAt int64  `json:"nextAttemptAt"`
	Failures      int    `json:"failures"`
}

// Outcome is the latest direct read per logical account endpoint.
type Outcome struct {
	CredentialIdentity string `json:"credentialIdentity,omitempty"`
	Provider      string `json:"provider"`
	Account       string `json:"account"`
	Endpoint      string `json:"endpoint"`
	Status        string `json:"status"`
	LastAttemptAt int64  `json:"lastAttemptAt"`
	LastSuccessAt int64  `json:"lastSuccessAt,omitempty"`
	NextAttemptAt int64  `json:"nextAttemptAt"`
	Failures      int    `json:"failures"`
}

func logical(key FlightKey) FlightKey { key.Identity = ""; return key }

func (s *Scheduler) LogErrors() []error {
	s.mu.Lock()
	defer s.mu.Unlock()
	errs := s.logErrors
	s.logErrors = nil
	return errs
}

// Outcomes returns the latest outcome per endpoint for persistence and display.
func (s *Scheduler) Outcomes() []Outcome {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Outcome, 0, len(s.outcome))
	for key, o := range s.outcome {
		if c, ok := s.cool[logical(key)]; ok {
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
		name := o.Provider + "\x00" + o.Account + "\x00" + o.Endpoint
		if previous, exists := s.restored[name]; !exists || o.LastAttemptAt > previous.LastAttemptAt {
			s.restored[name] = o
		}
	}
}

func (s *Scheduler) record(key FlightKey, status string, started int64, success bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	identity := key.Identity
	key = logical(key)
	o := s.outcome[key]
	o.CredentialIdentity = identity
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
	key = logical(key)
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
	if prior.NextAttemptAt > 0 {
		s.cool[logical(key)] = Schedule{NotBefore: time.UnixMilli(prior.NextAttemptAt), Failures: prior.Failures}
	}
}

func (s *Scheduler) tryBegin(key FlightKey) bool {
	identity := key.Identity
	key = logical(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight[key] {
		return false
	}
	prior := s.outcome[key]
	if prior.CredentialIdentity != "" && prior.CredentialIdentity != identity && (prior.Status == "unauthorized" || prior.Status == "access_denied") {
		s.cool[key] = Schedule{NotBefore: time.UnixMilli(prior.LastAttemptAt).Add(pollInterval)}
	}
	if cool, ok := s.cool[logical(key)]; ok && s.Clock.Now().Before(cool.NotBefore) {
		return false
	}
	s.inflight[key] = true
	return true
}

func (s *Scheduler) end(key FlightKey) {
	key = logical(key)
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
	attempt := Attempt{StartedAt: started, Provider: b.Provider, Account: b.AccountID, Endpoint: ad.EndpointID()}
	defer func() {
		attempt.DurationMs = nowMs(s.Clock.Now()) - started
		if attempt.DurationMs < 0 {
			attempt.DurationMs = 0
		}
		s.mu.Lock()
		state := s.cool[logical(key)]
		attempt.NextAttemptAt, attempt.Failures = state.NotBefore.UnixMilli(), state.Failures
		s.mu.Unlock()
		if s.OnAttempt != nil {
			if err := s.OnAttempt(attempt); err != nil {
				s.mu.Lock()
				s.logErrors = append(s.logErrors, err)
				s.mu.Unlock()
			}
		}
	}()
	// Hold the key for the base interval while the request runs; the outcome
	// below replaces this with the real schedule.
	s.mu.Lock()
	failures := s.cool[logical(key)].Failures
	s.cool[logical(key)] = Schedule{NotBefore: s.Clock.Now().Add(pollInterval), Failures: failures}
	s.mu.Unlock()
	res, err := s.Transport.Do(ctx, req)
	finished := nowMs(s.Clock.Now())
	if err == nil {
		attempt.HTTPStatus = &res.Status
		_, attempt.RetryAfterMs = retryAfter(res, s.Clock.Now())
	}
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
		attempt.Result = status
		s.record(key, status, started, false)
		return s.failedOrLastGood(b, ad, key, WindowFailed, started, finished)
	}
	if b.Token != "" && strings.Contains(string(res.Body), b.Token) {
		s.backoff(key, failures+1, 0)
		attempt.Result = "credential_echoed"
		s.record(key, attempt.Result, started, false)
		return s.failedOrLastGood(b, ad, key, WindowInvalid, started, finished)
	}
	switch {
	case res.Status == 429:
		wait, parsed := retryAfter(res, s.Clock.Now())
		attempt.RetryAfterMs = parsed
		s.backoff(key, failures+1, wait)
		attempt.Result = statusFor(res.Status)
		s.record(key, attempt.Result, started, false)
		return s.failedOrLastGood(b, ad, key, WindowFailed, started, finished)
	case res.Status == 401 || res.Status == 403:
		// A replacement credential may recover after the normal cadence floor.
		s.backoff(key, failures+1, authCooldown)
		attempt.Result = statusFor(res.Status)
		s.record(key, attempt.Result, started, false)
		return s.failedOrLastGood(b, ad, key, WindowFailed, started, finished)
	case res.Status < 200 || res.Status >= 300:
		wait, _ := retryAfter(res, s.Clock.Now())
		s.backoff(key, failures+1, wait)
		attempt.Result = statusFor(res.Status)
		s.record(key, attempt.Result, started, false)
		return s.failedOrLastGood(b, ad, key, WindowFailed, started, finished)
	}
	if b.Provider == "openai" {
		var body map[string]any
		_ = json.Unmarshal(res.Body, &body)
		if id, ok := body["account_id"].(string); b.AccountRef != nil && (id != *b.AccountRef || !ok) {
			s.backoff(key, failures+1, 0)
			attempt.Result = "base_url_mismatch"
			s.record(key, attempt.Result, started, false)
			return s.failedOrLastGood(b, ad, key, WindowInvalid, started, finished)
		}
	}
	rows, err := ad.Parse(res.Body, finished)
	if err != nil || len(rows) == 0 {
		s.backoff(key, failures+1, 0)
		status := "invalid_json"
		if err == nil {
			status = "observation_unavailable"
		}
		attempt.Result = status
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
			s.backoff(key, failures+1, 0)
			attempt.Result = "invalid_json"
			s.record(key, attempt.Result, started, false)
			return s.failedOrLastGood(b, ad, key, WindowInvalid, started, finished)
		}
		if rows[i].Kind == WindowOK && rows[i].WindowID != "" {
			okOnly = append(okOnly, rows[i])
		}
	}
	s.mu.Lock()
	s.lastGood[key] = okOnly
	s.cool[logical(key)] = Schedule{NotBefore: s.Clock.Now().Add(pollInterval)}
	s.mu.Unlock()
	attempt.Result = "ok"
	s.record(key, attempt.Result, started, true)
	return rows
}

const (
	pollInterval = 5 * time.Minute
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
	s.cool[logical(key)] = Schedule{NotBefore: s.Clock.Now().Add(wait), Failures: failures}
	s.mu.Unlock()
}

func retryAfter(res transport.Response, now time.Time) (time.Duration, *int64) {
	raw := ""
	if res.Headers != nil {
		raw = strings.TrimSpace(res.Headers.Get("Retry-After"))
	}
	var wait time.Duration
	if sec, err := strconv.ParseInt(raw, 10, 64); err == nil && sec > 0 && sec <= math.MaxInt64/int64(time.Second) {
		wait = time.Duration(sec) * time.Second
	} else if date, err := http.ParseTime(raw); err == nil && date.After(now) {
		wait = date.Sub(now)
	}
	if wait == 0 {
		return pollInterval, nil
	}
	ms := wait.Milliseconds()
	if wait < pollInterval {
		return pollInterval, &ms
	}
	return wait, &ms
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
