package collect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// Explicit opt-in only; prints safe transport metadata and decoded field names,
// never tokens, account identifiers, or response bodies.
func TestLiveProviderProbe(t *testing.T) {
	if os.Getenv("QUOTA_LIVE_PROBE") != "1" {
		t.Skip("explicit live quota read only")
	}
	local, err := (Reader{Home: os.Getenv("OPENCODEX_HOME"), CodexHome: os.Getenv("QUOTA_CODEX_HOME")}).LoadLocal(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	tr := NewHTTPSTransport()
	adapters := append(Adapters(), ollamaAdapter())
	type receipt struct {
		Provider, Account, Endpoint string
		Status                      int
		Kind                        string
		Fields                      []string
		Windows                     int
	}
	var out []receipt
	for _, b := range local.Bindings {
		if !b.Enabled || (os.Getenv("QUOTA_LIVE_PROVIDER") != "" && b.Provider != os.Getenv("QUOTA_LIVE_PROVIDER")) {
			continue
		}
		sum := sha256.Sum256([]byte(b.AccountID))
		id := hex.EncodeToString(sum[:6])
		for _, ad := range adapters {
			if ad.Provider() != b.Provider {
				continue
			}
			req, ok := quotaRequest(b, ad)
			if !ok {
				out = append(out, receipt{Provider: b.Provider, Account: id, Endpoint: ad.EndpointID(), Kind: "credential guard"})
				continue
			}
			res, err := tr.Do(context.Background(), req)
			r := receipt{Provider: b.Provider, Account: id, Endpoint: ad.EndpointID(), Status: res.Status}
			if err != nil {
				r.Kind = "transport error"
			} else {
				var obj map[string]any
				if json.Unmarshal(res.Body, &obj) == nil {
					for key := range obj {
						r.Fields = append(r.Fields, key)
					}
				}
				rows, e := ad.Parse(res.Body, time.Now().UnixMilli())
				if e != nil {
					r.Kind = "parse error"
				}
				for _, w := range rows {
					if w.Kind == WindowOK && w.UsedPercent != nil {
						r.Windows++
					}
				}
			}
			out = append(out, r)
		}
	}
	data, _ := json.MarshalIndent(out, "", "  ")
	if path := os.Getenv("QUOTA_LIVE_RECEIPT"); path != "" {
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Log(string(data))
}
