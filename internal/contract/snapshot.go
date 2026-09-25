package contract

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"
)

// SchemaVersion is the only published snapshot version.
const SchemaVersion = 1

// Snapshot is the public schemaVersion 1 DTO. Optional fields use pointers so
// Go zero values cannot collapse null, omitted, and measured 0.
type Snapshot struct {
	SchemaVersion          int        `json:"schemaVersion"`
	ObservedAt             *string    `json:"observedAt,omitempty"`
	Source                 *string    `json:"source,omitempty"`
	RefreshIntervalSeconds *int       `json:"refreshIntervalSeconds,omitempty"`
	Warnings               []string   `json:"warnings,omitempty"`
	Providers              []Provider `json:"providers"`
	Analytics              any        `json:"analytics,omitempty"`
}

type Provider struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Enabled         bool      `json:"enabled"`
	DefaultModel    *string   `json:"defaultModel"`
	SupportedModels []string  `json:"supportedModels,omitempty"`
	Accounts        []Account `json:"accounts"`
	Analytics       any       `json:"analytics,omitempty"`
}

type Account struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Plan      *string  `json:"plan"`
	Status    string   `json:"status"`
	UpdatedAt *string  `json:"updatedAt"`
	Active    *bool    `json:"active,omitempty"`
	QuotaMode *string  `json:"quotaMode,omitempty"`
	Windows   []Window `json:"windows"`
	Analytics any      `json:"analytics,omitempty"`
	// Refresh and DirectQuota describe the last direct read of this account.
	Refresh     any `json:"refresh,omitempty"`
	DirectQuota any `json:"directQuota,omitempty"`
	Ollama      any `json:"ollama,omitempty"`
}

type Window struct {
	IdentityEpoch    *int64   `json:"-"`
	ID               string   `json:"id"`
	Label            string   `json:"label"`
	RemainingPercent *float64 `json:"remainingPercent"`
	Stale            *bool    `json:"stale,omitempty"`
	ResetAt          *string  `json:"resetAt"`
	UsageScope       *string  `json:"usageScope"`
	Analytics        any      `json:"analytics,omitempty"`
}

type RateCard struct {
	Input      *float64 `json:"input"`
	Output     *float64 `json:"output"`
	CacheRead  *float64 `json:"cacheRead"`
	CacheWrite *float64 `json:"cacheWrite"`
}

type ModelPrice struct {
	Model        string    `json:"model"`
	Status       string    `json:"status"`
	Unit         string    `json:"unit"`
	Rates        RateCard  `json:"rates"`
	SourceURL    *string   `json:"sourceUrl"`
	CheckedAt    *string   `json:"checkedAt"`
	EffectiveFrom *string  `json:"effectiveFrom"`
	EffectiveTo   *string  `json:"effectiveTo"`
	Conditions   []string  `json:"conditions"`
	Unsupported  []string  `json:"unsupported"`
	Conflict     any       `json:"conflict"`
	Reason       *string   `json:"reason"`
}

// MarshalCanonical encodes v the way JS JSON.stringify encodes arrays: no HTML
// escaping, insertion order for struct fields. Use this for digest vectors.
func MarshalCanonical(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	out := bytes.TrimRight(buf.Bytes(), "\n")
	return out, nil
}

func ValidateSnapshot(s Snapshot) error {
	if s.SchemaVersion != SchemaVersion {
		return fmt.Errorf("schemaVersion: want %d got %d", SchemaVersion, s.SchemaVersion)
	}
	if s.Providers == nil {
		return fmt.Errorf("providers: required")
	}
	for i, p := range s.Providers {
		if p.ID == "" {
			return fmt.Errorf("providers[%d].id: empty", i)
		}
		for j, a := range p.Accounts {
			if a.ID == "" {
				return fmt.Errorf("providers[%d].accounts[%d].id: empty", i, j)
			}
			if err := validateStatus(a.Status); err != nil {
				return fmt.Errorf("providers[%d].accounts[%d].status: %w", i, j, err)
			}
			for k, w := range a.Windows {
				if w.ID == "" {
					return fmt.Errorf("providers[%d].accounts[%d].windows[%d].id: empty", i, j, k)
				}
				if w.RemainingPercent != nil {
					if math.IsNaN(*w.RemainingPercent) || math.IsInf(*w.RemainingPercent, 0) {
						return fmt.Errorf("remainingPercent must be a finite number or null")
					}
				}
			}
		}
	}
	return nil
}

func validateStatus(status string) error {
	switch status {
	case "ok", "stale", "reauth", "paused", "unavailable", "collecting":
		return nil
	default:
		return fmt.Errorf("unknown %q", status)
	}
}

func DecodeSnapshot(raw []byte) (Snapshot, error) {
	var s Snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		return Snapshot{}, err
	}
	if err := ValidateSnapshot(s); err != nil {
		return Snapshot{}, err
	}
	return s, nil
}

func LoadCorpusFile(name string) ([]byte, error) {
	root, err := findContracts()
	if err != nil {
		return nil, err
	}
	return os.ReadFile(filepath.Join(root, "corpus", name))
}

func findContracts() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(dir, "contracts")
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("contracts directory not found from %s", dir)
}

func ParseISO(value string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, value)
}
