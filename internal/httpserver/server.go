package httpserver

import (
	"context"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
)

const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

var staticFiles = map[string]string{
	"/":            "index.html",
	"/index.html":  "index.html",
	"/app.js":      "app.js",
	"/format.js":   "format.js",
	"/quota.js":    "quota.js",
	"/dom.js":      "dom.js",
	"/views.js":    "views.js",
	"/types.js":    "types.js",
	"/contract.js": "contract.js",
	"/style.css":   "style.css",
}

type SnapshotFn func() contract.Snapshot

type Options struct {
	Host          string
	Port          int
	PublicOrigin  string
	Public        fs.FS
	Snapshot      SnapshotFn
	// SnapshotAny is a test-only hook that serves a raw JSON value so UI fields
	// the public DTO does not keep (refresh, directQuota, usedPercent) survive.
	SnapshotAny func() any
	Now         func() time.Time
}

type Server struct {
	HTTP   *http.Server
	ln     net.Listener
	opts   Options
	origin *url.URL
}

func New(opts Options) (*Server, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if err := AllowedBind(opts.Host, opts.Port); err != nil {
		return nil, err
	}
	origin, err := CheckPublicOrigin(opts.Host, opts.PublicOrigin)
	if err != nil {
		return nil, err
	}
	s := &Server{opts: opts, origin: origin}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.serve)
	s.HTTP = &http.Server{
		Addr:              net.JoinHostPort(opts.Host, strconv.Itoa(opts.Port)),
		Handler:           mux,
		ReadTimeout:       10 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       5 * time.Second,
	}
	return s, nil
}

func (s *Server) Listen() error {
	ln, err := net.Listen("tcp", s.HTTP.Addr)
	if err != nil {
		return err
	}
	s.ln = ln
	s.HTTP.Addr = ln.Addr().String()
	go func() { _ = s.HTTP.Serve(ln) }()
	return nil
}

func (s *Server) Addr() string {
	if s.ln != nil {
		return s.ln.Addr().String()
	}
	return s.HTTP.Addr
}

func (s *Server) Close() error {
	return s.HTTP.Close()
}

// Shutdown stops accepting connections and lets in-flight requests finish
// until ctx expires, then closes whatever is left.
func (s *Server) Shutdown(ctx context.Context) error {
	if err := s.HTTP.Shutdown(ctx); err != nil {
		_ = s.HTTP.Close()
		return err
	}
	return nil
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", csp)

	host, port, _ := net.SplitHostPort(s.Addr())
	expected := net.JoinHostPort(host, port)
	if host == "::" || host == "0.0.0.0" {
		expected = r.Host
	}
	isProxy := s.origin != nil && LocalProxy(r.RemoteAddr)
	allowedHosts := []string{expected}
	allowedOrigins := []string{"http://" + expected}
	if isProxy {
		allowedHosts = append(allowedHosts, s.origin.Host)
		allowedOrigins = append(allowedOrigins, s.origin.Scheme+"://"+s.origin.Host)
	}
	if !contains(allowedHosts, r.Host) {
		writeJSON(w, 403, map[string]string{"error": "허용되지 않은 주소입니다."})
		return
	}
	if (r.Header.Get("Origin") != "" && !contains(allowedOrigins, r.Header.Get("Origin"))) ||
		r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		writeJSON(w, 403, map[string]string{"error": "다른 사이트의 요청은 허용하지 않습니다."})
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, 405, map[string]string{"error": "조회만 지원합니다."})
		return
	}
	route := r.URL.Path
	if q := strings.IndexByte(r.RequestURI, '?'); q >= 0 {
		route = r.RequestURI[:q]
	} else if r.RequestURI != "" {
		route = strings.Split(r.RequestURI, "?")[0]
	}
	if route == "/healthz" {
		writeJSON(w, 200, map[string]string{"status": "ok"})
		return
	}
	if route == "/api/v1/snapshot" {
		// Last published DTO only. No store, file, credential, or collect wait.
		if s.opts.SnapshotAny != nil {
			writeJSON(w, 200, s.opts.SnapshotAny())
			return
		}
		if s.opts.Snapshot == nil {
			writeJSON(w, 503, map[string]string{"error": "snapshot unavailable"})
			return
		}
		writeJSON(w, 200, s.opts.Snapshot())
		return
	}
	name, ok := staticFiles[route]
	if !ok || s.opts.Public == nil {
		writeJSON(w, 404, map[string]string{"error": "페이지를 찾을 수 없습니다."})
		return
	}
	body, err := fs.ReadFile(s.opts.Public, name)
	if err != nil {
		writeJSON(w, 503, map[string]string{"error": "화면을 불러오지 못했습니다."})
		return
	}
	w.Header().Set("Content-Type", mime(name)+"; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(body)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func mime(name string) string {
	switch {
	case strings.HasSuffix(name, ".js"):
		return "text/javascript"
	case strings.HasSuffix(name, ".css"):
		return "text/css"
	default:
		return "text/html"
	}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
