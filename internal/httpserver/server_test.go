package httpserver

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
)

func fixtureSnap() contract.Snapshot {
	now := "2027-01-15T08:00:00.000Z"
	return contract.Snapshot{
		SchemaVersion: 1,
		ObservedAt:    &now,
		Providers:     []contract.Provider{},
	}
}

func start(t *testing.T, snap contract.Snapshot) *Server {
	t.Helper()
	pub := fstest.MapFS{"index.html": {Data: []byte("<html>ok</html>")}}
	s, err := New(Options{Host: "127.0.0.1", Port: 18787, Public: pub, Snapshot: func() contract.Snapshot { return snap }})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Listen(); err != nil {
		// port may be taken; retry with 0 via listen error — use another port
		s, err = New(Options{Host: "127.0.0.1", Port: 18788, Public: pub, Snapshot: func() contract.Snapshot { return snap }})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.Listen(); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func get(t *testing.T, s *Server, path string, hdr http.Header) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, "http://"+s.Addr()+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = s.Addr()
	for k, vs := range hdr {
		for _, v := range vs {
			req.Header.Set(k, v)
		}
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestHealthAndSnapshot(t *testing.T) {
	s := start(t, fixtureSnap())
	res := get(t, s, "/healthz", nil)
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("health %d", res.StatusCode)
	}
	res = get(t, s, "/api/v1/snapshot", nil)
	defer res.Body.Close()
	var snap contract.Snapshot
	if err := json.NewDecoder(res.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	if snap.SchemaVersion != 1 {
		t.Fatalf("%+v", snap)
	}
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("cache")
	}
}

func TestRejectsBadHostOriginPostTraversal(t *testing.T) {
	s := start(t, fixtureSnap())
	req, _ := http.NewRequest(http.MethodGet, "http://"+s.Addr()+"/api/v1/snapshot", nil)
	req.Host = "evil.example"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("host %d", res.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodGet, "http://"+s.Addr()+"/api/v1/snapshot", nil)
	req.Host = s.Addr()
	req.Header.Set("Origin", "https://evil.example")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("origin %d", res.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodGet, "http://"+s.Addr()+"/api/v1/snapshot", nil)
	req.Host = s.Addr()
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("sec-fetch %d", res.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodPost, "http://"+s.Addr()+"/api/v1/snapshot", strings.NewReader(`{}`))
	req.Host = s.Addr()
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 405 || res.Header.Get("Allow") != "GET" {
		t.Fatalf("post %d allow=%s", res.StatusCode, res.Header.Get("Allow"))
	}

	req, _ = http.NewRequest(http.MethodGet, "http://"+s.Addr()+"/../etc/passwd", nil)
	req.Host = s.Addr()
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("traversal %d %s", res.StatusCode, body)
	}
}

func TestBindRules(t *testing.T) {
	if err := AllowedBind("8.8.8.8", 8787); err == nil {
		t.Fatal("public bind")
	}
	if err := AllowedBind("127.0.0.1", 80); err == nil {
		t.Fatal("privileged")
	}
	if err := AllowedBind("100.64.1.2", 8787); err != nil {
		t.Fatal(err)
	}
	if _, err := CheckPublicOrigin("100.64.1.2", "https://box.ts.net/"); err == nil {
		t.Fatal("origin requires loopback backend")
	}
	if _, err := CheckPublicOrigin("127.0.0.1", "https://box.ts.net/"); err != nil {
		t.Fatal(err)
	}
}

func TestStaticAllowlist(t *testing.T) {
	s := start(t, fixtureSnap())
	res := get(t, s, "/", nil)
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("index %d", res.StatusCode)
	}
	res = get(t, s, "/secret.txt", nil)
	defer res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("secret %d", res.StatusCode)
	}
}

func TestRequiredModulesAndExtensionless404(t *testing.T) {
	pub := fstest.MapFS{
		"index.html":  {Data: []byte("<html>ok</html>")},
		"app.js":      {Data: []byte("export {}\n")},
		"format.js":   {Data: []byte("export {}\n")},
		"quota.js":    {Data: []byte("export {}\n")},
		"dom.js":      {Data: []byte("export {}\n")},
		"views.js":    {Data: []byte("export {}\n")},
		"types.js":    {Data: []byte("export {}\n")},
		"contract.js": {Data: []byte("export {}\n")},
		"style.css":   {Data: []byte("body{}\n")},
	}
	s, err := New(Options{Host: "127.0.0.1", Port: 18790, Public: pub, Snapshot: func() contract.Snapshot { return fixtureSnap() }})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Listen(); err != nil {
		s, err = New(Options{Host: "127.0.0.1", Port: 18796, Public: pub, Snapshot: func() contract.Snapshot { return fixtureSnap() }})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.Listen(); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _ = s.Close() })
	for _, path := range []string{"/", "/app.js", "/format.js", "/quota.js", "/dom.js", "/views.js", "/types.js", "/contract.js", "/style.css"} {
		res := get(t, s, path, nil)
		if res.StatusCode != 200 {
			res.Body.Close()
			t.Fatalf("%s %d", path, res.StatusCode)
		}
		res.Body.Close()
	}
	for _, path := range []string{"/format", "/quota", "/dom", "/views", "/contract", "/types"} {
		res := get(t, s, path, nil)
		if res.StatusCode != 404 {
			res.Body.Close()
			t.Fatalf("extensionless %s %d", path, res.StatusCode)
		}
		res.Body.Close()
	}
}

func TestSnapshotAnyKeepsUIFields(t *testing.T) {
	s, err := New(Options{
		Host: "127.0.0.1", Port: 18797,
		Public: fstest.MapFS{"index.html": {Data: []byte("ok")}},
		SnapshotAny: func() any {
			return map[string]any{
				"schemaVersion": 1,
				"providers":     []any{},
				"refresh":       map[string]any{"status": "ok"},
				"directQuota":   map[string]any{"status": "ok"},
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	res := get(t, s, "/api/v1/snapshot", nil)
	defer res.Body.Close()
	var raw map[string]any
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	if raw["refresh"] == nil || raw["directQuota"] == nil {
		t.Fatalf("ui fields dropped: %+v", raw)
	}
}

func TestSnapshotDoesNotWait(t *testing.T) {
	started := make(chan struct{})
	s, err := New(Options{
		Host: "127.0.0.1", Port: 18789,
		Snapshot: func() contract.Snapshot {
			close(started)
			return fixtureSnap()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	done := make(chan *http.Response, 1)
	go func() {
		req, _ := http.NewRequest(http.MethodGet, "http://"+s.Addr()+"/api/v1/snapshot", nil)
		req.Host = s.Addr()
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Error(err)
			done <- nil
			return
		}
		done <- res
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("handler never read last-good")
	}
	res := <-done
	if res != nil {
		res.Body.Close()
	}
}

func TestPublicOriginOptionalRootSlash(t *testing.T) {
	for _, origin := range []string{"https://box.ts.net:10105", "https://box.ts.net:10105/"} {
		if _, err := CheckPublicOrigin("127.0.0.1", origin); err != nil {
			t.Fatal(origin, err)
		}
	}
	for _, origin := range []string{"https://box.ts.net/path", "https://box.ts.net/?x=1", "http://box.ts.net", "https://evil.example", "https://user@box.ts.net"} {
		if _, err := CheckPublicOrigin("127.0.0.1", origin); err == nil {
			t.Fatal("accepted unsafe origin", origin)
		}
	}
}
