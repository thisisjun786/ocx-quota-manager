package calc

// OllamaCompare is the existing CLI comparison surface. A missing local
// reading stays structurally separate from a priced cloud total.
type OllamaCompare struct {
	LocalTokens   *float64
	LocalUSD      *float64
	CloudUSD      *float64
	Ratio         *float64
	LocalMissing  bool
	CloudPriced   bool
	Notes         []string
}

func CompareOllama(localTokens *float64, localRate *float64, cloud *UsageTotals) OllamaCompare {
	out := OllamaCompare{LocalTokens: localTokens, CloudPriced: cloud != nil && cloud.APIUsd != nil}
	if localTokens == nil {
		out.LocalMissing = true
		out.Notes = append(out.Notes, "local token reading missing")
	} else if localRate != nil {
		usd := *localTokens / 1e6 * *localRate
		out.LocalUSD = &usd
	}
	if cloud != nil {
		out.CloudUSD = cloud.APIUsd
		if cloud.UnknownPriceRequests > 0 {
			out.Notes = append(out.Notes, "cloud total excludes unknown-price requests")
		}
	}
	if out.LocalUSD != nil && out.CloudUSD != nil && *out.LocalUSD > 0 {
		r := *out.CloudUSD / *out.LocalUSD
		out.Ratio = &r
	}
	return out
}

// Surfaces is the JUN-263 inventory of analysis outputs the HTTP/CLI already
// publish. Porting must keep each key; it must not drop UI-less reports.
var Surfaces = []string{
	"periods.oneHour", "periods.fiveHour", "periods.twentyFourHour", "periods.weekly", "periods.monthly",
	"quotaRecommendations", "subscriptionRecommendation",
	"modelRoster", "priceGaps", "priceEvidence",
	"ollamaComparison", "ollamaComparisonReport",
	"coverage", "pace", "capacity", "forecast",
}
