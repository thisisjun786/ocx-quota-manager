package collect

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

type WindowKind string

const (
	WindowOK      WindowKind = "ok"
	WindowEmpty   WindowKind = "empty"
	WindowInvalid WindowKind = "invalid"
	WindowFailed  WindowKind = "failed"
)

type Reading struct {
	Provider         string
	Account          string
	Endpoint         string
	WindowID         string
	Label            string
	RemainingPercent *float64
	UsedPercent      *float64
	ResetAt          *int64
	Kind             WindowKind
	ObservedAt       int64
	StartedAt        int64
	FinishedAt       int64
	// Hidden marks a window the vendor itself withholds (Devin hideDailyQuota).
	// Downstream publishers must drop hidden rows; the parser emits the id so the
	// withholding stays observable.
	Cached bool // A projected cached reading must not be persisted as a new observation.
	Hidden bool
	// ModelRequests is the provider's per-model request counter for this window,
	// when it reports one (Ollama Cloud). Fraction is the raw share it reported.
	ModelRequests map[string]int64
	Fraction      *float64
}

type Adapter interface {
	Provider() string
	EndpointID() string
	Host() string
	Path() string
	Method() string
	Parse(body []byte, now int64) ([]Reading, error)
}

type adapter struct {
	provider, endpoint, host, path, method string
	parse                                  func([]byte, int64) ([]Reading, error)
}

func (a adapter) Provider() string   { return a.provider }
func (a adapter) EndpointID() string { return a.endpoint }
func (a adapter) Host() string       { return a.host }
func (a adapter) Path() string       { return a.path }
func (a adapter) Method() string     { return a.method }
func (a adapter) Parse(body []byte, now int64) ([]Reading, error) {
	return a.parse(body, now)
}

func Adapters() []Adapter {
	return []Adapter{
		adapter{"kimi", "usages", "api.kimi.com", "/coding/v1/usages", "GET", parseKimi},
		adapter{"openai", "wham-usage", "chatgpt.com", "/backend-api/wham/usage", "GET", parseCodex},
		adapter{"anthropic", "oauth-usage", "api.anthropic.com", "/api/oauth/usage", "GET", parseClaude},
		adapter{"cursor", "period-usage", "api2.cursor.sh", "/aiserver.v1.DashboardService/GetCurrentPeriodUsage", "POST", parseCursor},
		adapter{"xai", "grok-credits", "cli-chat-proxy.grok.com", "/v1/billing?format=credits", "GET", parseGrok},
		adapter{"xai", "grok-billing", "cli-chat-proxy.grok.com", "/v1/billing", "GET", parseGrokBilling},
		adapter{"devin", "user-status", "server.codeium.com", "/exa.seat_management_pb.SeatManagementService/GetUserStatus", "POST", parseDevin},
		adapter{"command-code", "credits", "api.commandcode.ai", "/alpha/billing/credits", "GET", parseCommandCode},
		adapter{"opencode-go", "usage", "opencode.ai", "/zen/go/v1/usage", "GET", parseOpenCode},
	}
}

// parseObject decodes one JSON object body. Array or scalar bodies are invalid
// shapes, not empty ones.
func parseObject(body []byte) (map[string]any, error) {
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		return nil, fmt.Errorf("%w", err)
	}
	return obj, nil
}

// parserResult wraps a parser's rows with the marker convention the scheduler
// expects: one invalid row for an undecodable body, one empty row for a body
// that decoded but named no window.
func parserResult(rows []Reading, err error, provider, endpoint string, now int64) ([]Reading, error) {
	if err != nil {
		return []Reading{{Provider: provider, Endpoint: endpoint, Kind: WindowInvalid, ObservedAt: now}}, nil
	}
	if len(rows) == 0 {
		return []Reading{{Provider: provider, Endpoint: endpoint, Kind: WindowEmpty, ObservedAt: now}}, nil
	}
	return rows, nil
}

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

func str(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && len(s) > 0 && len(s) <= 200
}

func num(v any) *float64 {
	switch n := v.(type) {
	case float64:
		return &n
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return nil
		}
		return &f
	default:
		return nil
	}
}

func remain(used *float64) *float64 {
	if used == nil || *used < 0 || math.IsNaN(*used) || math.IsInf(*used, 0) {
		return nil
	}
	v := math.Max(0, 100-*used)
	return &v
}

// instant turns the reset shapes providers send into epoch milliseconds.
// Ten digits cannot be a millisecond timestamp in any year this product will
// see, so the smaller value is seconds. ISO strings are accepted where the
// Node readers accept them; out-of-range values are no reset at all.
func instant(v any) *int64 {
	var n *float64
	switch v.(type) {
	case float64, json.Number:
		n = num(v)
	default:
		if s, ok := str(v); ok {
			trimmed := strings.TrimSpace(s)
			if isNumericString(trimmed) {
				f, err := strconv.ParseFloat(trimmed, 64)
				if err == nil {
					n = &f
				}
			} else {
				return parseISOMillis(trimmed)
			}
		}
	}
	if n == nil {
		return nil
	}
	ms := *n
	if ms <= 10000000000 {
		ms *= 1000
	}
	if ms <= 0 || ms > 8.64e15 {
		return nil
	}
	out := int64(ms)
	return &out
}

func isNumericString(s string) bool {
	if s == "" {
		return false
	}
	dot := false
	for i, c := range s {
		switch {
		case c >= '0' && c <= '9':
		case c == '.' && !dot && i > 0 && i < len(s)-1:
			dot = true
		default:
			return false
		}
	}
	return true
}

func parseISOMillis(s string) *int64 {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05Z07:00", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			ms := t.UnixMilli()
			if ms > 0 && ms <= 8.64e15 {
				return &ms
			}
			return nil
		}
	}
	return nil
}

// hoursLabel renders a burst-window duration the way the Node reader does:
// one decimal at most, then "시간".
func hoursLabel(seconds float64) string {
	h := math.Round(seconds/3600*10) / 10
	return strconv.FormatFloat(h, 'f', -1, 64) + "시간"
}

func nowMs(t time.Time) int64 { return t.UTC().UnixMilli() }
