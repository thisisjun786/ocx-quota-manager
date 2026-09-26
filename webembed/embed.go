package webembed

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
)

//go:embed all:static
var raw embed.FS

var Required = []string{
	"index.html", "app.js", "format.js", "quota.js", "dom.js",
	"views.js", "types.js", "contract.js", "collection.js", "collection-data.js", "style.css",
}

func FS() fs.FS {
	sub, err := fs.Sub(raw, "static")
	if err != nil {
		panic(err)
	}
	return sub
}

func RequireAssets(fsys fs.FS) error {
	for _, name := range Required {
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return fmt.Errorf("missing asset %s: %w", name, err)
		}
		if len(body) == 0 {
			return fmt.Errorf("empty asset %s", name)
		}
	}
	return nil
}

func AssetHashes() (map[string]string, error) {
	out := map[string]string{}
	err := fs.WalkDir(FS(), ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		body, err := fs.ReadFile(FS(), path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(body)
		out[path] = hex.EncodeToString(sum[:])
		return nil
	})
	return out, err
}
