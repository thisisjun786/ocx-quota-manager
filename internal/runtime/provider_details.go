package runtime

import (
	"sort"

	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func attachSubscription(a, sub map[string]any, providerPeriods map[string]any) {
	a["subscription"] = sub
	a["monthlyValueRatio"], a["monthlyValueBasis"] = nil, nil
	monthly, _ := a["periods"].(map[string]any)["monthly"].(map[string]any)
	usd, _ := monthly["apiUsd"].(*float64)
	price, _ := sub["monthlyUsd"].(*float64)
	if usd != nil {
		basis := "matched"
		p, _ := providerPeriods["monthly"].(map[string]any)
		if monthly["unknownPriceRequests"] != 0 || p["unattributedRequests"] != 0 {
			basis = "partial"
		} else if monthly["localPriceRequests"] != 0 {
			basis = "estimated"
		}
		a["monthlyValueBasis"] = basis
		if price != nil && *price > 0 {
			a["monthlyValueRatio"] = *usd / *price
		}
	}
}

func attachProviderDetails(p *contract.Provider, usage []store.Usage, prices []calc.AppliedPrice, now int64) {
	a := p.Analytics.(map[string]any)
	total, known := 0.0, len(p.Accounts) > 0
	for _, account := range p.Accounts {
		sub := account.Analytics.(map[string]any)["subscription"].(map[string]any)
		price, _ := sub["monthlyUsd"].(*float64)
		if price == nil {
			known = false
		} else {
			total += *price
		}
	}
	a["subscriptionMonthlyUsd"] = nil
	if known {
		a["subscriptionMonthlyUsd"] = total
	}
	var unattr usageSum
	missing := map[string]int{}
	// Only roster-validated names may reach the UI; unknown log strings are
	// represented by an unnamed bucket, never echoed as model identities.
	allowed := map[string]bool{}
	for _, model := range p.SupportedModels {
		allowed[model] = true
	}
	for i, row := range usage {
		if row.Provider != p.ID || row.At > now {
			continue
		}
		if row.At > now-168*calc.HourMs && row.Account == nil {
			unattr.add(row, prices[i])
		}
		if row.At > now-720*calc.HourMs && prices[i].USD == nil {
			name := ""
			if row.Model != nil && allowed[*row.Model] {
				name = *row.Model
			}
			missing[name]++
		}
	}
	a["unattributed"] = unattr.dto(168, 0, nil, now)
	names := make([]string, 0, len(missing))
	for name := range missing {
		names = append(names, name)
	}
	sort.Strings(names)
	models := []map[string]any{}
	for _, name := range names {
		models = append(models, map[string]any{"model": name, "requests": missing[name]})
	}
	a["unpricedModels"] = models
}

func subscriptionTotal(providers []contract.Provider) *float64 {
	if len(providers) == 0 {
		return nil
	}
	total := 0.0
	for _, p := range providers {
		v, ok := p.Analytics.(map[string]any)["subscriptionMonthlyUsd"].(float64)
		if !ok {
			return nil
		}
		total += v
	}
	return &total
}
