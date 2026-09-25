package store

import (
	"context"
	"time"
)

// Store is the history seam. The SQLite implementation is JUN-261.
// Callers must not open a second writer on the same file.
type Store interface {
	Meta(key string) (any, bool)
	SetMeta(key string, value any) error
	InsertUsage(row Usage) error
	InsertObservation(row Observation) error
	InsertSample(row Sample) error
	Close() error
}

type Usage struct {
	ID                    string
	At                    int64
	Provider              string
	Account               *string
	Model                 *string
	Input                 *float64
	Output                *float64
	Cached                *float64
	Tokens                *float64
	USD                   *float64
	Basis                 *string
	CacheEstimated        bool
	EstimatedCachedTokens float64
	NoCacheUSD            *float64
}

type Observation struct {
	Provider          string
	Account           string
	Window            string
	At                int64
	Epoch             *int64
	Basis             string
	ReportedPercent   *float64
	CalculatedPercent *float64
	ObservedPercent   float64
	Used              *float64
	LimitValue        *float64
	LimitState        string
	Unit              *string
	Method            *string
	WindowSemantics   string
	ScopeKey          *string
	CycleKey          *string
	Reset             *int64
	Source            *string
	SourceVersion     *string
	PrecisionEvidence string
	ResolutionPp      *float64
	Reconciliation    string
	UsedAccumulation  string
	PairsSample       int
}

type Sample struct {
	Provider string
	Account  string
	Window   string
	At       int64
	Reset    *int64
	Used     *float64
}

type Binding struct {
	Provider string
	Account  string
	Epoch    int64
}

// Context with a deadline is required on every write path so a stuck disk
// cannot pin the HTTP thread. HTTP itself must never call Store.
type WriteOptions struct {
	Ctx context.Context
	Now time.Time
}
