package store

import (
	"encoding/json"
	"sort"
)

// OllamaWindow is one window of one Ollama Cloud usage reading, in the shape
// the Node collector stored (so rows written before the Go port stay readable).
type OllamaWindow struct {
	Used     float64          `json:"used"`
	Fraction *float64         `json:"fraction,omitempty"`
	Models   map[string]int64 `json:"models"`
}

type OllamaObservation struct {
	At     int64
	Limits map[string]OllamaWindow
}

// InsertOllamaObservation keeps one reading's per-model request counters.
func (h *History) InsertOllamaObservation(source string, at int64, limits map[string]OllamaWindow) error {
	raw, err := json.Marshal(limits)
	if err != nil {
		return err
	}
	_, err = h.db.Exec("INSERT OR IGNORE INTO ollama_observations VALUES (?,?,?)", source, at, string(raw))
	return err
}

// ListOllamaObservations returns readings at or after from, oldest first.
func (h *History) ListOllamaObservations(source string, from int64) ([]OllamaObservation, error) {
	rows, err := h.db.Query("SELECT at, payload FROM ollama_observations WHERE source=? AND at>=? ORDER BY at", source, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OllamaObservation
	for rows.Next() {
		var at int64
		var payload string
		if err := rows.Scan(&at, &payload); err != nil {
			return nil, err
		}
		var limits map[string]OllamaWindow
		if json.Unmarshal([]byte(payload), &limits) != nil {
			continue
		}
		out = append(out, OllamaObservation{At: at, Limits: limits})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At < out[j].At })
	return out, rows.Err()
}
