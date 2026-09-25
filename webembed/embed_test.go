package webembed

import (
	"io/fs"
	"testing"
	"testing/fstest"
)

func TestEmbeddedAllowlist(t *testing.T) {
	for _, name := range Required {
		body, err := fs.ReadFile(FS(), name)
		if err != nil || len(body) == 0 {
			t.Fatalf("missing or empty %s: %v", name, err)
		}
	}
	if _, err := fs.ReadFile(FS(), "secret.txt"); err == nil {
		t.Fatal("unknown file must not be embedded")
	}
	hashes, err := AssetHashes()
	if err != nil || len(hashes) < len(Required) {
		t.Fatalf("hashes %v %v", hashes, err)
	}
	if err := RequireAssets(FS()); err != nil {
		t.Fatal(err)
	}
}

func TestRequireAssetsRejectsMissingAndEmpty(t *testing.T) {
	empty := fstest.MapFS{}
	if err := RequireAssets(empty); err == nil {
		t.Fatal("missing dir must fail")
	}
	partial := fstest.MapFS{"app.js": {Data: []byte("ok")}}
	if err := RequireAssets(partial); err == nil {
		t.Fatal("incomplete public dir must fail")
	}
	blank := fstest.MapFS{}
	for _, name := range Required {
		blank[name] = &fstest.MapFile{Data: []byte("x")}
	}
	blank["views.js"] = &fstest.MapFile{Data: []byte{}}
	if err := RequireAssets(blank); err == nil {
		t.Fatal("empty asset must fail")
	}
}
