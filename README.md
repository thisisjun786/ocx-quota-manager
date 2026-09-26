# Quota Manager for OCX

Read-only dashboard for [OpenCodex (OCX)](https://github.com/lidge-jun/opencodex): the remaining quota
of every provider and account, how fast it is being used, and what that usage would cost at API
prices, in one place. It only reads. It never switches accounts, changes a plan or calls a model.

- **Summary**: per provider, the remaining limit, quota used over 1h / 5h / 24h / 7d / 30d, the
  API-equivalent amount, and how many accounts that pace would need
- **Accounts**: every account's windows, reset times and exhaustion forecast
- **Cost analysis**: API-equivalent spend by provider, model and account, in 1-hour, 5-hour or daily bars
- **Quota analysis**: quota %p used per provider in the same bars, with the dollars behind each %p
- **Model prices**: the rate behind every figure, with its source and check date
- **Collection logs**: quota lookup attempts, success and HTTP 429 rates by provider,
  account/result filters, and retry timing. These are quota reads, not model calls;
  details are retained for 30 days from the time logging is enabled.

It is a single Go binary with the web UI embedded, and a macOS menu-bar client in `macos/` that reads
the same JSON API.

## Install

Needs Linux with systemd user services, Go 1.22+, Node.js 22+ with npm, python3, sqlite3, and
OpenCodex running on the same machine.

```sh
git clone https://github.com/thisisjun786/ocx-quota-manager.git
cd ocx-quota-manager
scripts/install.sh
# open http://127.0.0.1:8787/
```

`scripts/install.sh` builds the binary, installs it under
`~/.local/share/quota-monitor/releases/<digest>/`, points `releases/current` at it, writes the user unit
`quota-monitor.service` and waits until it answers `/healthz`.

| Option | Effect |
|---|---|
| `--host ADDR` / `--port N` | Bind address, default `127.0.0.1:8787`. Loopback and Tailscale addresses only |
| `--public-origin URL` | HTTPS origin of a reverse proxy in front of it, for example Tailscale Serve |
| `--data-dir DIR` | History database, default `~/.local/state/quota-monitor` |
| `--env KEY=VALUE` | Any other setting below |
| `--no-systemd` | Build and install only; run `releases/current/quota-manager` yourself |

Re-running keeps an existing unit's settings and changes only what you pass.

## Update

```sh
git pull
scripts/deploy.sh
```

It snapshots the history database, the unit file and the current release into
`~/.local/state/quota-monitor-deploys/deploy-<UTC>/`, installs the new release, restarts the service and
checks `/healthz` and `/api/v1/snapshot`. If the new release is not healthy it puts the previous one
back, restarts it and exits non-zero. Old releases stay under `releases/` for a manual rollback.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `QUOTA_HOST`, `QUOTA_PORT` | `127.0.0.1`, `8787` | Where the server listens |
| `QUOTA_PUBLIC_ORIGIN` | unset | Origin allowed when served through a proxy |
| `QUOTA_DATA_DIR` | `~/.local/state/quota-monitor` | SQLite history (quota readings and normalized usage) |
| `OPENCODEX_HOME` | `~/.opencodex` | OpenCodex config and usage log, read only |
| `QUOTA_CODEX_HOME` | `$CODEX_HOME` or `~/.codex` | Codex account files, read only |
| `QUOTA_DIRECT_PROVIDERS` | unset | Providers whose quota is also read from the provider itself, for example `openai,anthropic,cursor` |
| `QUOTA_PRICE_CATALOG` | on | `off` disables the daily models.dev price fallback |
| `QUOTA_TZ` | system zone | Where day bars and daily totals start, for example `Asia/Seoul` |
| `QUOTA_CLAUDE_CACHE_TTL`, `QUOTA_CLAUDE_CACHE_FROM` | 5-minute rate | Price Claude cache writes at the 1-hour rate from a given time |

## Security

There is no login. Keep it on loopback or a private tailnet. The Host and Origin checks protect the
browser, not the server. Credentials, prompts and conversation IDs are never stored; account emails are
masked in the API. The history database is personal usage data, so it is created `0600`.

## Development

```sh
npm ci
npm run typecheck && npm test            # TypeScript types and contract tests
go vet ./... && go test -race ./...      # Go tests
bash scripts/build-quota-manager.sh      # dist/quota-manager + manifest
npm run check:port:ui                    # real binary in headless Chromium
```

`cmd/quota-manager` and `internal/` are the server; `web/` is the UI (TypeScript, compiled into `webembed/`).
Prices live in `internal/store/price_rules.json` and subscription fees in
`internal/runtime/subscription_catalog.json`; see [pricing](docs/quota-and-pricing.md#editing-prices).

## Documentation

- [Architecture and data contract](docs/architecture.md): terms, API fields, usage periods, quota evidence
- [Quota reads, forecasts and pricing](docs/quota-and-pricing.md): direct provider reads, estimates, price sources
- [Interface](docs/interface.md): what each screen shows and why
- [Operations](docs/operations.md): service, backup, recovery, rollback, release check
- [Development](docs/development.md): test suites and UI checks
- [Design](DESIGN.md): visual system

## License

[MIT](LICENSE)
