package runtime

import (
	_ "embed"
	"encoding/json"
	"strings"
)

//go:embed subscription_catalog.json
var subscriptionCatalogJSON []byte

const unknownPlanLabel = "플랜 미확인"
const unknownPlanReason = "이 계정의 플랜 정보를 확인할 수 없어 구독료를 지정하지 않았습니다."

type subscriptionEntry struct {
	MonthlyUSD *float64 `json:"monthlyUsd"`
	Label      string   `json:"label"`
	Basis      string   `json:"basis"`
	SourceURL  *string  `json:"sourceUrl"`
	CheckedAt  string   `json:"checkedAt"`
	Reason     string   `json:"reason"`
}
type subscriptionCatalog struct {
	Overrides map[string]subscriptionEntry            `json:"overrides"`
	Plans     map[string]map[string]subscriptionEntry `json:"plans"`
}

func loadSubscriptions() subscriptionCatalog {
	var cat subscriptionCatalog
	if err := json.Unmarshal(subscriptionCatalogJSON, &cat); err != nil {
		panic(err)
	}
	return cat
}

var subscriptions = loadSubscriptions()

func subscription(provider string, plan *string) map[string]any {
	provider = strings.TrimSpace(provider)
	if row, ok := subscriptions.Overrides[provider]; ok && row.MonthlyUSD != nil && *row.MonthlyUSD >= 0 && row.Label != "" {
		return subscriptionMap(row)
	}
	name := ""
	if plan != nil {
		name = strings.ToLower(strings.TrimSpace(*plan))
	}
	if plans, ok := subscriptions.Plans[provider]; ok {
		if row, ok := plans[name]; ok {
			return subscriptionMap(row)
		}
	}
	label := unknownPlanLabel
	if plan != nil && strings.TrimSpace(*plan) != "" {
		label = strings.TrimSpace(*plan)
	}
	return map[string]any{
		"monthlyUsd": nil, "label": label, "basis": "unknown", "sourceUrl": nil,
		"reason": unknownPlanReason,
	}
}

func subscriptionMap(row subscriptionEntry) map[string]any {
	return map[string]any{
		"monthlyUsd": row.MonthlyUSD, "label": row.Label, "basis": row.Basis,
		"sourceUrl": row.SourceURL, "checkedAt": row.CheckedAt, "reason": row.Reason,
	}
}
