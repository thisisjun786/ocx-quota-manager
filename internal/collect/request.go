package collect

import (
	"encoding/json"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var accountHeader = regexp.MustCompile(`^[A-Za-z0-9._~@|:+-]{1,200}$`)

func allowedCredential(b Binding) bool {
	if !b.Enabled || b.Token == "" {
		return false
	}
	if b.Provider == "kimi" {
		if b.Kind == KindKey && (strings.HasPrefix(strings.TrimSpace(b.Token), "$") || strings.HasPrefix(strings.TrimSpace(b.Token), "keychain:")) {
			return false
		}
		// Require the configured Code endpoint even for a default-labelled base.
		u, err := url.Parse(b.BaseURL)
		if err != nil || u.Scheme != "https" || u.Host != "api.kimi.com" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || strings.TrimRight(u.Path, "/") != "/coding/v1" {
			return false
		}
		if b.BaseStatus != "default" && b.BaseStatus != "custom" {
			return false
		}
		return (b.AuthMode == "oauth" && b.Kind == KindOAuth) || ((b.AuthMode == "" || b.AuthMode == "key") && b.Kind == KindKey)
	}
	if b.Provider == "ollama-cloud" || b.Provider == "opencode-go" {
		if b.Kind != KindKey {
			return false
		}
	} else if b.Provider != "command-code" && b.Kind != KindOAuth {
		return false
	}
	if b.Provider == "command-code" {
		if b.Organization != "" {
			return false
		}
		if (b.AuthMode == "oauth") != (b.Kind == KindOAuth) {
			return false
		}
	}
	if b.BaseStatus == "native" {
		return true
	}
	if b.BaseStatus != "default" && b.BaseStatus != "custom" {
		return false
	}
	if b.BaseStatus == "default" {
		return true
	}
	u, err := url.Parse(b.BaseURL)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	host := map[string]string{"openai": "chatgpt.com", "anthropic": "api.anthropic.com", "cursor": "api2.cursor.sh", "xai": "api.x.ai", "devin": "server.codeium.com", "command-code": "api.commandcode.ai", "opencode-go": "opencode.ai", "ollama-cloud": "ollama.com"}[b.Provider]
	if u.Scheme != "https" || u.Host != host {
		return false
	}
	path := strings.TrimRight(u.Path, "/")
	if b.Provider == "opencode-go" && path != "/zen/go/v1" {
		return false
	}
	if b.Provider == "command-code" && path != "" {
		return false
	}
	if b.Provider == "ollama-cloud" && path != "" && path != "/api" && path != "/v1" {
		return false
	}
	return true
}
func quotaRequest(b Binding, ad Adapter) (transport.Request, bool) {
	req := transport.Request{Host: ad.Host(), Path: ad.Path(), Method: ad.Method(), Timeout: 8 * time.Second, Headers: map[string]string{"Accept": "application/json", "Authorization": "Bearer " + b.Token}}
	if !allowedCredential(b) {
		return req, false
	}
	switch b.Provider {
	case "openai":
		if b.AccountRef == nil || !accountHeader.MatchString(*b.AccountRef) {
			return req, false
		}
		req.Headers["ChatGPT-Account-Id"] = *b.AccountRef
	case "anthropic":
		req.Headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05"
		req.Headers["User-Agent"] = "claude-cli/2.1.63 (external, cli)"
	case "cursor":
		req.Headers["Content-Type"] = "application/json"
		req.Headers["Connect-Protocol-Version"] = "1"
		req.Body = []byte("{}")
	case "devin":
		delete(req.Headers, "Authorization")
		req.Headers["Content-Type"] = "application/json"
		req.Headers["Connect-Protocol-Version"] = "1"
		req.Body, _ = json.Marshal(map[string]any{"metadata": map[string]any{"apiKey": b.Token, "ideName": "windsurf", "ideVersion": "0.0.0", "extensionName": "windsurf", "extensionVersion": "1.0.0"}})
	case "xai":
		if ad.EndpointID() == "grok-credits" {
			if b.AccountRef == nil || !accountHeader.MatchString(*b.AccountRef) {
				return req, false
			}
			req.Headers["x-userid"] = *b.AccountRef
			req.Headers["x-xai-token-auth"] = "xai-grok-cli"
			req.Headers["x-authenticateresponse"] = "authenticate-response"
			req.Headers["x-grok-client-version"] = "0.2.93"
		}
	}
	return req, true
}
