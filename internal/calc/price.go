package calc

// PriceOrigin separates a stored confirmed amount from an estimate.
const (
	OriginStored    = "stored"
	OriginOfficial  = "official"
	OriginReference = "reference"
	OriginUnknown   = "unknown"
	OriginEstimate  = "estimate"
)

type UsageLine struct {
	Model        string
	InputTokens  float64
	OutputTokens float64
	CacheRead    float64
	CacheWrite   float64
	At           int64
	StoredUSD    *float64
	CacheGuess   bool
}

type AppliedPrice struct {
	USD          *float64
	Origin       string
	Model        string
	EffectiveAt  int64
	CacheGuess   bool
	Priced       bool
	UnknownPrice bool
}

type StoredRate struct {
	Model         string
	Canonical     string
	Origin        string
	Input         *float64
	Output        *float64
	CacheRead     *float64
	CacheWrite    *float64
	EffectiveFrom int64
	EffectiveTo   *int64
}

// ApplyPrice never rewrites a stored confirmed USD. Missing rates stay
// unknown; they are not filled with today's catalog.
func ApplyPrice(line UsageLine, rates []StoredRate) AppliedPrice {
	out := AppliedPrice{Model: line.Model, CacheGuess: line.CacheGuess, EffectiveAt: line.At}
	if line.StoredUSD != nil {
		v := *line.StoredUSD
		out.USD = &v
		out.Origin = OriginStored
		out.Priced = true
		return out
	}
	var match *StoredRate
	for i := range rates {
		r := &rates[i]
		if r.Model != line.Model && r.Canonical != line.Model {
			continue
		}
		if line.At < r.EffectiveFrom {
			continue
		}
		if r.EffectiveTo != nil && line.At >= *r.EffectiveTo {
			continue
		}
		match = r
		break
	}
	if match == nil || match.Input == nil || match.Output == nil {
		out.Origin = OriginUnknown
		out.UnknownPrice = true
		return out
	}
	usd := 0.0
	if match.Input != nil {
		usd += line.InputTokens / 1e6 * *match.Input
	}
	if match.Output != nil {
		usd += line.OutputTokens / 1e6 * *match.Output
	}
	if match.CacheRead != nil {
		usd += line.CacheRead / 1e6 * *match.CacheRead
	} else if line.CacheRead > 0 {
		out.CacheGuess = true
	}
	if match.CacheWrite != nil {
		usd += line.CacheWrite / 1e6 * *match.CacheWrite
	}
	out.USD = &usd
	out.Origin = match.Origin
	if out.Origin == "" {
		out.Origin = OriginReference
	}
	out.Priced = true
	return out
}

type UsageTotals struct {
	Requests                 int
	PricedRequests           int
	APIUsd                   *float64
	UnknownPriceRequests     int
	CacheEstimatedRequests   int
	UnknownPriceTokens       float64
	UnknownPriceUnsized      int
}

func SumUsage(lines []AppliedPrice, tokens []float64) UsageTotals {
	var t UsageTotals
	var usd float64
	priced := false
	for i, line := range lines {
		t.Requests++
		if line.UnknownPrice {
			t.UnknownPriceRequests++
			if i < len(tokens) && tokens[i] > 0 {
				t.UnknownPriceTokens += tokens[i]
			} else {
				t.UnknownPriceUnsized++
			}
			continue
		}
		if line.USD == nil {
			t.UnknownPriceRequests++
			continue
		}
		t.PricedRequests++
		usd += *line.USD
		priced = true
		if line.CacheGuess {
			t.CacheEstimatedRequests++
		}
	}
	if priced {
		t.APIUsd = &usd
	}
	return t
}

type FailureKind string

const (
	FailProvider FailureKind = "provider"
	FailAccount  FailureKind = "account"
	FailPrice    FailureKind = "price"
	FailUsage    FailureKind = "usage"
)

type Failure struct {
	Kind    FailureKind
	Subject string
}

type ObservationState string

const (
	StateUnknown     ObservationState = "unknown"
	StateUnsupported ObservationState = "unsupported"
	StatePartial     ObservationState = "partial"
	StateMeasuredZero ObservationState = "measured-zero"
	StateMeasured     ObservationState = "measured"
)

func ClassifyPeriod(sample *PeriodSample, supported bool) ObservationState {
	if !supported {
		return StateUnsupported
	}
	if sample == nil || sample.DeltaPp == nil {
		return StateUnknown
	}
	if sample.Coverage == nil || *sample.Coverage < 1-1e-9 || sample.ResetGapCount > 0 || sample.RecoveredHours > 0 {
		if *sample.DeltaPp == 0 {
			return StatePartial
		}
		return StatePartial
	}
	if *sample.DeltaPp == 0 {
		return StateMeasuredZero
	}
	return StateMeasured
}
