package store

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"testing"
)

func fp(v float64) *float64 { return &v }

func floatsEqual(a, b float64) bool {
	tol := 1e-9 * math.Max(math.Abs(a), math.Abs(b))
	if tol < 1e-9 {
		tol = 1e-9
	}
	return math.Abs(a-b) <= tol
}

func insertRawEvidence(t *testing.T, h *History, digest, rates string) {
	t.Helper()
	_, err := h.DB().Exec(`INSERT INTO price_evidence
		(digest,provider,model,status,rates,conditions,unsupported,firstRevision,firstSeenAt)
		VALUES (?,?,?,?,?,?,?,?,?)`,
		digest, "openai", "gpt-5.4", "official", rates, "[]", "[]", "1", 1_800_000_000_000)
	if err != nil {
		t.Fatal(err)
	}
}

func TestListEvidenceReadsNodeObjectAndLegacyArray(t *testing.T) {
	h := openTemp(t)
	// Node stores the canonical object; null members mean an unknown rate.
	insertRawEvidence(t, h, "digest-object", `{"input":1.25,"output":10,"cacheRead":null,"cacheWrite":3}`)
	// Older writers stored the fixed-position array of length 4.
	insertRawEvidence(t, h, "digest-array", `[1.25,10,0.125,3]`)
	rows, err := h.ListEvidence()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows %d", len(rows))
	}
	object, legacy := rows[0], rows[1]
	if object.ID != 1 || legacy.ID != 2 {
		t.Fatalf("ids %d %d", object.ID, legacy.ID)
	}
	if object.Rates[0] == nil || !floatsEqual(*object.Rates[0], 1.25) ||
		object.Rates[1] == nil || !floatsEqual(*object.Rates[1], 10) ||
		object.Rates[2] != nil ||
		object.Rates[3] == nil || !floatsEqual(*object.Rates[3], 3) {
		t.Fatalf("object rates %v", object.Rates)
	}
	for i, want := range []float64{1.25, 10, 0.125, 3} {
		if legacy.Rates[i] == nil || !floatsEqual(*legacy.Rates[i], want) {
			t.Fatalf("legacy rates[%d] %v", i, legacy.Rates[i])
		}
	}
}

func TestDecodeRatesRejectsMalformed(t *testing.T) {
	for name, raw := range map[string]string{
		"top-null":       "null",
		"negative":       `{"input":-1}`,
		"string":         `{"output":"5"}`,
		"array-length":   `[1,2,3]`,
		"nonfinite":      "1e999",
		"array-negative": `[1,2,-3,4]`,
	} {
		if _, err := decodeRates(raw); err == nil {
			t.Fatalf("%s: want error", name)
		}
	}
	// Null members are unknown rates, not errors.
	if _, err := decodeRates(`{"input":null,"output":0,"cacheRead":0.5,"cacheWrite":null}`); err != nil {
		t.Fatalf("null members: %v", err)
	}
}

func TestListEvidenceRejectsMalformedRow(t *testing.T) {
	h := openTemp(t)
	insertRawEvidence(t, h, "digest-bad", `{"input":-1}`)
	if _, err := h.ListEvidence(); err == nil {
		t.Fatal("want error for malformed rates row")
	}
}

func TestInsertEvidenceWritesObjectAndReusesLegacyDigest(t *testing.T) {
	h := openTemp(t)
	e := Evidence{
		Provider: "openai", Model: "gpt-5.4", Status: "official",
		Rates:         [4]*float64{fp(1.25), fp(10), nil, fp(3)},
		FirstRevision: "1", FirstSeenAt: 1_800_000_000_000,
	}
	digest, err := EvidenceDigest(e)
	if err != nil {
		t.Fatal(err)
	}
	// The same content as an older row in legacy array form keeps that row's id.
	insertRawEvidence(t, h, digest, `[1.25,10,null,3]`)
	id, err := h.InsertEvidence(e)
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM price_evidence").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("price_evidence rows %d, want 1 (legacy digest reused)", n)
	}
	var stored string
	if err := h.db.QueryRow("SELECT rates FROM price_evidence WHERE id=?", id).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != `[1.25,10,null,3]` {
		t.Fatalf("reused legacy row must keep its stored text, got %s", stored)
	}
	if id2, err := h.InsertEvidence(e); err != nil || id2 != id {
		t.Fatalf("re-insert id %d err %v", id2, err)
	}
	// New content is written in the canonical object form.
	next := e
	next.Rates = [4]*float64{fp(1.25), fp(10), fp(0.125), fp(3)}
	if _, err := h.InsertEvidence(next); err != nil {
		t.Fatal(err)
	}
	var storedObject string
	if err := h.db.QueryRow("SELECT rates FROM price_evidence WHERE digest=?", func() string { d, _ := EvidenceDigest(next); return d }()).Scan(&storedObject); err != nil {
		t.Fatal(err)
	}
	if storedObject != `{"input":1.25,"output":10,"cacheRead":0.125,"cacheWrite":3}` {
		t.Fatalf("stored rates %s", storedObject)
	}
}

func TestInsertEvidenceRejectsMalformedConflict(t *testing.T) {
	h := openTemp(t)
	base := Evidence{Provider: "openai", Model: "gpt-5.4", Status: "official", FirstRevision: "1", FirstSeenAt: 1_800_000_000_000}
	bad := []Evidence{
		{Conflict: "reference"},
		{Conflict: []any{"reference", []any{1.0, 2.0, nil, 5.0}, "why"}},
		{Conflict: map[string]any{"status": 5}},
		{Conflict: map[string]any{"rates": "no"}},
		{Conflict: map[string]any{"rates": map[string]any{"input": -1.0}}},
	}
	for i, e := range bad {
		e.Provider, e.Model, e.Status, e.FirstRevision, e.FirstSeenAt = base.Provider, base.Model, base.Status, base.FirstRevision, base.FirstSeenAt
		if _, err := h.InsertEvidence(e); err == nil {
			t.Fatalf("case %d: want error", i)
		}
	}
	good := base
	good.Conflict = map[string]any{"status": "reference", "rates": map[string]any{"input": float64(5), "output": float64(50)}, "reason": "why"}
	if _, err := h.InsertEvidence(good); err != nil {
		t.Fatalf("contract-shaped conflict: %v", err)
	}
}

func TestEvidenceDigestMatchesNodeCanonicalPayload(t *testing.T) {
	e := Evidence{
		Provider: "openai", Model: "gpt-5.4", Status: "official",
		SourceURL: strPtr("https://x/y"), CheckedAt: strPtr("2026-09-21T00:00:00Z"),
		Rates:          [4]*float64{fp(1.25), fp(10), fp(0.125), fp(3)},
		TierMultiplier: fp(1),
		Conditions:     []string{"b", "a"},
		Conflict: map[string]any{
			"status": "reference",
			"rates":  map[string]any{"input": float64(5), "output": float64(50), "cacheRead": nil, "cacheWrite": float64(5)},
			"reason": "why",
		},
		FirstRevision: "1", FirstSeenAt: 1_800_000_000_000,
	}
	payload := `["openai","gpt-5.4","official","https://x/y","2026-09-21T00:00:00Z",null,null,[1.25,10,0.125,3],1,["a","b"],[],["reference",[5,50,null,5],"why"],null]`
	sum := sha256.Sum256([]byte(payload))
	want := hex.EncodeToString(sum[:])
	got, err := EvidenceDigest(e)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("digest %s want %s", got, want)
	}
}

func TestUsageValuationCutoff(t *testing.T) {
	h := openTemp(t)
	account := "acc-1"
	for _, u := range []Usage{
		{ID: "u1", At: 1_000_000_000_000, Provider: "anthropic", Account: &account, USD: fp(1), Basis: strPtr("catalog")},
		{ID: "u2", At: 2_000_000_000_000, Provider: "anthropic", Account: &account, USD: fp(1), Basis: strPtr("catalog")},
		{ID: "u3", At: 2_500_000_000_000, Provider: "cursor", Account: &account, USD: fp(1), Basis: strPtr("catalog")},
	} {
		if err := h.InsertUsage(u); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.DB().Exec("INSERT INTO claude_cache_costs VALUES ('u2',0.9,1.1,500)"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.DB().Exec("INSERT INTO cursor_cache_costs VALUES ('u3',2,1,1000)"); err != nil {
		t.Fatal(err)
	}
	if err := h.SetMeta("claudeCacheAssumption", map[string]any{"ttl": "1h", "from": 1_500_000_000_000.0}); err != nil {
		t.Fatal(err)
	}
	if err := h.SetMeta("cursorCacheReference", map[string]any{"appliedRate": 0.5}); err != nil {
		t.Fatal(err)
	}
	rows, err := h.ListUsage()
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]Usage{}
	for _, u := range rows {
		byID[u.ID] = u
	}
	u1 := byID["u1"]
	if u1.USD == nil || !floatsEqual(*u1.USD, 1) || u1.Basis == nil || *u1.Basis != "catalog" ||
		u1.CacheEstimated || u1.EstimatedCachedTokens != 0 || u1.NoCacheUSD == nil || !floatsEqual(*u1.NoCacheUSD, 1) {
		t.Fatalf("u1 before cutoff %+v", u1)
	}
	u2 := byID["u2"]
	if u2.USD == nil || !floatsEqual(*u2.USD, 1.1) || u2.Basis == nil || *u2.Basis != "local-catalog" ||
		u2.CacheEstimated || u2.EstimatedCachedTokens != 0 || u2.NoCacheUSD == nil || !floatsEqual(*u2.NoCacheUSD, 1.1) {
		t.Fatalf("u2 at/after cutoff (claude keeps cacheEstimated false) %+v", u2)
	}
	u3 := byID["u3"]
	if u3.USD == nil || !floatsEqual(*u3.USD, 1.5) || u3.Basis == nil || *u3.Basis != "local-catalog" ||
		!u3.CacheEstimated || !floatsEqual(u3.EstimatedCachedTokens, 500) || u3.NoCacheUSD == nil || !floatsEqual(*u3.NoCacheUSD, 2) {
		t.Fatalf("u3 cursor valuation %+v", u3)
	}
}
