package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/httpserver"
	"github.com/thisisjun786/ocx-quota-manager/internal/runtime"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"github.com/thisisjun786/ocx-quota-manager/webembed"
)

func main() {
	host := env("QUOTA_HOST", "127.0.0.1")
	port, err := strconv.Atoi(env("QUOTA_PORT", "8787"))
	if err != nil {
		log.Fatalf("QUOTA_PORT must be a number: %v", err)
	}
	if err := httpserver.AllowedBind(host, port); err != nil {
		log.Fatal(err)
	}
	home := env("OPENCODEX_HOME", filepath.Join(os.Getenv("HOME"), ".opencodex"))
	data := env("QUOTA_DATA_DIR", filepath.Join(first(os.Getenv("XDG_STATE_HOME"), filepath.Join(os.Getenv("HOME"), ".local/state")), "quota-monitor"))
	storage, err := historyOptions(os.Getenv("QUOTA_DB_MAX_MIB"))
	if err != nil {
		log.Fatal(err)
	}
	hist, err := store.Open(data, storage)
	if err != nil {
		log.Fatal(err)
	}
	if err := configureClaudeCache(hist, os.Getenv("QUOTA_CLAUDE_CACHE_TTL"), os.Getenv("QUOTA_CLAUDE_CACHE_FROM")); err != nil {
		_ = hist.Close()
		log.Fatal(err)
	}
	if err := configureClaudeRoute(hist, os.Getenv("QUOTA_CLAUDE_OCX_FROM"), os.Getenv("QUOTA_CLAUDE_OCX_UNTIL")); err != nil {
		_ = hist.Close()
		log.Fatal(err)
	}
	rt := runtime.New(clock.System{}, hist, collect.NewHTTPSTransport())
	rt.Home = home
	rt.CodexHome = env("QUOTA_CODEX_HOME", env("CODEX_HOME", filepath.Join(os.Getenv("HOME"), ".codex")))
	rt.ClaudeHome = env("QUOTA_CLAUDE_HOME", filepath.Join(os.Getenv("HOME"), ".claude"))
	rt.NativeEnabled = os.Getenv("QUOTA_NATIVE_USAGE") != "off"
	rt.GeminiHome = env("QUOTA_GEMINI_HOME", env("GEMINI_CLI_HOME", filepath.Join(os.Getenv("HOME"), ".gemini")))
	rt.Direct = collect.ParseDirectProviders(os.Getenv("QUOTA_DIRECT_PROVIDERS"))
	if os.Getenv("QUOTA_PRICE_CATALOG") != "off" {
		rt.EnableCatalog(data, env("QUOTA_MODEL_CATALOG", filepath.Join(first(os.Getenv("XDG_CACHE_HOME"), filepath.Join(os.Getenv("HOME"), ".cache")), "opencode", "models.json")))
	}
	ctx, cancel := context.WithCancel(context.Background())
	rt.Start(ctx)

	public := webembed.FS()
	if dir := os.Getenv("QUOTA_PUBLIC_DIR"); dir != "" {
		pub := os.DirFS(dir)
		if err := webembed.RequireAssets(pub); err != nil {
			log.Fatal("QUOTA_PUBLIC_DIR: ", err)
		}
		public = pub
	} else if err := webembed.RequireAssets(public); err != nil {
		log.Fatal(err)
	}
	srv, err := httpserver.New(httpserver.Options{
		Host: host, Port: port, PublicOrigin: os.Getenv("QUOTA_PUBLIC_ORIGIN"),
		Public: public, Snapshot: rt.Snapshot, CollectionLogs: hist.ListCollectionLogs,
	})
	if err != nil {
		log.Fatal(err)
	}
	if err := srv.Listen(); err != nil {
		log.Fatal(err)
	}
	log.Printf("Quota Monitor http://%s", srv.Addr())

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	shut, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	_ = srv.Shutdown(shut)
	cancel()
	if err := rt.Close(shut); err != nil {
		os.Exit(1)
	}
}

// Keep the store's default unless the operator explicitly raises or lowers it.
func historyOptions(raw string) (store.OpenOptions, error) {
	if raw == "" {
		return store.OpenOptions{}, nil
	}
	const maxMiB = int64(1<<63-1) / (1 << 20)
	mib, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || mib < 1 || mib > maxMiB {
		return store.OpenOptions{}, fmt.Errorf("QUOTA_DB_MAX_MIB must be a positive integer no greater than %d", maxMiB)
	}
	return store.OpenOptions{MaxBytes: mib * (1 << 20)}, nil
}

func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}

func first(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
