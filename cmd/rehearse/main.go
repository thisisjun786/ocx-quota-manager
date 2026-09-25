package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/httpserver"
	"github.com/thisisjun786/ocx-quota-manager/internal/runtime"
	"github.com/thisisjun786/ocx-quota-manager/webembed"
)

// Isolated Node-less rehearsal: health, snapshot, UI, stop, restart.
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("rehearse ok")
}

func run() error {
	fake := &collect.Fake{}
	rt := runtime.New(clock.System{}, nil, fake)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rt.Start(ctx)
	s, err := httpserver.New(httpserver.Options{
		Host: "127.0.0.1", Port: 18791, Public: webembed.FS(), Snapshot: rt.Snapshot,
	})
	if err != nil {
		return err
	}
	if err := s.Listen(); err != nil {
		return err
	}
	base := "http://" + s.Addr()
	if err := getOK(base+"/healthz", 200); err != nil {
		return err
	}
	res, err := http.Get(base + "/api/v1/snapshot")
	if err != nil {
		return err
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	var snap contract.Snapshot
	if err := json.Unmarshal(body, &snap); err != nil || snap.SchemaVersion != 1 {
		return fmt.Errorf("snapshot: %s", body)
	}
	if err := getOK(base+"/", 200); err != nil {
		return err
	}
	_ = s.Close()
	shut, done := context.WithTimeout(context.Background(), 2*time.Second)
	defer done()
	if err := rt.Close(shut); err != nil {
		return err
	}
	// Restart with last-good boot DTO.
	rt2 := runtime.New(clock.System{}, nil, fake)
	s2, err := httpserver.New(httpserver.Options{
		Host: "127.0.0.1", Port: 18792, Public: webembed.FS(), Snapshot: rt2.Snapshot,
	})
	if err != nil {
		return err
	}
	if err := s2.Listen(); err != nil {
		return err
	}
	defer s2.Close()
	return getOK("http://"+s2.Addr()+"/healthz", 200)
}

func getOK(url string, want int) error {
	res, err := http.Get(url)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != want {
		return fmt.Errorf("%s -> %d", url, res.StatusCode)
	}
	return nil
}
