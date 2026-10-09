package main

import (
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/httpserver"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"github.com/thisisjun786/ocx-quota-manager/webembed"
)

func main() {
	host := env("QUOTA_HOST", "127.0.0.1")
	port, _ := strconv.Atoi(env("QUOTA_PORT", "18794"))
	path := os.Getenv("QUOTA_FIXTURE_SNAPSHOT")
	if path == "" {
		log.Fatal("QUOTA_FIXTURE_SNAPSHOT required")
	}
	if _, err := os.Stat(path); err != nil {
		log.Fatal("QUOTA_FIXTURE_SNAPSHOT: ", err)
	}
	dir, err := os.MkdirTemp("", "quota-collection-fixture-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)
	hist, err := store.Open(dir, store.OpenOptions{})
	if err != nil {
		log.Fatal(err)
	}
	defer hist.Close()
	if seed := os.Getenv("QUOTA_FIXTURE_COLLECTION_LOGS"); seed != "" {
		body, err := os.ReadFile(seed)
		if err != nil {
			log.Fatal(err)
		}
		var attempts []collect.Attempt
		if err := json.Unmarshal(body, &attempts); err != nil {
			log.Fatal(err)
		}
		for _, attempt := range attempts {
			if err := hist.InsertCollectionLog(attempt); err != nil {
				log.Fatal(err)
			}
		}
	}

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
		Public: public, CollectionLogs: hist.ListCollectionLogs,
		SnapshotAny: func() any {
			body, err := os.ReadFile(path)
			if err != nil {
				return map[string]string{"error": "fixture-unavailable"}
			}
			var raw any
			if err := json.Unmarshal(body, &raw); err != nil {
				return map[string]string{"error": "fixture-invalid"}
			}
			return raw
		},
	})
	if err != nil {
		log.Fatal(err)
	}
	if err := srv.Listen(); err != nil {
		log.Fatal(err)
	}
	log.Printf("Quota Monitor fixture http://%s", srv.Addr())

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	_ = srv.Close()
}

func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
