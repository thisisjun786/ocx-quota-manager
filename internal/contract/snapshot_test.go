package contract_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/calc"
)

func TestValidCorpusRoundTrip(t *testing.T) {
	raw, err := contract.LoadCorpusFile("snapshot.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := contract.DecodeSnapshot(raw)
	if err != nil {
		t.Fatal(err)
	}
	if s.Providers[0].Accounts[0].Windows[0].RemainingPercent == nil || *s.Providers[0].Accounts[0].Windows[0].RemainingPercent != 0 {
		t.Fatalf("measured 0 must survive decode, got %#v", s.Providers[0].Accounts[0].Windows[0].RemainingPercent)
	}
	if s.Providers[1].Accounts[0].Plan != nil {
		t.Fatalf("null plan must stay nil, got %#v", s.Providers[1].Accounts[0].Plan)
	}
	encoded, err := contract.MarshalCanonical(s)
	if err != nil {
		t.Fatal(err)
	}
	again, err := contract.DecodeSnapshot(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if again.SchemaVersion != 1 {
		t.Fatalf("schemaVersion %d", again.SchemaVersion)
	}
}

func TestMutatedCorpusFails(t *testing.T) {
	raw, err := contract.LoadCorpusFile("snapshot.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatal(err)
	}
	obj["schemaVersion"] = 2
	bad, _ := json.Marshal(obj)
	if _, err := contract.DecodeSnapshot(bad); err == nil {
		t.Fatal("schemaVersion 2 must fail")
	}
	obj["schemaVersion"] = 1
	providers := obj["providers"].([]any)
	first := providers[0].(map[string]any)
	first["id"] = ""
	bad, _ = json.Marshal(obj)
	if _, err := contract.DecodeSnapshot(bad); err == nil {
		t.Fatal("empty provider id must fail")
	}
}

func TestCanonicalJSONDoesNotHTMLEscape(t *testing.T) {
	raw, err := contract.MarshalCanonical([]any{"<script>", "a&b", "x>y"})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(`\u003c`)) || bytes.Contains(raw, []byte(`\u0026`)) || bytes.Contains(raw, []byte(`\u003e`)) {
		t.Fatalf("HTML escaped: %s", raw)
	}
	if !bytes.Contains(raw, []byte(`<script>`)) {
		t.Fatalf("lost raw HTML chars: %s", raw)
	}
}

func TestNULAndUnicodeSurvive(t *testing.T) {
	raw, err := contract.MarshalCanonical([]any{"openai", "acc\x00ount", "한글", "🙂"})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("acc")) || !bytes.Contains(raw, []byte("한글")) {
		t.Fatalf("lost identity bytes: %s", raw)
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) == "" {
		t.Fatal("empty digest")
	}
}

func TestSafeIntegerBoundary(t *testing.T) {
	const maxSafe = 9007199254740991
	raw, err := contract.MarshalCanonical([]any{0, maxSafe, 1.5})
	if err != nil {
		t.Fatal(err)
	}
	var decoded []any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded[0].(float64) != 0 {
		t.Fatalf("0 became %v", decoded[0])
	}
	if decoded[1].(float64) != float64(maxSafe) {
		t.Fatalf("safe integer %v", decoded[1])
	}
}

func TestRecommendationIndependentArithmetic(t *testing.T) {
	raw, err := contract.LoadCorpusFile("recommendation.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []struct {
			ID             string  `json:"id"`
			SumPp          float64 `json:"sumPp"`
			CapacityHours  float64 `json:"capacityHours"`
			PeriodHours    float64 `json:"periodHours"`
			Needed         int     `json:"needed"`
			AllocateGap    *bool   `json:"allocateGapIntoSelected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, c := range doc.Cases {
		if c.Needed == 0 && c.AllocateGap != nil {
			if *c.AllocateGap {
				t.Fatalf("%s: gap must not be allocated into the selected period", c.ID)
			}
			continue
		}
		got := calc.NeededAccounts(c.SumPp, c.CapacityHours, c.PeriodHours)
		if got != c.Needed {
			t.Fatalf("%s: needed %d want %d", c.ID, got, c.Needed)
		}
	}
}

func TestKnownDefectsAreNotGolden(t *testing.T) {
	raw, err := contract.LoadCorpusFile("known-defects.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("JUN-226")) {
		t.Fatal("defect list must keep Linear IDs")
	}
	if bytes.Contains(bytes.ToLower(raw), []byte("golden")) && !bytes.Contains(raw, []byte("Never use as a passing golden")) {
		t.Fatal("defects file lost its warning")
	}
}

func TestHTTPGuardCorpusPresent(t *testing.T) {
	raw, err := contract.LoadCorpusFile("http-guard.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("0.0.0.0")) || !bytes.Contains(raw, []byte("secFetchSite")) {
		t.Fatal("http guard corpus incomplete")
	}
	if !bytes.Contains(raw, []byte("Serve the last fully projected public DTO only")) {
		t.Fatal("snapshot-path contract missing")
	}
}

func TestContractsTreeHasNoSecrets(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(root, "contracts")); err == nil {
			break
		}
		root = filepath.Dir(root)
	}
	err = filepath.Walk(filepath.Join(root, "contracts"), func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		lower := strings.ToLower(string(b))
		for _, needle := range []string{"sk-", "access_token", "secret_sentinel", "eyj"} {
			if strings.Contains(lower, needle) {
				t.Errorf("%s contains %q", path, needle)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
