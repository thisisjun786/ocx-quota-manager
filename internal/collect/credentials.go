package collect

import (
	"strings"
	"time"
)

type BindingKind string

const (
	KindOAuth BindingKind = "oauth"
	KindKey   BindingKind = "key"
)

type FileState string

const (
	FileOK         FileState = "ok"
	FileMissing    FileState = "missing"
	FileUnreadable FileState = "unreadable"
	FileDisabled   FileState = "disabled"
	FileMalformed  FileState = "malformed"
	FileOversized  FileState = "oversized"
)

type Binding struct {
	Provider       string
	AccountID      string
	Kind           BindingKind
	Token          string // memory only; never persisted or projected
	AccountRef     *string
	Enabled        bool
	Source         string
	BaseStatus     string
	BaseURL        string
	AuthMode       string
	Organization   string
	ConfigProvider string
}

type Source struct {
	Bindings []Binding
	Files    map[string]FileState
}

type Reader struct {
	Home       string
	CodexHome  string
	ClaudeHome string
	ReadFile   func(string) ([]byte, error)
	MaxBytes   int
}

func (r Reader) Load() (Source, error) {
	local, err := r.LoadLocal(time.Now().UTC())
	if err != nil {
		return Source{}, err
	}
	return Source{Bindings: local.Bindings, Files: local.Files}, nil
}

func normalizeProvider(id string) string {
	switch id {
	case "chatgpt", "openai-multi":
		return "openai"
	default:
		return id
	}
}

func ParseDirectProviders(env string) []string {
	var out []string
	seen := map[string]bool{}
	for _, part := range strings.Split(env, ",") {
		id := strings.TrimSpace(part)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

var RegisteredDirect = []string{
	"openai", "anthropic", "cursor", "xai", "devin", "command-code", "opencode-go", "kimi",
}

func IsRegisteredDirect(id string) bool {
	for _, p := range RegisteredDirect {
		if p == id {
			return true
		}
	}
	return false
}

// SupportKind is the JUN-259 inventory: HTTPS readers stay "direct", Ollama
// stays estimate-only (local/model usage, no quota HTTPS), others stay out.
func SupportKind(id string) string {
	switch id {
	case "openai", "anthropic", "cursor", "xai", "devin", "command-code", "opencode-go", "kimi":
		return "direct"
	case "ollama":
		return "estimate"
	case "google":
		return "unsupported"
	default:
		return "unregistered"
	}
}
