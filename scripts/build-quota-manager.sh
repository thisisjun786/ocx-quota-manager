#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

node scripts/build-web.ts
node scripts/web-assets.ts sync web/dist/ui webembed/static

mkdir -p dist
ver="$(git rev-parse HEAD)"
go build -trimpath -ldflags "-X main.version=${ver}" -o dist/quota-manager ./cmd/quota-manager
bin_hash="$(sha256sum dist/quota-manager | awk '{print $1}')"
python3 - <<PY
import hashlib, json, os, pathlib
root = pathlib.Path("$root")
required = ["app.js", "format.js", "quota.js", "dom.js", "views.js", "types.js", "contract.js", "collection.js", "collection-data.js", "index.html", "style.css"]
assets = {}
for name in required:
    p = root / "webembed/static" / name
    if not p.is_file() or p.stat().st_size == 0:
        raise SystemExit(f"missing or empty embed asset {name}")
    assets[name] = hashlib.sha256(p.read_bytes()).hexdigest()
    dist = root / "web/dist/ui" / name
    if hashlib.sha256(dist.read_bytes()).hexdigest() != assets[name]:
        raise SystemExit(f"embed hash mismatch {name}")
manifest = {
    "go": "1.22",
    "typescript": "5.6.3",
    "sqliteDriver": "modernc.org/sqlite",
    "sqliteLicense": "BSD-3-Clause",
    "sourceSha": "$ver",
    "binarySha256": "$bin_hash",
    "assetSha256": assets,
    "os": "linux",
    "arch": "amd64",
}
(root/"dist/quota-manager.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("wrote dist/quota-manager and manifest")
PY
test -s dist/quota-manager
python3 - <<'PY'
import hashlib, json, pathlib
m = json.loads(pathlib.Path("dist/quota-manager.manifest.json").read_text())
actual = hashlib.sha256(pathlib.Path("dist/quota-manager").read_bytes()).hexdigest()
if actual != m["binarySha256"]:
    raise SystemExit("manifest binary hash mismatch")
required = ["app.js", "format.js", "quota.js", "dom.js", "views.js", "types.js", "contract.js", "collection.js", "collection-data.js", "index.html", "style.css"]
for name in required:
    want = m["assetSha256"].get(name)
    if not want:
        raise SystemExit(f"manifest missing {name}")
    got = hashlib.sha256(pathlib.Path("webembed/static", name).read_bytes()).hexdigest()
    if got != want:
        raise SystemExit(f"manifest asset hash mismatch {name}")
print("manifest ok")
PY
