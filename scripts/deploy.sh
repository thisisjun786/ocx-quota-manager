#!/usr/bin/env bash
# Deploy the current checkout to the installed Quota Manager service.
#
#   scripts/deploy.sh [--prefix DIR] [--unit NAME] [--snapshots DIR]
#                     [--health-timeout SECONDS] [--skip-build]
#
# 1. builds dist/quota-manager from this checkout
# 2. snapshots the history database (SQLite online backup), the unit file and
#    the release it replaces into $SNAPSHOTS/deploy-<UTC>/
# 3. installs the release through scripts/install.sh and restarts the unit
# 4. waits for /healthz and /api/v1/snapshot; on failure it restores the
#    previous release and unit, restarts, and exits non-zero
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
prefix="${QUOTA_PREFIX:-$HOME/.local/share/quota-monitor}"
unit_name="quota-monitor.service"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
snapshots="${QUOTA_DEPLOY_SNAPSHOTS:-${XDG_STATE_HOME:-$HOME/.local/state}/quota-monitor-deploys}"
health_timeout=60
build_flag=()

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --unit) unit_name="$2"; shift 2 ;;
    --snapshots) snapshots="$2"; shift 2 ;;
    --health-timeout) health_timeout="$2"; shift 2 ;;
    --skip-build) build_flag=(--skip-build); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$unit_name" in *.service) ;; *) unit_name="$unit_name.service" ;; esac
unit="$unit_dir/$unit_name"
[ -f "$unit" ] || { echo "no installed unit at $unit; run scripts/install.sh first" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "missing required tool: sqlite3 (database snapshot)" >&2; exit 1; }

unit_value() { sed -n "s#^Environment=$1=##p" "$unit" | tail -1; }
host="$(unit_value QUOTA_HOST)"; host="${host:-127.0.0.1}"
port="$(unit_value QUOTA_PORT)"; port="${port:-8787}"
data_dir="$(unit_value QUOTA_DATA_DIR)"; data_dir="${data_dir:-${XDG_STATE_HOME:-$HOME/.local/state}/quota-monitor}"
data_dir="${data_dir//%h/$HOME}"
url="http://$host:$port"

previous=""
if [ -L "$prefix/releases/current" ]; then
  previous="$(readlink -f "$prefix/releases/current")"
else
  exec_path="$(sed -n 's#^ExecStart=##p' "$unit" | tail -1)"
  [ -n "$exec_path" ] && [ -x "$exec_path" ] && previous="$(dirname "$(readlink -f "$exec_path")")"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snap="$snapshots/deploy-$stamp"
mkdir -p "$snap"
chmod 700 "$snapshots" "$snap"
cp "$unit" "$snap/$unit_name"
if [ -f "$data_dir/history.sqlite" ]; then
  (umask 077; sqlite3 "$data_dir/history.sqlite" ".backup '$snap/history.sqlite'")
fi
echo "snapshot: $snap"

healthy() {
  local deadline=$((SECONDS + health_timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS "$url/healthz" >/dev/null 2>&1 \
      && curl -fsS "$url/api/v1/snapshot" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("providers") is not None else 1)' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  echo "deploy failed health check; rolling back" >&2
  cp "$snap/$unit_name" "$unit"
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    ln -sfn "$previous" "$prefix/releases/current.tmp"
    mv -Tf "$prefix/releases/current.tmp" "$prefix/releases/current"
  fi
  systemctl --user daemon-reload
  systemctl --user restart "$unit_name" || true
  if healthy; then
    echo "rolled back to ${previous:-the previous unit}; service is healthy" >&2
  else
    echo "rollback did not become healthy either; database snapshot is in $snap" >&2
  fi
  exit 1
}

if ! bash "$root/scripts/install.sh" --prefix "$prefix" --unit "$unit_name" --no-start "${build_flag[@]}"; then
  echo "install failed before restart; the running service was not touched" >&2
  exit 1
fi
new="$(readlink -f "$prefix/releases/current")"
(umask 077
{
  printf '{\n'
  printf '  "deployedAt": "%s",\n' "$stamp"
  printf '  "sourceCommit": "%s",\n' "$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
  printf '  "release": "%s",\n' "$new"
  printf '  "previousRelease": "%s",\n' "$previous"
  printf '  "unit": "%s"\n' "$unit"
  printf '}\n'
} > "$snap/deployment.json")

systemctl --user restart "$unit_name"
healthy || rollback
echo "deployed $(basename "$new") (previous: ${previous:+$(basename "$previous")}); $url/"
