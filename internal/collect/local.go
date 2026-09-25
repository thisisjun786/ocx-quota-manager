package collect

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
)

const (
	staleMS  = 15 * 60 * 1000
	skewMS   = 60 * 1000
	maxLabel = 200
)

var providerNames = map[string]string{
	"openai": "OpenAI", "anthropic": "Anthropic", "xai": "xAI", "cursor": "Cursor",
	"ollama-cloud": "Ollama Cloud", "opencode-go": "OpenCode Go", "devin": "Devin",
	"command-code": "Command Code", "ollama": "Ollama", "kimi": "Kimi",
}

var windowOrder = []string{"five-hour", "short", "weekly", "monthly"}

var secretDelim = regexp.MustCompile(`[\s/:[\]~]`)

type Local struct {
	Bindings  []Binding
	Files     map[string]FileState
	Warnings  []string
	Providers []contract.Provider
	Secrets   []string
}

func (r Reader) LoadLocal(now time.Time) (Local, error) {
	read := r.ReadFile
	if read == nil {
		read = os.ReadFile
	}
	max := r.MaxBytes
	if max == 0 {
		max = 8 << 20
	}
	out := Local{Files: map[string]FileState{}}
	type loaded struct {
		obj  map[string]any
		raw  []byte
		keys []string
	}
	load := func(name, path string) loaded {
		if path == "" {
			out.Files[name] = FileMissing
			return loaded{}
		}
		raw, err := read(path)
		if errors.Is(err, os.ErrNotExist) {
			out.Files[name] = FileMissing
			return loaded{}
		}
		if err != nil {
			out.Files[name] = FileUnreadable
			out.Warnings = append(out.Warnings, warningFor(name))
			return loaded{}
		}
		if len(raw) > max {
			out.Files[name] = FileOversized
			out.Warnings = append(out.Warnings, warningFor(name))
			return loaded{}
		}
		var obj map[string]any
		if json.Unmarshal(raw, &obj) != nil || obj == nil {
			out.Files[name] = FileMalformed
			out.Warnings = append(out.Warnings, warningFor(name))
			return loaded{}
		}
		out.Files[name] = FileOK
		return loaded{obj: obj, raw: raw, keys: jsonObjectKeys(raw)}
	}
	config := load("ocxConfig", filepath.Join(r.Home, "config.json"))
	auth := load("ocxAuth", filepath.Join(r.Home, "auth.json"))
	creds := load("ocxCodexAccounts", filepath.Join(r.Home, "codex-accounts.json"))
	codexCache := load("codexQuotaCache", filepath.Join(r.Home, "codex-quota-cache.json"))
	provCache := load("providerQuotaCache", filepath.Join(r.Home, "provider-account-quota-cache.json"))
	var native loaded
	if r.CodexHome != "" {
		native = load("codexAuth", filepath.Join(r.CodexHome, "auth.json"))
	} else {
		out.Files["codexAuth"] = FileMissing
	}
	if r.ClaudeHome != "" {
		claude := load("claudeCredentials", filepath.Join(r.ClaudeHome, ".credentials.json"))
		if tok := claudeNativeToken(claude.obj); tok != "" {
			out.Bindings = append(out.Bindings, Binding{
				Provider: "anthropic", AccountID: "claude-native", Kind: KindOAuth, Token: tok, Enabled: true, Source: "claudeCredentials",
			})
		}
	} else {
		out.Files["claudeCredentials"] = FileMissing
	}

	configured, configuredOK := config.obj["providers"].(map[string]any)
	if config.obj != nil && !configuredOK {
		if out.Files["ocxConfig"] == FileOK {
			out.Files["ocxConfig"] = FileMalformed
			out.Warnings = append(out.Warnings, "프로바이더 설정을 확인할 수 없습니다. 네이티브 로그인 정보만 표시합니다.")
		}
		configured = nil
	}
	if out.Files["codexQuotaCache"] == FileOK || out.Files["providerQuotaCache"] == FileOK {
		cv, _ := codexCache.obj["version"].(float64)
		pv, _ := provCache.obj["version"].(float64)
		if cv != 1 || pv != 1 {
			out.Warnings = append(out.Warnings, "사용량 저장 형식을 확인할 수 없습니다. 일부 값이 표시되지 않을 수 있습니다.")
		}
	}

	secrets := collectSecrets(configured)
	out.Secrets = secrets
	cq := map[string]any{}
	if v, _ := codexCache.obj["version"].(float64); v == 1 {
		cq, _ = codexCache.obj["quotas"].(map[string]any)
		if cq == nil {
			cq = map[string]any{}
		}
	}
	pq := map[string]any{}
	if v, _ := provCache.obj["version"].(float64); v == 1 {
		pq, _ = provCache.obj["rows"].(map[string]any)
		if pq == nil {
			pq = map[string]any{}
		}
	}

	nativeTokens, _ := native.obj["tokens"].(map[string]any)
	nativeID := text(nativeTokens["account_id"])
	providerIDs := []string{}
	if configured != nil {
		providerIDs = providerKeyOrder(config.raw, configured)
	} else {
		seen := map[string]bool{}
		if nativeID != "" || len(creds.obj) > 0 {
			providerIDs = append(providerIDs, "openai")
			seen["openai"] = true
		}
		for _, key := range auth.keys {
			if key == "chatgpt" || key == "openai-multi" {
				continue
			}
			if _, ok := auth.obj[key].(map[string]any); ok && !seen[key] {
				providerIDs = append(providerIDs, key)
				seen[key] = true
			}
		}
	}

	nowMS := now.UTC().UnixMilli()
	disabledModels := disabledModelSet(config.obj)
	for _, id := range providerIDs {
		var raw map[string]any
		if configured != nil {
			entry, ok := configured[id]
			if !ok {
				continue
			}
			raw, ok = entry.(map[string]any)
			if !ok {
				out.Warnings = append(out.Warnings, "일부 프로바이더 설정을 읽지 못했습니다.")
				continue
			}
		}
		if raw == nil {
			raw = map[string]any{}
		}
		disabled, _ := raw["disabled"].(bool)
		if disabled {
			out.Files["provider:"+id] = FileDisabled
		}
		accounts := []contract.Account{}
		if id == "openai" {
			accounts, out = projectOpenAI(out, config.obj, creds.obj, nativeTokens, nativeID, codexCache.obj, cq, secrets, nowMS, r.CodexHome != "")
			if key := text(raw["apiKey"]); key != "" {
				out.Bindings = append(out.Bindings, Binding{
					Provider: "openai", AccountID: "key:default", Kind: KindKey, Token: key, Enabled: true, Source: "ocxConfig",
				})
			}
		} else {
			accounts, out = projectOther(out, id, raw, auth.obj, pq, secrets, nowMS)
		}
		def := firstModel(raw["defaultModel"], secrets)
		models := modelList(raw["models"], secrets)
		if def != nil {
			models = uniqueStrings(append(models, *def))
		}
		filtered := []string{}
		for _, m := range models {
			if !disabledModels[id+"/"+m] {
				filtered = append(filtered, m)
			}
		}
		name := providerNames[id]
		if name == "" {
			name = id
		}
		out.Providers = append(out.Providers, contract.Provider{
			ID: id, Name: name, Enabled: !disabled, DefaultModel: def, SupportedModels: filtered, Accounts: accounts,
		})
	}
	// Native credentials are loaded before provider configuration. Apply the
	// provider opt-out after every credential source has been projected.
	for i := range out.Bindings {
		binding := &out.Bindings[i]
		if out.Files["provider:"+binding.Provider] == FileDisabled {
			binding.Enabled = false
		}
		if binding.Source == "codexAuth" || binding.Source == "claudeCredentials" {
			binding.BaseStatus = "native"
			continue
		}
		binding.BaseStatus = "unknown"
		if configured != nil {
			configID := binding.ConfigProvider
			if configID == "" {
				configID = binding.Provider
			}
			raw, exists := configured[configID].(map[string]any)
			if !exists {
				continue
			}
			binding.BaseStatus = "default"
			binding.AuthMode = text(raw["authMode"])
			if raw["orgId"] != nil {
				binding.Organization = fmt.Sprint(raw["orgId"])
			}
			if declared, exists := raw["baseUrl"]; exists && declared != nil {
				binding.BaseStatus = "invalid"
				if v, ok := declared.(string); ok && v != "" {
					u, err := url.Parse(v)
					if err == nil && u.Host != "" && (u.Scheme == "https" || u.Scheme == "http") && u.User == nil {
						binding.BaseStatus = "custom"
						binding.BaseURL = v
					}
				}
			}
		}
	}
	if out.Providers == nil {
		out.Providers = []contract.Provider{}
	}
	return out, nil
}

func projectOpenAI(out Local, config, creds, nativeTokens map[string]any, nativeID string, cache, cq map[string]any, secrets []string, nowMS int64, attemptNative bool) ([]contract.Account, Local) {
	var accounts []contract.Account
	hasConfig := config != nil
	if config == nil {
		config = map[string]any{}
	}
	if creds == nil {
		creds = map[string]any{}
	}
	paused := stringList(config["pausedCodexAccountIds"])
	activeID, _ := config["activeCodexAccountId"].(string)
	if attemptNative && nativeID != "" {
		bound := boundMainQuota(cache, mainIdentityHash(nativeID))
		if bound == nil {
			out.Warnings = append(out.Warnings, "Codex 기본 계정의 사용량을 현재 로그인과 연결할 수 없습니다.")
		}
		acc := projectQuotaAccount("__main__", "Codex 기본 계정", nil, activeID == "__main__", bound, nowMS, accountState{
			Paused: containsString(paused, "__main__"),
		})
		accounts = append(accounts, acc)
		if tok := secretText(nativeTokens["access_token"]); tok != "" {
			out.Bindings = append(out.Bindings, Binding{
				Provider: "openai", AccountID: "__main__", Kind: KindOAuth, Token: tok, Enabled: !containsString(paused, "__main__"), Source: "codexAuth", AccountRef: stringRef(nativeID),
			})
		}
	} else if attemptNative {
		out.Warnings = append(out.Warnings, "Codex 기본 로그인 정보를 확인할 수 없습니다.")
		accounts = append(accounts, projectQuotaAccount("__main__", "Codex 기본 계정", nil, false, nil, nowMS, accountState{}))
	}

	poolRows := []map[string]any{}
	if hasConfig {
		if rows, ok := config["codexAccounts"].([]any); ok {
			for _, item := range rows {
				if rec, ok := item.(map[string]any); ok {
					poolRows = append(poolRows, rec)
				}
			}
		}
	} else {
		for key, raw := range creds {
			if text(key) == "" {
				continue
			}
			entry, _ := raw.(map[string]any)
			if poolToken(entry) == "" {
				continue
			}
			poolRows = append(poolRows, map[string]any{"id": key})
		}
	}
	for _, a := range poolRows {
		id := text(a["id"])
		if id == "" {
			continue
		}
		if isMain, _ := a["isMain"].(bool); isMain || id == "__main__" {
			continue
		}
		stored, _ := creds[id].(map[string]any)
		if stored == nil {
			stored = map[string]any{}
		}
		cred, _ := stored["credential"].(map[string]any)
		if cred == nil {
			cred = stored
		}
		token := poolToken(stored)
		present := token != "" && stored["deletedAt"] == nil
		var plan *string
		if p := text(a["plan"]); p != "" {
			plan = &p
		}
		label := maskLabel(firstNonEmpty(text(a["alias"]), text(a["email"])), fmt.Sprintf("OpenAI 계정 %d", len(accounts)+1), secrets)
		acc := projectQuotaAccount(id, label, plan, activeID == id, nilIf(!present, cq[id]), nowMS, accountState{
			Reauth: !present, Paused: containsString(paused, id),
		})
		accounts = append(accounts, acc)
		if present {
			out.Bindings = append(out.Bindings, Binding{
				Provider: "openai", AccountID: id, Kind: KindOAuth, Token: token, Enabled: !containsString(paused, id), Source: "ocxCodexAccounts", AccountRef: stringRef(text(cred["chatgptAccountId"])),
			})
		}
	}
	return accounts, out
}

func projectOther(out Local, id string, raw, auth, pq map[string]any, secrets []string, nowMS int64) ([]contract.Account, Local) {
	disabled, _ := raw["disabled"].(bool)
	var accounts []contract.Account
	set, _ := auth[id].(map[string]any)
	if set == nil {
		set = map[string]any{}
	}
	active, _ := set["activeAccountId"].(string)
	name := providerNames[id]
	if name == "" {
		name = id
	}
	if rows, ok := set["accounts"].([]any); ok {
		for _, item := range rows {
			a, ok := item.(map[string]any)
			if !ok {
				continue
			}
			accID := text(a["id"])
			if accID == "" {
				continue
			}
			cr, _ := a["credential"].(map[string]any)
			if cr == nil {
				cr = map[string]any{}
			}
			token := secretText(cr["access"])
			if token == "" {
				token = secretText(cr["accessToken"])
			}
			var plan *string
			if p := firstNonEmpty(text(a["plan"]), text(cr["plan"])); p != "" {
				plan = &p
			}
			label := maskLabel(firstNonEmpty(text(a["alias"]), text(cr["email"])), fmt.Sprintf("%s 계정 %d", name, len(accounts)+1), secrets)
			reauth, _ := a["needsReauth"].(bool)
			quota, _ := pq[id+"\x00"+accID]
			q, _ := quota.(map[string]any)
			accounts = append(accounts, projectQuotaAccount(accID, label, plan, active == accID, q, nowMS, accountState{Reauth: reauth}))
			if token != "" {
				out.Bindings = append(out.Bindings, Binding{
					ConfigProvider: id, Provider: normalizeProvider(id), AccountID: accID, Kind: KindOAuth, Token: token, Enabled: !disabled && !reauth, Source: "ocxAuth", AccountRef: stringRef(text(cr["accountId"])),
				})
			}
		}
	}
	keys := records(raw["apiKeyPool"])
	bare := secretText(raw["apiKey"])
	kimiKeyAdded := false
	for _, k := range keys {
		kid := text(k["id"])
		key := secretText(k["key"])
		if kid == "" || key == "" {
			continue
		}
		// Kimi keys have no independently verified subscription identity.
		// Keep only one primary key; backups must not inflate account counts.
		if id == "kimi" {
			if key != bare || kimiKeyAdded {
				continue
			}
			kimiKeyAdded = true
		}
		label := maskLabel(firstNonEmpty(text(k["label"]), text(k["alias"])), fmt.Sprintf("API 계정 %d", len(accounts)+1), secrets)
		accounts = append(accounts, projectQuotaAccount("key:"+kid, label, nil, bare == key, nil, nowMS, accountState{}))
		out.Bindings = append(out.Bindings, Binding{
			Provider: id, AccountID: "key:" + kid, Kind: KindKey, Token: key, Enabled: true, Source: "ocxConfig",
		})
	}
	if bare != "" {
		dup := false
		for _, k := range keys {
			if text(k["key"]) == bare {
				dup = true
				break
			}
		}
		if !dup {
			accounts = append(accounts, projectQuotaAccount("key:default", "API 기본 계정", nil, true, nil, nowMS, accountState{}))
			out.Bindings = append(out.Bindings, Binding{
				Provider: id, AccountID: "key:default", Kind: KindKey, Token: bare, Enabled: true, Source: "ocxConfig",
			})
		}
	}
	return accounts, out
}

type accountState struct {
	Reauth bool
	Paused bool
}

func projectQuotaAccount(id, name string, plan *string, active bool, quota map[string]any, nowMS int64, state accountState) contract.Account {
	if quota == nil {
		quota = map[string]any{}
	}
	var updatedAt *string
	var measured float64
	hasMeasured := false
	if n := asFloat(quota["updatedAt"]); n != nil {
		measured = *n
		hasMeasured = true
		if iso := isoMS(*n); iso != "" {
			updatedAt = &iso
		}
	}
	old := !hasMeasured || expiredMS(int64(measured), nowMS)
	windows := []contract.Window{}
	add := func(wid, title string, value any, reset any) {
		used := asFloat(value)
		if used == nil || *used < 0 {
			return
		}
		u := *used
		if u > 100 {
			u = 100
		}
		remain := 100 - u
		stale := old
		var resetAt *string
		if s := epochISO(reset); s != "" {
			resetAt = &s
			if t, err := contract.ParseISO(s); err == nil && !t.After(time.UnixMilli(nowMS).UTC()) {
				stale = true
			}
		}
		windows = append(windows, contract.Window{
			ID: wid, Label: title, RemainingPercent: &remain, Stale: boolPtr(stale), ResetAt: resetAt,
		})
	}
	add("five-hour", "5시간", quota["fiveHourPercent"], quota["fiveHourResetAt"])
	shortLabel := "단기"
	if sec := asFloat(quota["shortWindowSeconds"]); sec != nil {
		shortLabel = fmt.Sprintf("%g시간", float64(int(*sec/3600*10+0.5))/10)
	}
	add("short", shortLabel, quota["shortPercent"], quota["shortResetAt"])
	add("weekly", "주간", quota["weeklyPercent"], quota["weeklyResetAt"])
	add("monthly", "월간", quota["monthlyPercent"], quota["monthlyResetAt"])
	custom := records(quota["customWindows"])
	named := map[string]bool{}
	for i, row := range custom {
		title := text(row["label"])
		if title == "" {
			title = "추가 한도"
		}
		key := scopedWindowID(title)
		if key == "" || named[key] {
			key = fmt.Sprintf("custom-%d", i)
			for named[key] {
				i++
				key = fmt.Sprintf("custom-%d", i)
			}
		}
		named[key] = true
		add(key, title, row["percent"], row["resetAt"])
	}
	if credits, ok := quota["creditsUsd"].(map[string]any); ok {
		if unlim, _ := credits["unlimited"].(bool); !unlim {
			add("credits", "크레딧", credits["percent"], credits["expiresAt"])
		}
	}
	status := "ok"
	if state.Reauth {
		status = "reauth"
	} else if state.Paused {
		status = "paused"
	} else if len(windows) == 0 {
		status = "unavailable"
	} else {
		for _, w := range windows {
			if w.Stale != nil && *w.Stale {
				status = "stale"
				break
			}
		}
	}
	mode := "unavailable"
	if len(windows) > 0 {
		mode = "observed"
	}
	act := active
	return contract.Account{
		ID: id, Label: name, Plan: plan, Status: status, UpdatedAt: updatedAt,
		Active: &act, QuotaMode: &mode, Windows: windows,
	}
}

func MergeDirect(base []contract.Provider, rows []Reading, now time.Time) []contract.Provider {
	if len(rows) == 0 {
		if base == nil {
			return []contract.Provider{}
		}
		return base
	}
	// A withheld window must also disappear from the local cached projection.
	hidden := map[string]bool{}
	for _, r := range rows {
		if r.Hidden {
			hidden[r.Provider+"\x00"+r.Account+"\x00"+r.WindowID] = true
		}
	}
	if len(hidden) > 0 {
		base = append([]contract.Provider(nil), base...)
		for pi := range base {
			base[pi].Accounts = append([]contract.Account(nil), base[pi].Accounts...)
			for ai := range base[pi].Accounts {
				a := &base[pi].Accounts[ai]
				windows := []contract.Window{}
				for _, w := range a.Windows {
					if !hidden[base[pi].ID+"\x00"+a.ID+"\x00"+w.ID] {
						windows = append(windows, w)
					}
				}
				a.Windows = windows
			}
		}
	}
	direct := project(rows, now)
	byID := map[string]int{}
	out := append([]contract.Provider{}, base...)
	for i, p := range out {
		byID[p.ID] = i
	}
	for _, p := range direct {
		idx, ok := byID[p.ID]
		if !ok {
			out = append(out, p)
			byID[p.ID] = len(out) - 1
			continue
		}
		accIdx := map[string]int{}
		for i, a := range out[idx].Accounts {
			accIdx[a.ID] = i
		}
		for _, a := range p.Accounts {
			ai, found := accIdx[a.ID]
			if !found {
				out[idx].Accounts = append(out[idx].Accounts, a)
				continue
			}
			out[idx].Accounts[ai] = mergeAccount(out[idx].Accounts[ai], a)
		}
	}
	if out == nil {
		return []contract.Provider{}
	}
	return out
}

func mergeAccount(cache, live contract.Account) contract.Account {
	byID := map[string]contract.Window{}
	order := []string{}
	seen := map[string]bool{}
	add := func(w contract.Window, overwrite bool) {
		if w.ID == "" {
			return
		}
		if _, ok := byID[w.ID]; ok {
			if overwrite {
				byID[w.ID] = w
			}
			return
		}
		byID[w.ID] = w
		order = append(order, w.ID)
		seen[w.ID] = true
	}
	for _, w := range cache.Windows {
		add(w, false)
	}
	liveFresh := live.Status == "ok" || (live.Status == "stale" && len(live.Windows) > 0)
	if liveFresh {
		for _, w := range live.Windows {
			if _, ok := byID[w.ID]; ok {
				byID[w.ID] = w
				continue
			}
			add(w, true)
		}
		if live.UpdatedAt != nil {
			cache.UpdatedAt = live.UpdatedAt
		}
		if cache.Status != "paused" && cache.Status != "reauth" && (live.Status == "ok" || cache.Status == "unavailable" || cache.Status == "ok") {
			cache.Status = live.Status
		}
		if len(live.Windows) > 0 {
			mode := "observed"
			cache.QuotaMode = &mode
		}
	} else if live.Status == "stale" || live.Status == "unavailable" {
		if cache.Status == "ok" && len(cache.Windows) == 0 {
			cache.Status = live.Status
		}
		if cache.Status == "unavailable" && live.Status == "stale" {
			cache.Status = "stale"
		}
	}
	ids := append([]string{}, order...)
	sortWindows(ids)
	windows := make([]contract.Window, 0, len(ids))
	for _, id := range ids {
		windows = append(windows, byID[id])
	}
	cache.Windows = windows
	if cache.Status == "ok" && len(windows) == 0 {
		cache.Status = "unavailable"
	}
	if cache.Status == "ok" {
		for _, w := range windows {
			if w.Stale != nil && *w.Stale {
				cache.Status = "stale"
				break
			}
		}
	}
	return cache
}

func sortWindows(ids []string) {
	rank := func(id string) int {
		for i, w := range windowOrder {
			if w == id {
				return i
			}
		}
		if id == "credits" {
			return 1000
		}
		return 100
	}
	for i := 0; i < len(ids); i++ {
		for j := i + 1; j < len(ids); j++ {
			if rank(ids[j]) < rank(ids[i]) {
				ids[i], ids[j] = ids[j], ids[i]
			}
		}
	}
}

func project(rows []Reading, now time.Time) []contract.Provider {
	// local copy of runtime.project so collect can merge without an import cycle
	by := map[string][]Reading{}
	order := []string{}
	for _, r := range rows {
		if _, ok := by[r.Provider]; !ok {
			order = append(order, r.Provider)
		}
		by[r.Provider] = append(by[r.Provider], r)
	}
	var out []contract.Provider
	for _, id := range order {
		accs := map[string][]Reading{}
		accOrder := []string{}
		for _, r := range by[id] {
			if _, ok := accs[r.Account]; !ok {
				accOrder = append(accOrder, r.Account)
			}
			accs[r.Account] = append(accs[r.Account], r)
		}
		name := providerNames[id]
		if name == "" {
			name = id
		}
		p := contract.Provider{ID: id, Name: name, Enabled: true, Accounts: []contract.Account{}}
		for _, aid := range accOrder {
			status := "ok"
			var updated *string
			acc := contract.Account{ID: aid, Label: aid, Status: status, Windows: []contract.Window{}}
			for _, r := range accs[aid] {
				if r.Kind == WindowFailed {
					acc.Status = "stale"
				}
				if r.Hidden || r.RemainingPercent == nil || r.Kind == WindowEmpty || r.Kind == WindowInvalid || r.WindowID == "" {
					continue
				}
				if r.ObservedAt > 0 {
					iso := time.UnixMilli(r.ObservedAt).UTC().Format(time.RFC3339Nano)
					if updated == nil || iso > *updated {
						updated = &iso
					}
				}
				var remain *float64
				if r.RemainingPercent != nil {
					v := *r.RemainingPercent
					remain = &v
				}
				var reset *string
				if r.ResetAt != nil {
					s := time.UnixMilli(*r.ResetAt).UTC().Format(time.RFC3339Nano)
					reset = &s
				}
				stale := r.Kind != WindowOK || (r.ObservedAt > 0 && now.UnixMilli()-r.ObservedAt > staleMS) || (r.ResetAt != nil && *r.ResetAt <= now.UnixMilli())
				acc.Windows = append(acc.Windows, contract.Window{
					ID: r.WindowID, Label: r.Label, RemainingPercent: remain, Stale: &stale, ResetAt: reset,
				})
			}
			if updated == nil {
				iso := now.UTC().Format(time.RFC3339Nano)
				updated = &iso
			}
			acc.UpdatedAt = updated
			if acc.Status == "ok" && len(acc.Windows) == 0 {
				acc.Status = "unavailable"
			}
			mode := "unavailable"
			if len(acc.Windows) > 0 {
				mode = "observed"
			}
			acc.QuotaMode = &mode
			p.Accounts = append(p.Accounts, acc)
		}
		out = append(out, p)
	}
	if out == nil {
		out = []contract.Provider{}
	}
	return out
}

func boundMainQuota(cache map[string]any, hash string) map[string]any {
	if cache == nil {
		return nil
	}
	mp, _ := cache["mainPolicyQuota"].(map[string]any)
	if mp == nil {
		return nil
	}
	key, _ := mp["identityKey"].(string)
	if key != hash {
		return nil
	}
	q, _ := mp["quota"].(map[string]any)
	return q
}

func mainIdentityHash(nativeID string) string {
	sum := sha256.New()
	sum.Write([]byte("opencodex-main-quota-v1\x00"))
	sum.Write([]byte(nativeID))
	return hex.EncodeToString(sum.Sum(nil))
}

func warningFor(name string) string {
	labels := map[string]string{
		"ocxConfig": "설정", "ocxAuth": "로그인", "codexQuotaCache": "OpenAI 사용량",
		"providerQuotaCache": "프로바이더 사용량", "ocxCodexAccounts": "OpenAI 계정",
		"codexAuth": "Codex 기본 로그인", "claudeCredentials": "Claude 로그인",
	}
	label := labels[name]
	if label == "" {
		label = name
	}
	return label + " 정보를 읽지 못했습니다. OpenCodex 상태를 확인해 주세요."
}

func collectSecrets(configured map[string]any) []string {
	var out []string
	for _, raw := range configured {
		p, _ := raw.(map[string]any)
		if p == nil {
			continue
		}
		if k := secretText(p["apiKey"]); k != "" {
			out = append(out, k)
		}
		for _, row := range records(p["apiKeyPool"]) {
			if k := secretText(row["key"]); k != "" {
				out = append(out, k)
			}
		}
	}
	return out
}

func poolToken(entry map[string]any) string {
	if entry == nil || entry["deletedAt"] != nil {
		return ""
	}
	cred, _ := entry["credential"].(map[string]any)
	if cred == nil {
		cred = entry
	}
	return secretText(cred["accessToken"])
}

func claudeNativeToken(obj map[string]any) string {
	oauth, _ := obj["claudeAiOauth"].(map[string]any)
	return secretText(oauth["accessToken"])
}

func nilIf(cond bool, v any) map[string]any {
	if cond {
		return nil
	}
	m, _ := v.(map[string]any)
	return m
}

func providerKeyOrder(raw []byte, configured map[string]any) []string {
	keys := jsonObjectKeys(extractField(raw, "providers"))
	if len(keys) > 0 {
		return keys
	}
	out := make([]string, 0, len(configured))
	for id := range configured {
		out = append(out, id)
	}
	return out
}

func extractField(raw []byte, field string) []byte {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return nil
	}
	return obj[field]
}

func jsonObjectKeys(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil
	}
	d, ok := tok.(json.Delim)
	if !ok || d != '{' {
		return nil
	}
	var keys []string
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return keys
		}
		key, _ := k.(string)
		keys = append(keys, key)
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			return keys
		}
	}
	return keys
}

func records(v any) []map[string]any {
	arr, _ := v.([]any)
	var out []map[string]any
	for _, item := range arr {
		if rec, ok := item.(map[string]any); ok {
			out = append(out, rec)
		}
	}
	return out
}

func stringList(v any) []string {
	arr, _ := v.([]any)
	var out []string
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func containsString(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func text(v any) string {
	s, _ := v.(string)
	if s == "" || len(s) > maxLabel {
		return ""
	}
	return s
}

func secretText(v any) string {
	s, _ := v.(string)
	return s
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func maskLabel(value, fallback string, secrets []string) string {
	if value == "" || carriesSecret(value, secrets) {
		return fallback
	}
	if !strings.Contains(value, "@") {
		return value
	}
	parts := strings.SplitN(value, "@", 2)
	local := parts[0]
	if len(local) > 2 {
		local = local[:2]
	}
	return local + "•••@" + parts[1]
}

func carriesSecret(value string, secrets []string) bool {
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		if value == secret {
			return true
		}
		for at := strings.Index(value, secret); at >= 0; at = indexFrom(value, secret, at+1) {
			before := byte(0)
			if at > 0 {
				before = value[at-1]
			}
			after := byte(0)
			if at+len(secret) < len(value) {
				after = value[at+len(secret)]
			}
			if (at == 0 || secretDelim.MatchString(string([]byte{before}))) &&
				(after == 0 || secretDelim.MatchString(string([]byte{after}))) {
				return true
			}
		}
	}
	return false
}

func indexFrom(s, sub string, start int) int {
	if start >= len(s) {
		return -1
	}
	i := strings.Index(s[start:], sub)
	if i < 0 {
		return -1
	}
	return start + i
}

func asFloat(v any) *float64 {
	switch n := v.(type) {
	case float64:
		return &n
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return nil
		}
		return &f
	default:
		return nil
	}
}

func isoMS(ms float64) string {
	if ms <= 0 || ms >= 8.64e15 {
		return ""
	}
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
}

func epochISO(v any) string {
	n := asFloat(v)
	if n == nil {
		return ""
	}
	ms := *n
	if ms < 1e11 {
		ms *= 1000
	}
	return isoMS(ms)
}

func expiredMS(measured, now int64) bool {
	if measured <= 0 {
		return true
	}
	return now-measured > staleMS || measured > now+skewMS
}

func boolPtr(v bool) *bool { return &v }

func scopedWindowID(label string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(label) {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			dash = false
			continue
		}
		dash = true
	}
	if b.Len() == 0 {
		return ""
	}
	return "custom-" + b.String()
}

func modelId(value any) string {
	s := text(value)
	if s == "" || len(s) > 100 {
		return ""
	}
	segments := strings.Split(s, "/")
	for _, part := range segments {
		base := strings.Split(part, "[")[0]
		if matched, _ := regexp.MatchString(`^[A-Za-z]:`, part); matched {
			return ""
		}
		if strings.HasPrefix(base, ".") {
			return ""
		}
		if base == "." || base == ".." || base == "~" || part == "" {
			return ""
		}
	}
	tildes := strings.Count(s, "~")
	if tildes > 0 && !(tildes == 1 && strings.HasPrefix(s, "~") && len(segments) == 2) {
		return ""
	}
	hasBracket := false
	for _, part := range segments {
		if strings.Contains(part, "[") {
			hasBracket = true
		}
	}
	if hasBracket && len(segments) > 1 {
		return ""
	}
	if len(segments) > 6 {
		return ""
	}
	segRe := regexp.MustCompile(`^[\w.:+@~-]+(?:\[[A-Za-z0-9]+\])?$`)
	for _, part := range segments {
		if !segRe.MatchString(part) {
			return ""
		}
	}
	return s
}

func modelList(v any, secrets []string) []string {
	arr, _ := v.([]any)
	var out []string
	for _, item := range arr {
		id := modelId(item)
		if id == "" || carriesSecret(id, secrets) {
			continue
		}
		out = append(out, id)
	}
	return out
}

func firstModel(v any, secrets []string) *string {
	id := modelId(v)
	if id == "" || carriesSecret(id, secrets) {
		return nil
	}
	return &id
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func disabledModelSet(config map[string]any) map[string]bool {
	out := map[string]bool{}
	if config == nil {
		return out
	}
	for _, item := range recordsAny(config["disabledModels"]) {
		s, _ := item.(string)
		if s == "" {
			continue
		}
		slash := strings.IndexByte(s, '/')
		if slash <= 0 {
			continue
		}
		prov := s[:slash]
		model := modelId(s[slash+1:])
		if model == "" {
			continue
		}
		out[prov+"/"+model] = true
	}
	return out
}

func recordsAny(v any) []any {
	arr, _ := v.([]any)
	return arr
}

func stringRef(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}
