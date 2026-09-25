#!/usr/bin/env bash
# Install or upgrade Quota Manager for OCX as a user service.
#
#   scripts/install.sh [--prefix DIR] [--unit NAME] [--host ADDR] [--port N]
#                      [--public-origin URL] [--data-dir DIR] [--env KEY=VALUE]...
#                      [--no-systemd] [--no-start] [--skip-build]
#
# Builds the single binary (Go + embedded web UI), copies it to
# $PREFIX/releases/<digest>/ and points $PREFIX/releases/current at it.
# A new user unit is written from deploy/quota-monitor.service; an existing
# unit keeps its settings and only has its release path pointed at current
# (plus any option given explicitly). scripts/deploy.sh wraps this with a
# database backup, health check and automatic rollback.
# Nothing here reads or changes OpenCodex credential files.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
prefix="${QUOTA_PREFIX:-$HOME/.local/share/quota-monitor}"
unit_name="quota-monitor.service"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
host="" port="" public_origin="" data_dir=""
extra_env=()
systemd=1 start=1 build=1

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --unit) unit_name="$2"; shift 2 ;;
    --host) host="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --public-origin) public_origin="$2"; shift 2 ;;
    --data-dir) data_dir="$2"; shift 2 ;;
    --env) extra_env+=("$2"); shift 2 ;;
    --no-systemd) systemd=0; start=0; shift ;;
    --no-start) start=0; shift ;;
    --skip-build) build=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$unit_name" in *.service) ;; *) unit_name="$unit_name.service" ;; esac

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1 ($2)" >&2; exit 1; }; }
if [ "$build" = 1 ]; then
  need go "Go 1.22+ builds the server"
  need node "Node 22+ builds the web UI"
  need npm "npm installs the web UI build tools"
  need python3 "python3 checks the build manifest"
fi
need sha256sum "coreutils"

cd "$root"
if [ "$build" = 1 ]; then
  [ -d node_modules ] || npm ci --no-audit --no-fund
  bash scripts/build-quota-manager.sh
fi
[ -s dist/quota-manager ] || { echo "dist/quota-manager is missing; build first or drop --skip-build" >&2; exit 1; }

digest="$(sha256sum dist/quota-manager | cut -c1-16)"
release="$prefix/releases/$digest"
mkdir -p "$release"
install -m 0755 dist/quota-manager "$release/quota-manager"
[ -f dist/quota-manager.manifest.json ] && install -m 0644 dist/quota-manager.manifest.json "$release/"
# A rename is atomic; a running service never sees a half-made link.
ln -sfn "$release" "$prefix/releases/current.tmp"
mv -Tf "$prefix/releases/current.tmp" "$prefix/releases/current"
echo "installed release $digest -> $prefix/releases/current"

mkdir -p "$prefix/tools"
install -m 0700 deploy/backup-history.py "$prefix/tools/backup-history.py"
install -m 0700 deploy/kimi-collect.py "$prefix/tools/kimi-collect.py"

if [ "$systemd" = 0 ]; then
  echo "skipped systemd; start with: $prefix/releases/current/quota-manager"
  exit 0
fi
need systemctl "systemd user services, or pass --no-systemd"

set_env() {
  local key="$1" value="$2" file="$3"
  if grep -qE "^Environment=$key=" "$file"; then
    sed -i "s#^Environment=$key=.*#Environment=$key=$value#" "$file"
  elif grep -qE "^\# Environment=$key=" "$file"; then
    sed -i "s#^\# Environment=$key=.*#Environment=$key=$value#" "$file"
  else
    sed -i "/^\[Service\]/a Environment=$key=$value" "$file"
  fi
}

mkdir -p "$unit_dir"
unit="$unit_dir/$unit_name"
if [ -f "$unit" ]; then
  cp "$unit" "$unit.new"
else
  sed "s#%h/.local/share/quota-monitor#$prefix#g" deploy/quota-monitor.service > "$unit.new"
fi
sed -i -e "s#^WorkingDirectory=.*#WorkingDirectory=$prefix/releases/current#" \
       -e "s#^ExecStart=.*#ExecStart=$prefix/releases/current/quota-manager#" "$unit.new"
[ -n "$host" ] && set_env QUOTA_HOST "$host" "$unit.new"
[ -n "$port" ] && set_env QUOTA_PORT "$port" "$unit.new"
[ -n "$public_origin" ] && set_env QUOTA_PUBLIC_ORIGIN "$public_origin" "$unit.new"
[ -n "$data_dir" ] && set_env QUOTA_DATA_DIR "$data_dir" "$unit.new"
for kv in "${extra_env[@]}"; do set_env "${kv%%=*}" "${kv#*=}" "$unit.new"; done
mv -f "$unit.new" "$unit"
systemctl --user daemon-reload
echo "wrote $unit"

[ "$start" = 1 ] || exit 0
unit_value() { sed -n "s#^Environment=$1=##p" "$unit" | tail -1; }
url="http://$(unit_value QUOTA_HOST || true):$(unit_value QUOTA_PORT || true)"
url="${url/http:\/\/:/http://127.0.0.1:}"; url="${url%:}"; [[ "$url" =~ :[0-9]+$ ]] || url="$url:8787"
systemctl --user enable "$unit_name" >/dev/null
systemctl --user restart "$unit_name"
for _ in $(seq 1 30); do
  if curl -fsS "$url/healthz" >/dev/null 2>&1; then
    echo "running: $url/"
    exit 0
  fi
  sleep 1
done
echo "$unit_name did not answer $url/healthz within 30s; see: journalctl --user -u $unit_name" >&2
exit 1
