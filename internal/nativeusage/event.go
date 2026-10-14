// Package nativeusage reads local usage metadata. It never writes source files,
// invokes a model, or retains message contents or credentials.
package nativeusage

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

const Revision = 1
const AntigravityRevision = 2
const MaxTokens int64 = 1 << 52

func SourceRevision(client string) int {
	if client == "antigravity" {
		return AntigravityRevision
	}
	return Revision
}

type Route string

const (
	Unknown  Route = "unknown"
	Direct   Route = "direct"
	Proxy    Route = "ocx"
	Conflict Route = "conflict"
)

// Input includes cache reads and writes. Output includes reasoning, so it is
// never added a second time by the price or total-token calculation.
type Event struct {
	ID, Client, Provider, PriceProvider, Model         string
	At                                                 int64
	Input, Output, CacheRead, CacheWrite, CacheWrite1h int64
	Tier                                               string
	Route                                              Route
	Evidence                                           string
	ParserRevision                                     int   `json:",omitempty"`
	ModelEnum                                          int64 `json:",omitempty"`
	// Unproven marks a counter conflict among snapshots that proved no route;
	// a later route proof decides it (see store.mergeNative).
	Unproven bool `json:",omitempty"`
}

func Hash(parts ...string) string {
	h := sha256.New()
	for _, s := range parts {
		h.Write([]byte(s))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

var modelName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,159}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (e Event) Valid() bool {
	if !digest.MatchString(e.ID) || !modelName.MatchString(e.Model) || e.At <= 0 {
		return false
	}
	switch e.Client {
	case "claude", "codex", "antigravity":
	default:
		return false
	}
	switch e.Provider {
	case "anthropic", "openai", "antigravity":
	default:
		return false
	}
	switch e.PriceProvider {
	case "anthropic", "openai", "google", "antigravity":
	default:
		return false
	}
	for _, n := range []int64{e.Input, e.Output, e.CacheRead, e.CacheWrite, e.CacheWrite1h} {
		if n < 0 || n > MaxTokens {
			return false
		}
	}
	return e.CacheRead+e.CacheWrite <= e.Input && e.CacheWrite1h <= e.CacheWrite && e.Input+e.Output > 0 &&
		(e.Route == Direct || e.Route == Proxy || e.Route == Unknown || e.Route == Conflict)
}

func Model(s string) string {
	if modelName.MatchString(s) {
		return s
	}
	return "unknown"
}

func PriceProvider(model string) string {
	switch {
	case strings.HasPrefix(model, "claude-"):
		return "anthropic"
	case strings.HasPrefix(model, "gemini-"):
		return "google"
	default:
		return "antigravity"
	}
}
