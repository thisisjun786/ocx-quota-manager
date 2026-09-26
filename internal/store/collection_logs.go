package store

import (
	"context"
	"fmt"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
)

const CollectionLogRetentionDays = 30

type CollectionLog struct {
	ID int64 `json:"id"`
	collect.Attempt
}

type CollectionLogQuery struct {
	Period   string
	Provider string
	Account  string
	Result   string
	Before   int64
	Now      int64
}

type CollectionLogSummary struct {
	Provider      string   `json:"provider"`
	Attempts      int64    `json:"attempts"`
	Successes     int64    `json:"successes"`
	RateLimited   int64    `json:"rateLimited"`
	SuccessRate   *float64 `json:"successRate"`
	RateLimitRate *float64 `json:"rateLimitRate"`
	LastSuccessAt *int64   `json:"lastSuccessAt"`
}

type CollectionLogAccount struct {
	Provider string `json:"provider"`
	Account  string `json:"account"`
}

type CollectionLogsPage struct {
	Period        string                 `json:"period"`
	From          int64                  `json:"from"`
	To            int64                  `json:"to"`
	RetentionDays int                    `json:"retentionDays"`
	Rows          []CollectionLog        `json:"rows"`
	Summary       []CollectionLogSummary `json:"summary"`
	Providers     []string               `json:"providers"`
	Accounts      []CollectionLogAccount `json:"accounts"`
	NextBefore    *int64                 `json:"nextBefore"`
}

func (h *History) InsertCollectionLog(a collect.Attempt) error {
	_, err := h.db.Exec(`INSERT INTO collection_logs (startedAt,provider,account,endpoint,result,httpStatus,durationMs,retryAfterMs,nextAttemptAt,failures) VALUES (?,?,?,?,?,?,?,?,?,?)`, a.StartedAt, a.Provider, a.Account, a.Endpoint, a.Result, a.HTTPStatus, a.DurationMs, a.RetryAfterMs, a.NextAttemptAt, a.Failures)
	return err
}

func (h *History) ListCollectionLogs(q CollectionLogQuery) (CollectionLogsPage, error) {
	if q.Period == "" {
		q.Period = "24h"
	}
	durations := map[string]int64{"1h": 3600000, "24h": 86400000, "7d": 7 * 86400000}
	duration, ok := durations[q.Period]
	if !ok || q.Before < 0 || (q.Result != "" && !collect.ValidResult(q.Result)) {
		return CollectionLogsPage{}, fmt.Errorf("invalid collection log filter")
	}
	from := q.Now - duration
	page := CollectionLogsPage{Period: q.Period, From: from, To: q.Now, RetentionDays: CollectionLogRetentionDays, Rows: []CollectionLog{}, Summary: []CollectionLogSummary{}, Providers: []string{}, Accounts: []CollectionLogAccount{}}
	// Keep the three reads consistent and bound waiting behind collector writes.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	base := "startedAt>=? AND startedAt<=?"
	args := []any{from, q.Now}
	if q.Provider != "" {
		base += " AND provider=?"
		args = append(args, q.Provider)
	}
	if q.Account != "" {
		base += " AND account=?"
		args = append(args, q.Account)
	}
	summary, err := tx.QueryContext(ctx, `SELECT provider,count(*),sum(CASE WHEN result='ok' THEN 1 ELSE 0 END),sum(CASE WHEN result='rate_limited' THEN 1 ELSE 0 END),max(CASE WHEN result='ok' THEN startedAt END) FROM collection_logs WHERE `+base+` GROUP BY provider ORDER BY provider`, args...)
	if err != nil {
		return page, err
	}
	for summary.Next() {
		var s CollectionLogSummary
		if err = summary.Scan(&s.Provider, &s.Attempts, &s.Successes, &s.RateLimited, &s.LastSuccessAt); err != nil {
			break
		}
		success, limited := 100*float64(s.Successes)/float64(s.Attempts), 100*float64(s.RateLimited)/float64(s.Attempts)
		s.SuccessRate, s.RateLimitRate = &success, &limited
		page.Summary = append(page.Summary, s)
	}
	if err == nil {
		err = summary.Err()
	}
	summary.Close()
	if err != nil {
		return page, err
	}
	// Filter choices depend on the period, not the current row filters.
	choices, err := tx.QueryContext(ctx, `SELECT DISTINCT provider,account FROM collection_logs WHERE startedAt>=? AND startedAt<=? ORDER BY provider,account`, from, q.Now)
	if err != nil {
		return page, err
	}
	seen := map[string]bool{}
	for choices.Next() {
		var a CollectionLogAccount
		if err = choices.Scan(&a.Provider, &a.Account); err != nil {
			break
		}
		if !seen[a.Provider] {
			page.Providers = append(page.Providers, a.Provider)
			seen[a.Provider] = true
		}
		page.Accounts = append(page.Accounts, a)
	}
	if err == nil {
		err = choices.Err()
	}
	choices.Close()
	if err != nil {
		return page, err
	}
	if q.Result != "" {
		base += " AND result=?"
		args = append(args, q.Result)
	}
	if q.Before > 0 {
		base += " AND id<?"
		args = append(args, q.Before)
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,startedAt,provider,account,endpoint,result,httpStatus,durationMs,retryAfterMs,nextAttemptAt,failures FROM collection_logs WHERE `+base+` ORDER BY id DESC LIMIT 101`, args...)
	if err != nil {
		return page, err
	}
	for rows.Next() {
		var r CollectionLog
		if err = rows.Scan(&r.ID, &r.StartedAt, &r.Provider, &r.Account, &r.Endpoint, &r.Result, &r.HTTPStatus, &r.DurationMs, &r.RetryAfterMs, &r.NextAttemptAt, &r.Failures); err != nil {
			break
		}
		page.Rows = append(page.Rows, r)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return page, err
	}
	if len(page.Rows) > 100 {
		page.Rows = page.Rows[:100]
		last := page.Rows[99].ID
		page.NextBefore = &last
	}
	return page, tx.Commit()
}

