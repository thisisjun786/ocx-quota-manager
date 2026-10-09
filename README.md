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
| `QUOTA_CLAUDE_HOME` | `~/.claude` | Claude account files and local usage transcripts, read only |
| `QUOTA_GEMINI_HOME` | `$GEMINI_CLI_HOME` or `~/.gemini` | Antigravity CLI/extension conversation databases, read only |
| `QUOTA_NATIVE_USAGE` | on | `off` disables local Claude Code and Antigravity usage collection and their cost overlay; Codex remains accounted for through OCX |
| `QUOTA_DIRECT_PROVIDERS` | unset | Providers whose quota is also read from the provider itself, for example `openai,anthropic,cursor` |
| `QUOTA_PRICE_CATALOG` | on | `off` disables the daily models.dev price fallback |
| `QUOTA_TZ` | system zone | Where day bars and daily totals start, for example `Asia/Seoul` |
| `QUOTA_CLAUDE_CACHE_TTL`, `QUOTA_CLAUDE_CACHE_FROM` | 5-minute rate | Price Claude cache writes at the 1-hour rate from a given time |
| `QUOTA_CLAUDE_OCX_FROM`, `QUOTA_CLAUDE_OCX_UNTIL` | unset | From this RFC3339 instant (until the optional exclusive end), Claude Code records without a request ID are reported as OCX calls in the usage counts; costs are unaffected. `off` clears the stored setting, unset keeps it |

## Local tool usage

Codex calls in this deployment all run through OCX, so OCX is their single source of usage and cost.
The collector does not scan Codex transcripts or add their totals again. Previously collected local
Codex candidates remain stored under normal retention, but are not used for costs or warnings.

Cost analysis also collects local Claude Code and Antigravity usage metadata. Collection is
incremental and bounded. Routine historical imports and unfinished log tails do not produce warning
banners. Tokscale's hourly totals are not added because they can contain the same calls.

Claude Code costs come from OCX's usage log. Claude Code transcripts are still collected for usage
and session data, but they are no longer valued or added to costs. The transcript rows that costs
already counted (records carrying an upstream Anthropic request ID) were settled once, with their
stored amounts, when this release first opened the history, so past periods keep their totals; they
expire with normal retention. A Claude Code record that carries an Anthropic request ID and was not
settled is reported in a warning, counted once by its stable ID, split into calls dated after the
settlement and older records read late; it is not added to costs and no amount is estimated.
Records without a request ID or with an OCX marker produce no warning. Antigravity generation
records still enter the combined cost. `analytics.nativeUsage.codex.status` is `via-ocx`; the other
source statuses describe local collection. Warnings report read/format failures, Antigravity records
left out of costs because their route is unproven or contradictory, and new Claude Code direct
evidence; normal background work produces none.

Native source identities are hashed, repeated/streamed records are reconciled, and conflicting
evidence stays excluded even after replay. Source transcripts and databases are never changed. Native
costs remain separate from quota calibration and account estimates; an account is not guessed from
the currently selected login. Disabling native collection hides its cost overlay but retains history.
See [the data contract](docs/architecture.md#native-usage-and-costs) for the attribution limits.

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
