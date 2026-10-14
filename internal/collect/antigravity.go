package collect

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"path/filepath"
	"runtime"
	"strings"
)

// Antigravity (agy) keeps its own Google login outside OCX and reads its quota
// from the Cloud Code backend with /usage. The monitor sends the same request
// with that login: retrieveUserQuotaSummary on the host agy itself talks to.
// The backend serves this account only to an Antigravity client, so the user
// agent names one; any other agent is refused as an unsupported client.
const (
	antigravityHost          = "daily-cloudcode-pa.googleapis.com"
	antigravityQuotaPath     = "/v1internal:retrieveUserQuotaSummary"
	antigravityClientVersion = "1.3.5"
)

var antigravityUserAgent = "antigravity/" + antigravityClientVersion + " " + runtime.GOOS + "/" + runtime.GOARCH

var antigravityCLI = LocalCLI{
	Provider: "antigravity", Source: "antigravityCLI", AccountID: "antigravity-cli", Label: "Antigravity CLI",
	Hint: "agy에 다시 로그인해 주세요.",
	Path: func(r Reader) string {
		if r.GeminiHome == "" {
			return ""
		}
		return filepath.Join(r.GeminiHome, "antigravity-cli", "antigravity-oauth-token")
	},
	Parse: parseAntigravityLogin,
}

// parseAntigravityLogin reads agy's oauth2 token file: the access token, and
// the Google account id (the id token's subject) as the stable reference. The
// id token is only decoded, never verified: it names which account the local
// file belongs to and grants nothing.
func parseAntigravityLogin(file map[string]any) (LocalLogin, bool) {
	tok := obj(file["token"])
	access := strings.TrimSpace(secretText(tok["access_token"]))
	if access == "" {
		return LocalLogin{}, false
	}
	login := LocalLogin{Token: access}
	if sub := jwtSubject(secretText(file["id_token"])); sub != "" {
		login.AccountRef = &sub
	}
	return login, true
}

func jwtSubject(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	return text(claims["sub"])
}

// Antigravity buckets come in model groups (Gemini; Claude and GPT), each with
// its own five-hour and weekly limit. The group is the window's scope and part
// of its id, so the four limits stay four series: gemini-five-hour,
// gemini-weekly, 3p-five-hour, 3p-weekly.
var antigravityPeriods = map[string][2]string{
	"5h": {fiveHourID, fiveHourLabel}, "weekly": {weeklyID, weeklyLabel},
}

func parseAntigravity(body []byte, now int64) ([]Reading, error) {
	m, err := parseObject(body)
	if err != nil {
		return parserResult(nil, err, "antigravity", "quota-summary", now)
	}
	var rows []Reading
	add := func(groupName string, buckets []any) {
		var five, other []Reading
		for _, raw := range buckets {
			r := antigravityBucket(obj(raw), groupName, now)
			if r == nil {
				continue
			}
			if strings.HasSuffix(r.WindowID, "-"+fiveHourID) {
				five = append(five, *r)
			} else {
				other = append(other, *r)
			}
		}
		rows = append(append(rows, five...), other...)
	}
	for _, raw := range arr(m["groups"]) {
		g := obj(raw)
		name, _ := str(g["displayName"])
		add(name, arr(g["buckets"]))
	}
	add("", arr(m["buckets"]))
	return parserResult(rows, nil, "antigravity", "quota-summary", now)
}

func antigravityBucket(b map[string]any, groupName string, now int64) *Reading {
	if b == nil {
		return nil
	}
	if disabled, _ := b["disabled"].(bool); disabled {
		return nil
	}
	window, _ := str(b["window"])
	id, _ := str(b["bucketId"])
	// A bucket that reports an amount instead of a fraction names no limit to
	// take a percentage of.
	fraction := num(b["remainingFraction"])
	if window == "" || fraction == nil || math.IsNaN(*fraction) || *fraction < 0 || *fraction > 1.000001 {
		return nil
	}
	f := math.Min(1, *fraction)
	scope := strings.TrimSuffix(id, "-"+window)
	if scope == id || scope == "" {
		scope = strings.TrimPrefix(scopedWindowID(groupName), "custom-")
	}
	if scope == "" {
		return nil
	}
	period, ok := antigravityPeriods[window]
	if !ok {
		slug := strings.TrimPrefix(scopedWindowID(window), "custom-")
		if slug == "" {
			return nil
		}
		period = [2]string{slug, window}
	}
	label := period[1]
	if groupName != "" {
		label = groupName + " " + label
	}
	used, remaining := (1-f)*100, f*100
	r := &Reading{Provider: "antigravity", Endpoint: "quota-summary", WindowID: scope + "-" + period[0], Label: label,
		Scope: scope, UsedPercent: &used, RemainingPercent: &remaining, Kind: WindowOK, ObservedAt: now}
	// An untouched bucket reports a reset one window from now, moving with
	// every read; only a started window has a fixed reset to key a cycle on.
	if f < 1 {
		r.ResetAt = instant(b["resetTime"])
	}
	return r
}
