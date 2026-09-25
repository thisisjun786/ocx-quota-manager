package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestBinaryRosterSnapshotNoDirect(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(t.TempDir(), "quota-manager")
	build := exec.Command("go", "build", "-o", exe, ".")
	build.Dir = filepath.Join(root, "cmd/quota-manager")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %s\n%s", err, out)
	}
	home := t.TempDir()
	native := filepath.Join(home, "native")
	if err := os.Mkdir(native, 0o700); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("opencodex-main-quota-v1\x00physical"))
	hash := hex.EncodeToString(sum[:])
	mustWrite(t, filepath.Join(home, "config.json"), `{"providers":{"openai":{},"anthropic":{},"ollama-cloud":{"apiKey":"SECRET_SENTINEL","apiKeyPool":[{"id":"k1","key":"SECRET_SENTINEL"}]}},"codexAccounts":[{"id":"pool1","email":"someone@example.com","plan":"pro"}],"activeCodexAccountId":"pool1"}`)
	mustWrite(t, filepath.Join(home, "auth.json"), `{"anthropic":{"activeAccountId":"a1","accounts":[{"id":"a1","credential":{"access":"SECRET_SENTINEL"}},{"id":"a2","credential":{"access":"SECRET_SENTINEL"}}]}}`)
	mustWrite(t, filepath.Join(home, "codex-accounts.json"), `{"pool1":{"credential":{"accessToken":"SECRET_SENTINEL"}}}`)
	mustWrite(t, filepath.Join(home, "codex-quota-cache.json"), `{"version":1,"quotas":{"pool1":{"updatedAt":1800000000000,"weeklyPercent":80,"weeklyResetAt":1800003600}},"mainPolicyQuota":{"identityKey":"`+hash+`","quota":{"updatedAt":1800000000000,"weeklyPercent":0}}}`)
	mustWrite(t, filepath.Join(home, "provider-account-quota-cache.json"), `{"version":1,"rows":{"anthropic\u0000a1":{"updatedAt":1800000000000,"fiveHourPercent":100,"fiveHourResetAt":1800003600000},"anthropic\u0000a2":{"updatedAt":1774800000000,"weeklyPercent":23}}}`)
	mustWrite(t, filepath.Join(native, "auth.json"), `{"tokens":{"account_id":"physical","access_token":"SECRET_SENTINEL"}}`)

	var addr string
	var cmd *exec.Cmd
	for port := 19210; port < 19240; port++ {
		cmd = exec.Command(exe)
		cmd.Env = append(os.Environ(),
			"OPENCODEX_HOME="+home,
			"QUOTA_CODEX_HOME="+native,
			"QUOTA_CLAUDE_HOME="+filepath.Join(home, "noclaude"),
			"QUOTA_DATA_DIR="+t.TempDir(),
			"QUOTA_HOST=127.0.0.1",
			"QUOTA_PORT="+strconv.Itoa(port),
			"QUOTA_DIRECT_PROVIDERS=",
		)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(3 * time.Second)
		ok := false
		for time.Now().Before(deadline) {
			res, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/healthz")
			if err == nil {
				_, _ = io.Copy(io.Discard, res.Body)
				res.Body.Close()
				if res.StatusCode == 200 {
					ok = true
					addr = "127.0.0.1:" + strconv.Itoa(port)
					break
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		if ok {
			break
		}
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		cmd = nil
	}
	if cmd == nil || addr == "" {
		t.Fatal("binary did not listen")
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})
	deadline := time.Now().Add(3 * time.Second)
	var snap map[string]any
	for time.Now().Before(deadline) {
		req, err := http.NewRequest(http.MethodGet, "http://"+addr+"/api/v1/snapshot", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = addr
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if json.Unmarshal(body, &snap) != nil {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		providers, _ := snap["providers"].([]any)
		if len(providers) == 3 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	raw, _ := json.Marshal(snap)
	if string(raw) == "" || !bytes.Contains(raw, []byte(`"openai"`)) {
		t.Fatalf("snapshot %+v", snap)
	}
	if bytes.Contains(raw, []byte("SECRET_SENTINEL")) {
		t.Fatal("secret leaked from binary")
	}
	providers, _ := snap["providers"].([]any)
	if len(providers) != 3 {
		t.Fatalf("providers %d", len(providers))
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}
