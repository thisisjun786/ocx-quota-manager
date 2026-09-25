package runtime

import (
	"fmt"
	"sort"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

const cacheReferenceInterval = 5 * time.Minute

type cacheReferenceProvider struct {
	Provider          string  `json:"provider"`
	Requests          int     `json:"requests"`
	InputTokens       float64 `json:"inputTokens"`
	CachedInputTokens float64 `json:"cachedInputTokens"`
}

type cacheReference struct {
	Basis                      string                   `json:"basis"`
	AppliedRate                *float64                 `json:"appliedRate"`
	ObservedRate               *float64                 `json:"observedRate"`
	ReferenceInputTokens       float64                  `json:"referenceInputTokens"`
	ReferenceCachedInputTokens float64                  `json:"referenceCachedInputTokens"`
	Providers                  []cacheReferenceProvider `json:"providers"`
	From                       string                   `json:"from"`
	Through                    string                   `json:"through"`
	UpdatedAt                  int64                    `json:"updatedAt"`
	InvalidLines               int                      `json:"invalidLines"`
}

// The log has already been parsed by ingest; only measured input and cache-read
// tokens qualify. Unknown cache is not a measured zero.
func calculateCacheReference(rows []store.Usage, now time.Time) cacheReference {
	from := now.Add(-30 * 24 * time.Hour)
	byProvider := map[string]*cacheReferenceProvider{}
	for _, row := range rows {
		if row.Provider == "cursor" || row.Provider == "ollama-cloud" || row.Provider == "unknown" || row.At <= from.UnixMilli() || row.At > now.UnixMilli() || row.Input == nil || row.Cached == nil || *row.Input <= 0 || *row.Cached < 0 || *row.Cached > *row.Input {
			continue
		}
		p := byProvider[row.Provider]
		if p == nil {
			p = &cacheReferenceProvider{Provider: row.Provider}
			byProvider[row.Provider] = p
		}
		p.Requests++
		p.InputTokens += *row.Input
		p.CachedInputTokens += *row.Cached
	}
	ref := cacheReference{Basis: "other-providers-token-weighted", Providers: []cacheReferenceProvider{}, From: from.UTC().Format(time.RFC3339Nano), Through: now.UTC().Format(time.RFC3339Nano), UpdatedAt: now.UnixMilli()}
	for _, p := range byProvider {
		ref.Providers = append(ref.Providers, *p)
		ref.ReferenceInputTokens += p.InputTokens
		ref.ReferenceCachedInputTokens += p.CachedInputTokens
	}
	sort.Slice(ref.Providers, func(i, j int) bool { return ref.Providers[i].InputTokens > ref.Providers[j].InputTokens })
	if ref.ReferenceInputTokens > 0 {
		rate := ref.ReferenceCachedInputTokens / ref.ReferenceInputTokens
		ref.AppliedRate = &rate
		ref.ObservedRate = &rate
	}
	return ref
}

func updateCacheReference(hist usageStore, now time.Time) error {
	if hist == nil {
		return nil
	}
	if raw, ok := hist.Meta("cursorCacheReference"); ok {
		if m, ok := raw.(map[string]any); ok {
			if updated, ok := m["updatedAt"].(float64); ok && now.UnixMilli()-int64(updated) < cacheReferenceInterval.Milliseconds() && now.UnixMilli() >= int64(updated) {
				return nil
			}
		}
	}
	rows, err := hist.ListUsage()
	if err != nil {
		return fmt.Errorf("read cache reference usage: %w", err)
	}
	writer, ok := hist.(interface{ SetMeta(string, any) error })
	if !ok {
		return nil
	}
	if err := writer.SetMeta("cursorCacheReference", calculateCacheReference(rows, now)); err != nil {
		return fmt.Errorf("save cache reference: %w", err)
	}
	return nil
}

func attachCacheAssumption(providers []contract.Provider, hist usageStore, now time.Time, failed bool) {
	for i := range providers {
		if providers[i].ID != "cursor" {
			continue
		}
		assumption := map[string]any{"appliedRate": nil, "stale": false}
		if hist != nil {
			if raw, ok := hist.Meta("cursorCacheReference"); ok {
				if m, ok := raw.(map[string]any); ok {
					for key, value := range m {
						assumption[key] = value
					}
					updated, _ := m["updatedAt"].(float64)
					assumption["stale"] = failed || now.UnixMilli()-int64(updated) > (15*time.Minute).Milliseconds()
				}
			}
		}
		providers[i].Analytics.(map[string]any)["cacheAssumption"] = assumption
	}
}
