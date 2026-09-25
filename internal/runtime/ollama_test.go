package runtime

import (
	"math"
	"testing"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

const ollamaMin = int64(60_000)

func ollamaObs(at int64, glm, ds int64, used float64) store.OllamaObservation {
	models := map[string]int64{"glm": glm}
	if ds > 0 {
		models["ds"] = ds
	}
	return store.OllamaObservation{At: at, Limits: map[string]store.OllamaWindow{"session": {Used: used, Models: models}}}
}

func ollamaRow(id string, at int64, model string, input *float64) store.Usage {
	out := 100.0
	return store.Usage{ID: id, At: at, Provider: "ollama-cloud", Model: &model, Input: input, Output: &out}
}

func pricedAt(rows []store.Usage) []calc.AppliedPrice {
	prices := make([]calc.AppliedPrice, len(rows))
	for i, r := range rows {
		if r.Input != nil {
			v := *r.Input / 1e5
			prices[i] = calc.AppliedPrice{USD: &v}
		}
	}
	return prices
}

func TestCalibrateOllamaUsesIsolatedMatchedRun(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	obs := []store.OllamaObservation{
		ollamaObs(0, 10, 0, 1), ollamaObs(2*ollamaMin, 11, 0, 1.2), ollamaObs(4*ollamaMin, 11, 0, 1.3),
		ollamaObs(6*ollamaMin, 12, 0, 1.5),
		// Two models moved: neither can be calibrated from this run.
		ollamaObs(8*ollamaMin, 13, 1, 2.5),
	}
	rows := []store.Usage{
		ollamaRow("1", 1*ollamaMin, "glm", f(1000)), ollamaRow("2", 5*ollamaMin, "glm", f(3000)),
		ollamaRow("3", 7*ollamaMin, "glm", f(9000)), ollamaRow("4", 7*ollamaMin+1, "ds", f(9000)),
	}
	got := calibrateOllama(obs, rows, pricedAt(rows), "session")
	if len(got) != 1 || got[0].Model != "glm" || got[0].Requests != 2 || got[0].Intervals != 1 {
		t.Fatalf("calibration %+v", got)
	}
	if math.Abs(got[0].DeltaPp-0.5) > 1e-9 || math.Abs(got[0].InputTokensPerPp-8000) > 1e-6 {
		t.Fatalf("rates %+v", got[0])
	}
	if got[0].APIUsdPerPp == nil || math.Abs(*got[0].APIUsdPerPp-0.08) > 1e-9 {
		t.Fatalf("usd per pp %+v", got[0].APIUsdPerPp)
	}
}

func TestCalibrateOllamaRejectsRunWithTokenlessCall(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	obs := []store.OllamaObservation{ollamaObs(0, 10, 0, 1), ollamaObs(3*ollamaMin, 11, 0, 1.2), ollamaObs(6*ollamaMin, 12, 0, 1.5)}
	// The counter moved by two and the log has two glm calls, but one has no
	// token counts: tokens per point would be understated.
	rows := []store.Usage{ollamaRow("1", 1*ollamaMin, "glm", f(1000)), ollamaRow("2", 5*ollamaMin, "glm", nil)}
	if got := calibrateOllama(obs, rows, pricedAt(rows), "session"); len(got) != 0 {
		t.Fatalf("calibrated a run with an unmeasured call: %+v", got)
	}
}
