package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var logLabelPattern = regexp.MustCompile(`^(main|[pko][a-f0-9]{6})$`)

// Matches src/identity.mjs: a log label proves a roster ID; a current selection
// or a sole account does not. Ambiguous and unrecognized labels remain unknown.
func usageIdentities(home string) map[string]*string {
	labels := map[string]*string{}
	add := func(provider, label, id string) {
		if id == "" || !logLabelPattern.MatchString(label) {
			return
		}
		key := usageProvider(provider) + "\x00" + label
		if prior, ok := labels[key]; ok && (prior == nil || *prior != id) {
			labels[key] = nil
		} else {
			v := id
			labels[key] = &v
		}
	}
	hash := func(s string) string { d := sha256.Sum256([]byte(s)); return hex.EncodeToString(d[:])[:6] }
	add("openai", "main", "__main__")
	var config struct {
		Accounts []struct {
			ID    string `json:"id"`
			Label string `json:"logLabel"`
		} `json:"codexAccounts"`
	}
	if raw, err := os.ReadFile(filepath.Join(home, "config.json")); err == nil && json.Unmarshal(raw, &config) == nil {
		for _, a := range config.Accounts {
			label := a.Label
			if !regexp.MustCompile(`^p[a-f0-9]{6}$`).MatchString(label) {
				label = "p" + hash(a.ID)
			}
			add("openai", label, a.ID)
		}
	}
	var auth map[string]struct {
		Accounts []struct {
			ID string `json:"id"`
		} `json:"accounts"`
	}
	if raw, err := os.ReadFile(filepath.Join(home, "auth.json")); err == nil && json.Unmarshal(raw, &auth) == nil {
		for provider, set := range auth {
			for _, a := range set.Accounts {
				label := "o" + hash(provider+"\x00"+a.ID)
				if provider == "anthropic" {
					label = "p" + hash(a.ID)
				}
				add(provider, label, a.ID)
			}
		}
	}
	return labels
}
func attributedAccount(rawProvider string, row map[string]any, labels map[string]*string) *string {
	label, _ := row["accountLogLabel"].(string)
	provider := usageProvider(rawProvider)
	if label == "" && provider != rawProvider {
		if i := strings.LastIndex(rawProvider, "-"); i >= 0 {
			label = rawProvider[i+1:]
		}
	}
	if !logLabelPattern.MatchString(label) {
		return nil
	}
	return labels[provider+"\x00"+label]
}
