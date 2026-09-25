package runtime

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

// Price catalog for models the source-owned table does not price. It is read
// from a copy in the data directory, refreshed from models.dev once a day, and
// falls back to the OpenCode cache the Node collector used. A failed refresh
// keeps the copy already loaded.
const (
	catalogURL      = "https://models.dev/api.json"
	catalogMaxBytes = 25 << 20
	catalogRefresh  = 24 * time.Hour
	catalogRetry    = time.Hour
)

type catalogLoader struct {
	DataDir  string
	Fallback string
	Client   *http.Client
	URL      string

	loadedMod time.Time
	nextFetch time.Time
}

func (l *catalogLoader) path() string { return filepath.Join(l.DataDir, "models-catalog.json") }

// Load returns a catalog when a newer file is available, or nil when nothing
// changed. It never returns an error: a missing or broken catalog only means
// fewer rows can be priced.
func (l *catalogLoader) Load(ctx context.Context, now time.Time) *store.Catalog {
	if l.DataDir != "" && !now.Before(l.nextFetch) {
		l.nextFetch = now.Add(catalogRetry)
		if l.fetch(ctx) == nil {
			l.nextFetch = now.Add(catalogRefresh)
		}
	}
	for _, p := range []string{l.path(), l.Fallback} {
		if p == "" {
			continue
		}
		info, err := os.Stat(p)
		if err != nil || !info.Mode().IsRegular() || info.Size() > catalogMaxBytes {
			continue
		}
		if !info.ModTime().After(l.loadedMod) {
			return nil
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		c, err := store.ParseCatalog(raw)
		if err != nil {
			continue
		}
		l.loadedMod = info.ModTime()
		return c
	}
	return nil
}

func (l *catalogLoader) fetch(ctx context.Context) error {
	if info, err := os.Stat(l.path()); err == nil && time.Since(info.ModTime()) < catalogRefresh {
		return nil
	}
	client := l.Client
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	url := l.URL
	if url == "" {
		url = catalogURL
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errStatus(res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, catalogMaxBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > catalogMaxBytes {
		return errStatus(http.StatusRequestEntityTooLarge)
	}
	if _, err := store.ParseCatalog(raw); err != nil {
		return err
	}
	tmp := l.path() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, l.path())
}

type errStatus int

func (e errStatus) Error() string { return "catalog fetch status " + http.StatusText(int(e)) }
