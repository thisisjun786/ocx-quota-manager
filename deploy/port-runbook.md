# Go port cutover runbook

Operational start/stop of the live service is a separate authority. This file is the rehearsal path only.

## Integration gate (JUN-272)

Single command: `npm run check:port:integrate`.

It locks the resource bar before measuring (7 repeats, drop the worst 2 — not the first 2 — 15% idle RSS or collect wall, 5% other metrics, no extra external requests), runs the JUN-268–271 probes, then compares the built `dist/quota-manager` binary to the pinned Node baseline on one synthetic fixture. The baseline is commit `cbaf12cca3a6ae8f70de37c47f22757381c47a49`, extracted read-only with `git archive` into the task scratch directory; its extraction is hash-recorded and candidate HEAD never stands in for it. The collect measurement is the same full cycle on both sides — one complete collector operation (source read, usage ingest, analytics snapshot; construction and store open excluded) on a fresh SQLite directory — never a cached snapshot read against a full cycle. The fixed 10,000-row log is hash-recorded and both collectors must account for all rows. CPU deltas, DB write volume, and request counts are judged fail-closed: a null or unmeasured metric, or a failed HTTP sample, fails the run instead of passing. External request counts are observed on both sides (a wrapped `fetch` for the baseline collector, the transport call log for the Go cycle).

The DB handoff walks Node baseline writer → production binary ingest → Node writer append → production binary reopen on one SQLite file and one shared `usage.jsonl`, preserving ids, cursor, stored USD, and price evidence with no duplicates. The port-harness store helper repeats the same walk as a secondary check only. Large work uses the task scratch mount (`/scratch/quota-manager/port-review-fixes/harness`) after verifying the real mount with `findmnt` and free capacity with `df`; the work directory is deleted after the run.

It measures real `/proc` VmRSS (not Go heap Alloc) and writes `dist/port-integrate-evidence.json`; the file records its final judgment set and assertion count, including the evidence check itself. A missing pinned baseline, an unrun required item, 0 checks, or a bar miss is a failed exit — an honest performance miss is reported as a miss, never a lowered bar. Linux `go run ./cmd/swiftpayload` plus `scripts/mac-swift-repro.sh` are the Mac decode inputs; a Linux generation is not a Mac pass.

Large work requires a verified `/scratch` mount with free bytes and inodes; no root-disk fallback is used. The work directory is deleted after the run. Keep the evidence JSON and `dist/swift-payload.json`.

## Before

1. Stop the current writer. One SQLite writer only.
2. Copy `history.sqlite` and `-wal`/`-shm` to a dated backup.
3. Record the running Node SHA, binary hash, and `/healthz`.
4. Build: `bash scripts/build-quota-manager.sh`. This compiles the TypeScript UI, syncs `webembed/static`, then writes the binary and manifest. Confirm `dist/quota-manager.manifest.json` SHA matches the file on disk. A missing, empty, or stale UI asset fails the build.

## Cutover (isolated, not production)

1. `QUOTA_HOST=127.0.0.1 QUOTA_PORT=8787 QUOTA_DATA_DIR=/path/to/copy ./dist/quota-manager`
2. `curl -sS http://127.0.0.1:8787/healthz` must be `{"status":"ok"}`.
3. `curl -sS http://127.0.0.1:8787/api/v1/snapshot` must be schemaVersion 1. Tokens and provider error bodies must be absent.
4. Open `/` and confirm the existing UI. Do not merge or restart the host unit from this document.

## Rollback

1. SIGTERM the Go process. Wait for the 10s shutdown deadline.
2. Reopen the same DB with the previous Node writer. New rows written by Go must still be present.
3. If WAL is dirty, do not delete it. Restore the backup pair instead.
4. Cool-down: do not start a second writer until `/healthz` from the previous process is gone.

## Failure

- Bind rejected: host is not loopback or Tailscale `100.64/10`.
- Snapshot stale/error: last-good is still served; do not treat a miss as a hidden zero.
- Manifest hash mismatch: do not run the file.

## Swift payload

`go run ./cmd/rehearse` writes no credentials. A candidate snapshot for the existing Mac decoder is the `/api/v1/snapshot` body. Linux rehearsal and Mac decode are recorded as separate results. Mac decode is JUN-267.
