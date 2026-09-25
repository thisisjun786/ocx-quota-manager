package store

// TariffRevision changes whenever price_rules.json or tier selection changes
// in a way that alters already-stored amounts. It gates one bounded repricing
// replay; see repriceRow for which rows it may touch.
const TariffRevision = "2026-09-26-gpt6-grok47fast-kimihs-fastapplied"

// repricedModels gained a source-owned tariff in this revision, replacing a
// public-catalog rate or no rate at all.
var repricedModels = map[string]bool{
	"openai\x00gpt-6-sol": true, "openai\x00gpt-6-luna": true,
	"xai\x00grok-4.7-build-fast": true, "xai\x00grok-4.7": true,
	"kimi\x00kimi-for-coding-highspeed": true,
}

// repriceRow limits the repricing pass to rows whose tariff changed in this
// revision: the models above, and calls OpenCodex sent on the fast tier
// (earlier generations stored the default-tier amount for those).
func repriceRow(provider, model string, row map[string]any) bool {
	if repricedModels[provider+"\x00"+model] {
		return true
	}
	outcome, _ := row["tierOutcome"].(map[string]any)
	return outcome != nil && appliedFastTier(outcome)
}
