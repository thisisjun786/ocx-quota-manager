package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"
)

// CatalogSource names the public model price catalog (models.dev format). A
// row priced from it is stored with basis local-catalog: it is a reference
// rate, weaker than a provider's own price page, and it is only consulted when
// the source-owned table has no quote for that exact provider and model.
const CatalogSource = "https://models.dev"

type catalogRates [4]*float64

type catalogRow struct {
	base    catalogRates
	context []catalogTier
}

type catalogTier struct {
	size  float64
	rates catalogRates
}

// Catalog is an immutable parsed price catalog keyed by provider and model.
type Catalog struct {
	rows map[string]catalogRow
}

func validRate(v any) (*float64, bool) {
	if v == nil {
		return nil, true
	}
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 1e6 {
		return nil, false
	}
	return &f, true
}

func catalogTuple(raw any) (catalogRates, bool) {
	var out catalogRates
	m, ok := raw.(map[string]any)
	if !ok {
		return out, false
	}
	for k := range m {
		switch k {
		case "input", "output", "cache_read", "cache_write", "tiers", "context_over_200k", "tier",
			"reasoning", "input_audio", "output_audio":
		default:
			return out, false
		}
	}
	for i, key := range []string{"input", "output", "cache_read", "cache_write"} {
		v, ok := validRate(m[key])
		if !ok {
			return out, false
		}
		out[i] = v
	}
	if out[0] == nil || out[1] == nil || *out[0]+*out[1] <= 0 {
		return out, false
	}
	return out, true
}

// ParseCatalog reads a models.dev api.json document. Rows that cannot be read
// completely are skipped rather than guessed; an unreadable document is an error.
func ParseCatalog(raw []byte) (*Catalog, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	c := &Catalog{rows: map[string]catalogRow{}}
	for provider, p := range doc {
		pm, ok := p.(map[string]any)
		if !ok || strings.Contains(provider, "\x00") {
			continue
		}
		models, ok := pm["models"].(map[string]any)
		if !ok {
			continue
		}
		for id, m := range models {
			mm, ok := m.(map[string]any)
			if !ok || strings.Contains(id, "\x00") {
				continue
			}
			if declared, ok := mm["id"].(string); ok && declared != id {
				continue
			}
			cost, ok := mm["cost"].(map[string]any)
			if !ok {
				continue
			}
			base, ok := catalogTuple(cost)
			if !ok {
				continue
			}
			tiers, hasTiers := cost["tiers"]
			if !hasTiers || tiers == nil {
				if over, ok := cost["context_over_200k"]; ok && over != nil {
					tiers = []any{map[string]any{"tier": map[string]any{"type": "context", "size": 200000.0}, "over": over}}
				}
			}
			row := catalogRow{base: base}
			valid := true
			if list, ok := tiers.([]any); ok {
				seen := map[float64]bool{}
				for _, t := range list {
					tm, _ := t.(map[string]any)
					tier, _ := tm["tier"].(map[string]any)
					size, _ := tier["size"].(float64)
					if tier == nil || tier["type"] != "context" || size <= 0 || seen[size] {
						valid = false
						break
					}
					src := any(tm)
					if over, ok := tm["over"]; ok {
						src = over
					} else {
						cp := map[string]any{}
						for k, v := range tm {
							if k != "tier" {
								cp[k] = v
							}
						}
						src = cp
					}
					rates, ok := catalogTuple(src)
					if !ok {
						valid = false
						break
					}
					seen[size] = true
					row.context = append(row.context, catalogTier{size: size, rates: rates})
				}
			} else if tiers != nil {
				valid = false
			}
			if !valid {
				continue
			}
			sort.Slice(row.context, func(i, j int) bool { return row.context[i].size < row.context[j].size })
			c.rows[provider+"\x00"+id] = row
		}
	}
	if len(c.rows) == 0 {
		return nil, errors.New("catalog has no priced models")
	}
	return c, nil
}

// Lookup returns the rates for input tokens on that exact provider and model.
func (c *Catalog) Lookup(provider, model string, input float64) (catalogRates, bool) {
	if c == nil {
		return catalogRates{}, false
	}
	row, ok := c.rows[provider+"\x00"+model]
	if !ok {
		return catalogRates{}, false
	}
	rates := row.base
	for _, t := range row.context {
		if input > t.size {
			rates = t.rates
		}
	}
	return rates, true
}

// Revision identifies the rates the catalog would apply to the given pairs, so
// a catalog update that changes nothing we use does not trigger a replay.
func (c *Catalog) Revision(pairs [][2]string) string {
	h := sha256.New()
	sorted := append([][2]string(nil), pairs...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i][0] != sorted[j][0] {
			return sorted[i][0] < sorted[j][0]
		}
		return sorted[i][1] < sorted[j][1]
	})
	for _, p := range sorted {
		row, ok := c.rows[p[0]+"\x00"+p[1]]
		if !ok {
			continue
		}
		b, _ := json.Marshal([]any{p[0], p[1], row.base, tiersOf(row)})
		h.Write(b)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func tiersOf(r catalogRow) [][]any {
	out := [][]any{}
	for _, t := range r.context {
		out = append(out, []any{t.size, t.rates})
	}
	return out
}

func (c *Catalog) evidence(provider, model string, input float64) (Evidence, bool) {
	rates, ok := c.Lookup(provider, model, input)
	if !ok {
		return Evidence{}, false
	}
	src := CatalogSource
	return Evidence{Provider: provider, Model: model, Status: "local-catalog", SourceURL: &src, Rates: rates, Conditions: []string{}, Unsupported: []string{}}, true
}

// SetCatalog installs the catalog used for models the source-owned table does
// not price. nil removes it.
func (h *History) SetCatalog(c *Catalog) {
	h.cacheMu.Lock()
	h.catalog = c
	h.catalogRev = ""
	h.cacheMu.Unlock()
}

// catalogForIngest returns the catalog and a revision over the rates it gives
// the models in history, so a catalog update that changes nothing we use does
// not trigger a replay.
func (h *History) catalogForIngest() (*Catalog, string) {
	h.cacheMu.Lock()
	c, rev := h.catalog, h.catalogRev
	h.cacheMu.Unlock()
	if c == nil {
		return nil, ""
	}
	// New models reaching history are priced by the ingest itself, so the
	// revision only changes when the catalog does; compute it once per catalog.
	if rev != "" {
		return c, rev
	}
	defer func() {
		h.cacheMu.Lock()
		if h.catalog == c {
			h.catalogRev = rev
		}
		h.cacheMu.Unlock()
	}()
	rows, err := h.db.Query(`SELECT DISTINCT provider, coalesce(model,'') FROM usage`)
	if err != nil {
		return c, ""
	}
	defer rows.Close()
	var pairs [][2]string
	for rows.Next() {
		var p [2]string
		if rows.Scan(&p[0], &p[1]) == nil {
			pairs = append(pairs, p)
		}
	}
	rev = c.Revision(pairs)
	return c, rev
}
