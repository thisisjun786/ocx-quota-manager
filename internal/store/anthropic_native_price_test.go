package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const nativeCatalog = `{"anthropic":{"models":{"claude-opus-5-5":{"id":"claude-opus-5-5","cost":{"input":5,"output":25,"cache_read":0.5,"cache_write":6.25}}}}}`

func writeUsageLog(t *testing.T, path string, rows []map[string]any) {
	t.Helper()
	var body []byte
	for _, r := range rows {
		b, err := json.Marshal(r)
		if err != nil {
			t.Fatal(err)
		}
		body = append(body, append(b, '\n')...)
	}
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
}

func nativeUsageByID(t *testing.T, h *History) map[string]Usage {
	t.Helper()
	rows, err := h.ListUsage()
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Usage{}
	for _, u := range rows {
		by[u.ID] = u
	}
	return by
}

func TestPriceProviderMapsOnlyAnthropicNative(t *testing.T) {
	for in, want := range map[string]string{"anthropic-native": "anthropic", "anthropic": "anthropic", "anthropic-apikey": "anthropic-apikey", "anthropic-native-x": "anthropic-native-x", "openai": "openai", "": ""} {
		if got := PriceProvider(in); got != want {
			t.Fatalf("PriceProvider(%q)=%q want %q", in, got, want)
		}
	}
	if got := usageProvider("anthropic-native"); got != "anthropic-native" {
		t.Fatalf("stored provider %q", got)
	}
}

func TestAnthropicNativePricedLikeAnthropic(t *testing.T) {
	h := openTemp(t)
	c, err := ParseCatalog([]byte(nativeCatalog))
	if err != nil {
		t.Fatal(err)
	}
	h.SetCatalog(c)
	at := int64(1800000000000)
	type variant struct {
		name, model        string
		input, read, write float64
	}
	variants := []variant{
		{"opus", "claude-opus-5-5", 1000, 200, 300},
		{"haiku-low", "claude-haiku-5-5", 50000, 10000, 5000},
		{"haiku-high", "claude-haiku-5-5", 150000, 90000, 9000},
	}
	var rows []map[string]any
	for _, v := range variants {
		for _, provider := range []string{"anthropic", "anthropic-native"} {
			rows = append(rows, map[string]any{"requestId": provider + "/" + v.name, "timestamp": at, "provider": provider, "model": v.model,
				"usage": map[string]any{"inputTokens": v.input, "outputTokens": 1000, "cacheReadInputTokens": v.read, "cacheCreationInputTokens": v.write}})
		}
	}
	// A non-default tier stays unpriced for both providers.
	for _, provider := range []string{"anthropic", "anthropic-native"} {
		rows = append(rows, map[string]any{"requestId": provider + "/priority", "timestamp": at, "provider": provider, "model": "claude-haiku-5-5", "responseServiceTier": "priority",
			"usage": map[string]any{"inputTokens": 1000, "outputTokens": 100}})
		rows = append(rows, map[string]any{"requestId": provider + "/priority-opus", "timestamp": at, "provider": provider, "model": "claude-opus-5-5", "responseServiceTier": "priority",
			"usage": map[string]any{"inputTokens": 1000, "outputTokens": 100}})
	}
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	writeUsageLog(t, path, rows)
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	by := nativeUsageByID(t, h)
	for _, v := range variants {
		a, n := by[attemptID("anthropic/"+v.name, 0)], by[attemptID("anthropic-native/"+v.name, 0)]
		if a.USD == nil || n.USD == nil || *a.USD != *n.USD {
			t.Fatalf("%s: usd anthropic=%v native=%v", v.name, a.USD, n.USD)
		}
		if a.Basis == nil || n.Basis == nil || *a.Basis != *n.Basis {
			t.Fatalf("%s: basis anthropic=%v native=%v", v.name, a.Basis, n.Basis)
		}
		if n.Provider != "anthropic-native" || n.Account != nil {
			t.Fatalf("%s: stored provider/account %q %v", v.name, n.Provider, n.Account)
		}
		var ae, ne int64
		var hasLink bool
		if err := h.db.QueryRow(`SELECT coalesce((SELECT evidence FROM usage_prices WHERE id=?),0)`, a.ID).Scan(&ae); err != nil {
			t.Fatal(err)
		}
		if err := h.db.QueryRow(`SELECT coalesce((SELECT evidence FROM usage_prices WHERE id=?),0)`, n.ID).Scan(&ne); err != nil {
			t.Fatal(err)
		}
		hasLink = ne > 0
		if v.model == "claude-haiku-5-5" && (!hasLink || ae != ne) {
			t.Fatalf("%s: evidence link anthropic=%d native=%d", v.name, ae, ne)
		}
		var ac, nc [2]float64
		if err := h.db.QueryRow(`SELECT fiveMinuteUsd,oneHourUsd FROM claude_cache_costs WHERE id=?`, a.ID).Scan(&ac[0], &ac[1]); err != nil {
			t.Fatalf("%s: anthropic cache cost: %v", v.name, err)
		}
		if err := h.db.QueryRow(`SELECT fiveMinuteUsd,oneHourUsd FROM claude_cache_costs WHERE id=?`, n.ID).Scan(&nc[0], &nc[1]); err != nil {
			t.Fatalf("%s: native cache cost: %v", v.name, err)
		}
		if ac != nc || math.Abs(nc[0]-*n.USD) > 1e-12 || nc[1] <= nc[0] {
			t.Fatalf("%s: cache costs anthropic=%v native=%v usd=%v", v.name, ac, nc, *n.USD)
		}
	}
	// 1000-200-300 uncached at 5, 1000 output at 25, 200 read at .5, 300 write at 6.25.
	if got := by[attemptID("anthropic-native/opus", 0)]; got.USD == nil || math.Abs(*got.USD-(500*5+1000*25+200*.5+300*6.25)/1e6) > 1e-12 {
		t.Fatalf("opus amount %v", got.USD)
	}
	// Haiku 5.5 high tier: 51000*.5 + 1000*2.5 + 90000*.05 + 9000*.625.
	if got := by[attemptID("anthropic-native/haiku-high", 0)]; got.USD == nil || math.Abs(*got.USD-(51000*.5+1000*2.5+90000*.05+9000*.625)/1e6) > 1e-12 {
		t.Fatalf("haiku high amount %v", got.USD)
	}
	// Haiku 5.5 low tier: 35000*.1 + 1000*.5 + 10000*.01 + 5000*.125.
	if got := by[attemptID("anthropic-native/haiku-low", 0)]; got.USD == nil || math.Abs(*got.USD-(35000*.1+1000*.5+10000*.01+5000*.125)/1e6) > 1e-12 {
		t.Fatalf("haiku low amount %v", got.USD)
	}
	for _, provider := range []string{"anthropic", "anthropic-native"} {
		for _, id := range []string{"/priority", "/priority-opus"} {
			if u := by[attemptID(provider+id, 0)]; u.USD != nil {
				t.Fatalf("%s%s priced under a non-default tier: %v", provider, id, *u.USD)
			}
		}
	}
	// Conditional evidence belongs to the tariff's provider.
	var native int
	if err := h.db.QueryRow(`SELECT count(*) FROM price_evidence WHERE provider='anthropic-native'`).Scan(&native); err != nil || native != 0 {
		t.Fatalf("evidence stored under the routing label: %d, %v", native, err)
	}

	// Without an assumption both providers read the 5-minute amount.
	for _, v := range variants {
		for _, provider := range []string{"anthropic", "anthropic-native"} {
			u := by[attemptID(provider+"/"+v.name, 0)]
			var five float64
			if err := h.db.QueryRow(`SELECT fiveMinuteUsd FROM claude_cache_costs WHERE id=?`, u.ID).Scan(&five); err != nil || u.USD == nil || *u.USD != five {
				t.Fatalf("%s/%s: unset assumption %v want %g", provider, v.name, u.USD, five)
			}
		}
	}
	if err := h.SetMeta("claudeCacheAssumption", map[string]any{"ttl": "1h", "from": float64(at)}); err != nil {
		t.Fatal(err)
	}
	by = nativeUsageByID(t, h)
	for _, v := range variants {
		var want [2]float64
		for i, provider := range []string{"anthropic", "anthropic-native"} {
			u := by[attemptID(provider+"/"+v.name, 0)]
			var hour float64
			if err := h.db.QueryRow(`SELECT oneHourUsd FROM claude_cache_costs WHERE id=?`, u.ID).Scan(&hour); err != nil {
				t.Fatal(err)
			}
			if u.USD == nil || *u.USD != hour {
				t.Fatalf("%s/%s: 1h amount %v want %g", provider, v.name, u.USD, hour)
			}
			want[i] = *u.USD
		}
		if want[0] != want[1] {
			t.Fatalf("%s: 1h amounts differ %v", v.name, want)
		}
	}
}

func TestAnthropicNativeReplayFillsOnlyNullRows(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	at := int64(1800000000000)
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	usage := map[string]any{"inputTokens": 100000, "outputTokens": 1000, "cacheReadInputTokens": 90000, "cacheCreationInputTokens": 9000}
	var rows []map[string]any
	for _, id := range []string{"native-a", "native-b", "settled"} {
		provider := "anthropic-native"
		if id == "settled" {
			provider = "anthropic"
		}
		rows = append(rows, map[string]any{"requestId": id, "timestamp": at, "provider": provider, "model": "claude-haiku-5-5", "usage": usage})
		var usd *float64
		var basis = UnknownInputBasis
		if id == "settled" {
			usd, basis = cachePtr(99.0), "official"
		}
		if err := h.InsertUsage(Usage{ID: attemptID(id, 0), At: at, Provider: provider, Model: cachePtr("claude-haiku-5-5"), Input: cachePtr(100000.0), Output: cachePtr(1000.0), Cached: cachePtr(90000.0), Tokens: cachePtr(101000.0), USD: usd, Basis: &basis}); err != nil {
			t.Fatal(err)
		}
	}
	writeUsageLog(t, path, rows)
	evidence, err := h.InsertEvidence(Evidence{Provider: "anthropic", Model: "claude-haiku-5-5", Status: "official", Rates: [4]*float64{cachePtr(7.0), cachePtr(7.0), cachePtr(7.0), cachePtr(7.0)}, FirstRevision: "test", FirstSeenAt: at})
	if err != nil {
		t.Fatal(err)
	}
	settled := attemptID("settled", 0)
	if _, err := h.db.Exec(`INSERT INTO usage_prices(id,evidence,pricedAt) VALUES (?,?,?)`, settled, evidence, at); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(`INSERT INTO claude_cache_costs VALUES (?,98,97,123)`, settled); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(path)
	for key, value := range map[string]any{
		"usageCursor":            map[string]any{"ino": statIno(info), "offset": len(body)},
		"conditionalPriceReplay": "v2-haiku55", "tariffRevision": TariffRevision, "historyResetAt": at,
	} {
		if err := h.SetMeta(key, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h, err = Open(dir, OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	dump := func() string {
		var out []string
		for _, q := range []string{
			`SELECT id||'|'||provider||'|'||coalesce(account,'')||'|'||coalesce(usd,'null')||'|'||coalesce(basis,'') FROM usage ORDER BY id`,
			`SELECT id||'|'||evidence FROM usage_prices ORDER BY id`,
			`SELECT id||'|'||fiveMinuteUsd||'|'||oneHourUsd||'|'||cacheWriteTokens FROM claude_cache_costs ORDER BY id`,
			`SELECT digest||'|'||provider FROM price_evidence ORDER BY id`,
		} {
			r, err := h.db.Query(q)
			if err != nil {
				t.Fatal(err)
			}
			for r.Next() {
				var s string
				if err := r.Scan(&s); err != nil {
					t.Fatal(err)
				}
				out = append(out, s)
			}
			r.Close()
			out = append(out, "--")
		}
		b, _ := json.Marshal(out)
		return string(b)
	}
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	by := nativeUsageByID(t, h)
	// A 100000-token prompt is still the low tier: 1000*.1 + 1000*.5 + 90000*.01 + 9000*.125.
	want := (1000*.1 + 1000*.5 + 90000*.01 + 9000*.125) / 1e6
	for _, id := range []string{"native-a", "native-b"} {
		u := by[attemptID(id, 0)]
		if u.USD == nil || math.Abs(*u.USD-want) > 1e-12 || u.Basis == nil || *u.Basis != "local-catalog" || u.Provider != "anthropic-native" || u.Account != nil {
			t.Fatalf("%s not filled: usd=%v basis=%v want %g", id, *u.USD, *u.Basis, want)
		}
		var link int
		if err := h.db.QueryRow(`SELECT count(*) FROM usage_prices WHERE id=?`, u.ID).Scan(&link); err != nil || link != 1 {
			t.Fatalf("%s evidence link: %d %v", id, link, err)
		}
	}
	s := by[settled]
	var kept int64
	var five, hour, write float64
	if s.USD == nil || *s.USD != 99 || s.Basis == nil || *s.Basis != "official" {
		t.Fatalf("settled amount changed: %+v", s)
	}
	if err := h.db.QueryRow(`SELECT evidence FROM usage_prices WHERE id=?`, settled).Scan(&kept); err != nil || kept != evidence {
		t.Fatalf("settled evidence link %d want %d: %v", kept, evidence, err)
	}
	if err := h.db.QueryRow(`SELECT fiveMinuteUsd,oneHourUsd,cacheWriteTokens FROM claude_cache_costs WHERE id=?`, settled).Scan(&five, &hour, &write); err != nil || five != 98 || hour != 97 || write != 123 {
		t.Fatalf("settled cache cost %g %g %g: %v", five, hour, write, err)
	}
	first := dump()
	if n, err := h.IngestJSONL(path, at); err != nil || n != 0 {
		t.Fatalf("second ingest read %d rows: %v", n, err)
	}
	if again := dump(); again != first {
		t.Fatalf("second ingest changed the store:\n%s\n%s", first, again)
	}
}

func TestAnthropicNativeNeverGetsAnAccount(t *testing.T) {
	h := openTemp(t)
	home := t.TempDir()
	sum := sha256.Sum256([]byte("acct1"))
	label := "p" + hex.EncodeToString(sum[:])[:6]
	if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"anthropic":{"accounts":[{"id":"acct1"}]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	at := int64(1800000000000)
	usage := map[string]any{"inputTokens": 1000, "outputTokens": 100}
	path := filepath.Join(home, "usage.jsonl")
	writeUsageLog(t, path, []map[string]any{
		{"requestId": "pool", "timestamp": at, "provider": "anthropic-" + label, "model": "claude-haiku-5-5", "usage": usage},
		{"requestId": "native-label", "timestamp": at, "provider": "anthropic-native", "accountLogLabel": label, "model": "claude-haiku-5-5", "usage": usage},
		{"requestId": "native-suffix", "timestamp": at, "provider": "anthropic-native-" + label, "model": "claude-haiku-5-5", "usage": usage},
	})
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	by := nativeUsageByID(t, h)
	if p := by[attemptID("pool", 0)]; p.Provider != "anthropic" || p.Account == nil || *p.Account != "acct1" || p.USD == nil {
		t.Fatalf("pool row lost its account: %+v", p)
	}
	for _, id := range []string{"native-label", "native-suffix"} {
		u := by[attemptID(id, 0)]
		if u.Provider != "anthropic-native" || u.Account != nil || u.USD == nil {
			t.Fatalf("%s: %+v", id, u)
		}
	}
}

func TestOCXAliasModelsAreNotPricedWithAnthropicTariffs(t *testing.T) {
	h := openTemp(t)
	// Even a catalog row and an evidence row named after the alias itself must not value it.
	c, err := ParseCatalog([]byte(`{"anthropic":{"models":{"ocx-claude-native--gpt-6-astra":{"id":"ocx-claude-native--gpt-6-astra","cost":{"input":5,"output":25,"cache_read":0.5,"cache_write":6.25}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	h.SetCatalog(c)
	at := int64(1800000000000)
	// An Anthropic tariff for the real model name would be visibly different from the OpenAI one.
	for _, model := range []string{"gpt-6.1-sol", "ocx-claude-native--gpt-6.1-sol"} {
		if _, err := h.InsertEvidence(Evidence{Provider: "anthropic", Model: model, Status: "official", Rates: [4]*float64{cachePtr(100.0), cachePtr(100.0), cachePtr(100.0), cachePtr(100.0)}, FirstRevision: "test", FirstSeenAt: at}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.InsertEvidence(Evidence{Provider: "openai", Model: "gpt-6.1-sol", Status: "official", Rates: [4]*float64{cachePtr(2.0), cachePtr(10.0), cachePtr(.2), cachePtr(2.5)}, FirstRevision: "test", FirstSeenAt: at}); err != nil {
		t.Fatal(err)
	}
	usage := map[string]any{"inputTokens": 1000, "outputTokens": 100}
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	writeUsageLog(t, path, []map[string]any{
		{"requestId": "alias-openai", "timestamp": at, "provider": "openai-pb5641b", "model": "gpt-6.1-sol", "requestedModel": "ocx-claude-native--gpt-6.1-sol", "surface": "claude", "usage": usage},
		{"requestId": "alias-native", "timestamp": at, "provider": "anthropic-native", "model": "ocx-claude-native--gpt-6.1-sol", "usage": usage},
		{"requestId": "alias-astra", "timestamp": at, "provider": "anthropic-native", "model": "ocx-claude-native--gpt-6-astra", "usage": usage},
		{"requestId": "alias-anthropic", "timestamp": at, "provider": "anthropic", "model": "ocx-claude-native--gpt-6.1-sol", "usage": usage},
	})
	if _, err := h.IngestJSONL(path, at); err != nil {
		t.Fatal(err)
	}
	by := nativeUsageByID(t, h)
	if u := by[attemptID("alias-openai", 0)]; u.Provider != "openai" || u.USD == nil || math.Abs(*u.USD-(1000*2+100*10)/1e6) > 1e-12 {
		t.Fatalf("OCX-recorded provider/model not priced as such: %+v", u)
	}
	for _, id := range []string{"alias-native", "alias-astra", "alias-anthropic"} {
		if u := by[attemptID(id, 0)]; u.USD != nil || !strings.HasPrefix(u.Provider, "anthropic") {
			t.Fatalf("%s priced from an alias name: %+v", id, u)
		}
	}
}

func TestCatalogRevisionFollowsAnthropicNativeModels(t *testing.T) {
	h := openTemp(t)
	if err := h.InsertUsage(Usage{ID: "n", At: 1, Provider: "anthropic-native", Model: cachePtr("claude-opus-5-5")}); err != nil {
		t.Fatal(err)
	}
	c, err := ParseCatalog([]byte(nativeCatalog))
	if err != nil {
		t.Fatal(err)
	}
	h.SetCatalog(c)
	_, rev := h.catalogForIngest()
	changed, err := ParseCatalog([]byte(`{"anthropic":{"models":{"claude-opus-5-5":{"id":"claude-opus-5-5","cost":{"input":6,"output":25,"cache_read":0.5,"cache_write":7.5}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	h.SetCatalog(changed)
	_, next := h.catalogForIngest()
	if rev == next || rev == "" {
		t.Fatalf("anthropic-native rows ignore a changed Anthropic catalog price: %q %q", rev, next)
	}
}
