package nativeusage

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const (
	agMaxBlob     = 1 << 20
	agMaxBytes    = 32 << 20
	agMaxRows     = 50000
	agReadTimeout = 5 * time.Second
)

type agGeneration struct {
	index           int64
	response, label string
	event           Event
}
type agStep struct {
	at       int64
	response string
}
type agTimes struct {
	responses map[string]int64
	indices   map[int64]agStep
}
type agBudget struct {
	rows  int64
	bytes int64
}

// ReadAntigravity reads a consistent, bounded snapshot of generation metadata.
// mode=ro deliberately keeps WAL visibility; immutable would miss live generations.
func ReadAntigravity(ctx context.Context, path string) ([]Event, error) {
	events, _, err := ReadAntigravityWithDiagnostics(ctx, path)
	return events, err
}

// ReadAntigravityWithDiagnostics additionally counts unresolved or unsupported
// generation rows. Duplicate valid responses are not counted as invalid rows.
func ReadAntigravityWithDiagnostics(ctx context.Context, path string) ([]Event, int, error) {
	ctx, cancel := context.WithTimeout(ctx, agReadTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, 0, err
	}
	uri := url.URL{Scheme: "file", Path: absolute, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, 0, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	budget := &agBudget{}
	if err = agCheckBudget(ctx, tx, "gen_metadata", "data", "", budget); err != nil {
		return nil, 0, err
	}
	generations, err := agReadGenerations(ctx, tx)
	if err != nil {
		return nil, 0, err
	}
	times, err := agReadSteps(ctx, tx, budget)
	if err != nil {
		return nil, 0, err
	}
	events, invalid := agEvents(generations, times)
	if len(generations) > 0 && len(events) == 0 {
		return nil, invalid, fmt.Errorf("antigravity: unsupported metadata: no generation with usage, response ID and genuine time")
	}
	if err = ctx.Err(); err != nil {
		return nil, 0, err
	}
	if err = tx.Commit(); err != nil {
		return nil, 0, err
	}
	return events, invalid, nil
}

func agCheckBudget(ctx context.Context, tx *sql.Tx, table, column, where string, budget *agBudget) error {
	// Identifiers are internal constants, never supplied by the source database.
	var count, bytes, maximum int64
	query := "SELECT count(*), coalesce(sum(length(" + column + ")),0), coalesce(max(length(" + column + ")),0) FROM " + table + where
	if err := tx.QueryRowContext(ctx, query).Scan(&count, &bytes, &maximum); err != nil {
		return fmt.Errorf("antigravity: unsupported %s metadata: %w", table, err)
	}
	budget.rows += count
	budget.bytes += bytes
	if maximum > agMaxBlob || budget.rows > agMaxRows || budget.bytes > agMaxBytes {
		return fmt.Errorf("antigravity: metadata exceeds read limits")
	}
	return nil
}

func agReadGenerations(ctx context.Context, tx *sql.Tx) ([]agGeneration, error) {
	rows, err := tx.QueryContext(ctx, "SELECT idx, data FROM gen_metadata ORDER BY idx")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var generations []agGeneration
	for rows.Next() {
		var idx int64
		var blob []byte
		if err := rows.Scan(&idx, &blob); err != nil {
			return nil, err
		}
		generation, err := agParseGeneration(idx, blob)
		if err != nil {
			return nil, fmt.Errorf("antigravity: generation %d: %w", idx, err)
		}
		generations = append(generations, generation)
	}
	return generations, rows.Err()
}

func agParseGeneration(idx int64, blob []byte) (agGeneration, error) {
	g := agGeneration{index: idx}
	top, err := agDecode(blob)
	if err != nil {
		return g, err
	}
	chat, err := top.message(1)
	if err != nil {
		return g, err
	}
	usage, err := chat.message(4)
	if err != nil {
		return g, err
	}
	g.response, err = usage.text(11)
	if err != nil {
		return g, err
	}
	g.label, err = chat.text(21)
	if err != nil {
		return g, err
	}
	rawModel, err := chat.text(19)
	if err != nil {
		return g, err
	}
	g.event = Event{Client: "antigravity", Provider: "antigravity", Model: Model(rawModel), Route: Direct, Evidence: "antigravity-generation"}
	g.event.Input, err = agTokenSum(usage, 1, 2, 5)
	if err != nil {
		return g, err
	}
	g.event.CacheRead, err = agTokenSum(usage, 5)
	if err != nil {
		return g, err
	}
	g.event.Output, err = agTokenSum(usage, 9, 10)
	if err != nil {
		return g, err
	}
	gen, err := chat.message(9)
	if err != nil {
		return g, err
	}
	stamp, err := gen.message(4)
	if err != nil {
		return g, err
	}
	g.event.At, err = agTimestamp(stamp)
	return g, err
}

func agReadSteps(ctx context.Context, tx *sql.Tx, budget *agBudget) (agTimes, error) {
	times := agTimes{responses: make(map[string]int64), indices: make(map[int64]agStep)}
	var exists int
	err := tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='steps'").Scan(&exists)
	if err != nil || exists == 0 {
		return times, err
	}
	const where = " WHERE step_type = 15 AND metadata IS NOT NULL"
	if err := agCheckBudget(ctx, tx, "steps", "metadata", where, budget); err != nil {
		return times, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT metadata FROM steps"+where)
	if err != nil {
		return times, err
	}
	defer rows.Close()
	for rows.Next() {
		var blob []byte
		if err := rows.Scan(&blob); err != nil {
			return times, err
		}
		if err := agAddStep(blob, &times); err != nil {
			return times, err
		}
	}
	return times, rows.Err()
}

func agAddStep(blob []byte, times *agTimes) error {
	metadata, err := agDecode(blob)
	if err != nil {
		return err
	}
	stamp, err := metadata.message(1)
	if err != nil {
		return err
	}
	at, err := agTimestamp(stamp)
	if err != nil {
		return err
	}
	usage, err := metadata.message(9)
	if err != nil {
		return err
	}
	response, err := usage.text(11)
	if err != nil {
		return err
	}
	gen, err := metadata.message(20)
	if err != nil {
		return err
	}
	index, err := gen.integer(3)
	if err != nil {
		return err
	}
	if index > uint64(^uint64(0)>>1) {
		return fmt.Errorf("antigravity: generation index overflow")
	}
	if at == 0 {
		return nil
	}
	if response != "" {
		if old, ok := times.responses[response]; ok && old != at {
			return fmt.Errorf("antigravity: ambiguous response timestamp")
		}
		times.responses[response] = at
	}
	if _, ok := gen[3]; ok {
		step := agStep{at: at, response: response}
		if old, ok := times.indices[int64(index)]; ok && old != step {
			return fmt.Errorf("antigravity: ambiguous generation timestamp")
		}
		times.indices[int64(index)] = step
	}
	return nil
}

func agEvents(generations []agGeneration, times agTimes) ([]Event, int) {
	// Label recovery is confined to this database (one conversation), never a
	// global display-label mapping. A label naming multiple models is ambiguous.
	models := make(map[string]string)
	for _, g := range generations {
		if g.label == "" || g.event.Model == "unknown" {
			continue
		}
		if old, ok := models[g.label]; ok && old != g.event.Model {
			models[g.label] = ""
		} else if !ok {
			models[g.label] = g.event.Model
		}
	}
	// Only identical observations collapse here. Differing observations with
	// the same response ID must reach ledger dominance/conflict resolution.
	seen := make(map[Event]bool)
	var events []Event
	invalid := 0
	for _, g := range generations {
		if strings.TrimSpace(g.response) == "" {
			invalid++
			continue
		}
		e := g.event
		if e.At == 0 {
			e.At = times.responses[g.response]
		}
		if e.At == 0 {
			step := times.indices[g.index]
			if step.response == "" || step.response == g.response {
				e.At = step.at
			}
		}
		if e.Model == "unknown" {
			e.Model = Model(models[g.label])
		}
		e.PriceProvider = PriceProvider(e.Model)
		e.ID = Hash("native-v1", "antigravity", g.response)
		if !e.Valid() {
			invalid++
			continue
		}
		if !seen[e] {
			events = append(events, e)
			seen[e] = true
		}
	}
	return events, invalid
}
