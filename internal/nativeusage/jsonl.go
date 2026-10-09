package nativeusage

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Counts struct {
	Input  int64 `json:"input_tokens"`
	Output int64 `json:"output_tokens"`
	Cached int64 `json:"cached_input_tokens"`
	Write  int64 `json:"cache_write_input_tokens"`
}

// State contains only parser metadata; raw session/turn identifiers are hashed.
type State struct {
	Session, Turn, Model string
	Total                *Counts
	Proxy                bool
}

type ParseResult struct {
	Event   *Event
	Invalid bool
}

var anthropicRequest = regexp.MustCompile(`^req_[A-Za-z0-9]{16,128}$`)

func ParseLine(client string, line []byte, state *State) ParseResult {
	if client == "claude" {
		return parseClaude(line)
	}
	return parseCodex(line, state)
}

func parseClaude(line []byte) ParseResult {
	var row struct {
		Type, Timestamp, RequestID string
		Message                    struct {
			ID, Model string
			Usage     *struct {
				Input  *int64 `json:"input_tokens"`
				Output *int64 `json:"output_tokens"`
				Read   int64  `json:"cache_read_input_tokens"`
				Write  int64  `json:"cache_creation_input_tokens"`
				Tier   string `json:"service_tier"`
				Cache  struct {
					Hour int64 `json:"ephemeral_1h_input_tokens"`
				} `json:"cache_creation"`
			}
		}
	}
	if json.Unmarshal(line, &row) != nil {
		return ParseResult{Invalid: true}
	}
	if row.Type != "assistant" || row.Message.Usage == nil {
		return ParseResult{}
	}
	u := row.Message.Usage
	at, err := time.Parse(time.RFC3339Nano, row.Timestamp)
	if err != nil || u.Input == nil || u.Output == nil || row.Message.ID == "" {
		return ParseResult{Invalid: true}
	}
	for _, n := range []int64{*u.Input, *u.Output, u.Read, u.Write, u.Cache.Hour} {
		if n < 0 || n > MaxTokens {
			return ParseResult{Invalid: true}
		}
	}
	route, evidence := claudeRoute(row.Message.Model, row.RequestID)
	e := Event{ID: Hash("native-v1", "claude", row.Message.ID), Client: "claude", Provider: "anthropic", PriceProvider: "anthropic", Model: Model(row.Message.Model), At: at.UnixMilli(), Input: *u.Input + u.Read + u.Write, Output: *u.Output, CacheRead: u.Read, CacheWrite: u.Write, CacheWrite1h: u.Cache.Hour, Tier: u.Tier, Route: route, Evidence: evidence}
	if *u.Input < 0 || !e.Valid() {
		return ParseResult{Invalid: true}
	}
	return ParseResult{Event: &e}
}

// Claude Code's requestId is captured from the response's request-id header.
// Anthropic answers with req_ IDs and logged OCX responses with ocx- IDs;
// message.id may be preserved even by OCX passthrough and proves no route.
// An ocx- model is an OCX picker alias that Anthropic cannot serve. Stored
// rows from parser revision 1 carry "route-unverified" for both absent and
// unrecognized IDs.
func claudeRoute(model, requestID string) (Route, string) {
	switch {
	case strings.HasPrefix(model, "ocx-"):
		return Proxy, "ocx-model-alias"
	case anthropicRequest.MatchString(requestID):
		return Direct, "anthropic-request-header"
	case strings.HasPrefix(requestID, "ocx-"):
		return Proxy, "ocx-request-marker"
	case requestID == "":
		return Unknown, "request-id-absent"
	}
	return Unknown, "request-id-unrecognized"
}

func parseCodex(line []byte, state *State) ParseResult {
	var row struct {
		Type, Timestamp string
		Payload         json.RawMessage
	}
	if json.Unmarshal(line, &row) != nil {
		return ParseResult{Invalid: true}
	}
	switch row.Type {
	case "session_meta":
		var p struct {
			ID       string
			Provider string `json:"model_provider"`
		}
		if json.Unmarshal(row.Payload, &p) != nil {
			return ParseResult{Invalid: true}
		}
		state.Session = Hash(p.ID)
		state.Proxy = p.Provider == "opencodex" || p.Provider == "ocx"
		return ParseResult{}
	case "turn_context":
		var p struct {
			Model string
			Turn  string `json:"turn_id"`
		}
		if json.Unmarshal(row.Payload, &p) != nil {
			return ParseResult{Invalid: true}
		}
		state.Model = Model(p.Model)
		state.Turn = Hash(p.Turn)
		return ParseResult{}
	case "event_msg":
	default:
		return ParseResult{}
	}
	var p struct {
		Type string
		Info *struct {
			Total *Counts `json:"total_token_usage"`
			Last  *Counts `json:"last_token_usage"`
		}
	}
	if json.Unmarshal(row.Payload, &p) != nil {
		return ParseResult{Invalid: true}
	}
	if p.Type != "token_count" || p.Info == nil || p.Info.Total == nil {
		return ParseResult{}
	}
	total := *p.Info.Total
	if !validCounts(total) {
		return ParseResult{Invalid: true}
	}
	if state.Total != nil && total == *state.Total {
		return ParseResult{}
	}
	usage := total
	if p.Info.Last != nil {
		usage = *p.Info.Last
	}
	if prev := state.Total; prev != nil && total.Input >= prev.Input && total.Output >= prev.Output && total.Cached >= prev.Cached && total.Write >= prev.Write {
		usage = Counts{total.Input - prev.Input, total.Output - prev.Output, total.Cached - prev.Cached, total.Write - prev.Write}
	}
	state.Total = &total
	at, err := time.Parse(time.RFC3339Nano, row.Timestamp)
	if err != nil || !validCounts(usage) {
		return ParseResult{Invalid: true}
	}
	if usage.Input+usage.Output == 0 {
		return ParseResult{}
	}
	// Cumulative counters can reappear after rate-limit notifications and forks.
	// Turn/time/counters identify the source observation without a file path.
	identity := state.Turn
	if identity == "" || identity == Hash("") {
		identity = state.Session
	}
	e := Event{ID: Hash("native-v1", "codex", identity, row.Timestamp, state.Model, strconv.FormatInt(total.Input, 10), strconv.FormatInt(total.Output, 10), strconv.FormatInt(total.Cached, 10), strconv.FormatInt(total.Write, 10)), Client: "codex", Provider: "openai", PriceProvider: "openai", Model: Model(state.Model), At: at.UnixMilli(), Input: usage.Input, Output: usage.Output, CacheRead: usage.Cached, CacheWrite: usage.Write, Route: Unknown, Evidence: "route-unverified"}
	if state.Proxy {
		e.Route, e.Evidence = Proxy, "ocx-provider-marker"
	}
	// Native Codex transcripts do not persist the request URL. model_provider
	// "openai" also appears when OpenAI's base URL points at OCX, so never use
	// it (or today's config) as proof that this historical call was direct.
	if !e.Valid() {
		return ParseResult{Invalid: true}
	}
	return ParseResult{Event: &e}
}

func validCounts(c Counts) bool {
	return c.Input >= 0 && c.Output >= 0 && c.Cached >= 0 && c.Write >= 0 && c.Input <= MaxTokens && c.Output <= MaxTokens && c.Cached <= MaxTokens && c.Write <= MaxTokens && c.Cached+c.Write <= c.Input
}
