# Architecture and data contract

## Name and terminology

The product is **Quota Manager for OCX**, in Korean **쿼타 매니저 for OCX**. **OCX QM** is the short
form used for linking and search. The earlier name, Quota Monitor, survives only in history notes and
in the compatibility identifiers listed below.

*Manager* describes what you can inspect and organize here: remaining quota, usage, and model prices.
It does not switch accounts, change a plan, or buy capacity.

| Term | Meaning |
|---|---|
| 남은 한도 | Remaining quota of a provider window, as the provider reports it |
| 사용현황 | Recorded usage over a rolling period: calls, tokens, and API-equivalent amount |
| API 환산액 | Recorded tokens priced at API rates. A reference cost, not a charge |

The macOS menu-bar project shares this name and these terms. Native screens belong to that project.

### Compatibility identifiers

The display name is separate from the identifiers that installed services and stored data depend on.
These keep their original spelling, so a global search and replace of the old name would break them:

- `package.json` name `quota-monitor`
- `deploy/quota-monitor.service`, its unit name, its `WorkingDirectory`, and its systemd description
  `OpenCodex Quota Monitor`
- `QUOTA_DATA_DIR` and its default `~/.local/state/quota-monitor`
- the browser key `quota-monitor.provider-order.v1`
- the log prefixes in `src/server.mjs` and `src/collector.mjs`
- the source-identity salt `quota-monitor-ollama` in `src/ollama.mjs`
- `macos/Info.plist` `CFBundleIdentifier` `local.quota-monitor.menubar` and `CFBundleName`
  `Quota Monitor`, and the bundle paths in `macos/build.sh`

## Run

### Mac menu-bar client

On a Mac with Xcode Command Line Tools, run `bash macos/build.sh`. This runs the Swift model tests and creates `macos/build/Quota Monitor.app` for that Mac's CPU. Open the app to use it, or copy it to Applications. Requires macOS 13 or newer. The locally built app is ad-hoc signed, not notarized for public distribution.

The 400-point popover has a summary and a three-column provider selector with account quota bars. The native NSPopover has explicit content-driven sizing: a reserved loading viewport, measured chrome and body, and a screen-height cap. Provider navigation scrolls independently after 120 points. A pin beside a summary limit selects the provider percentage shown in the menu bar; different quota periods and providers are never merged into an invented global percentage. The app refreshes every 30 seconds. Failed refreshes retain the previous snapshot with a connection warning; locally expired observations become unavailable. Settings accepts an HTTPS server origin and persists it on the Mac. The default is `http://127.0.0.1:8787`; set your Tailscale HTTPS address there; the Mac needs access to that tailnet. The app reads only `/api/v1/snapshot`, requires no provider credentials, and has no account-switching, inference, cost-analysis, or background server functionality.

`macos/Sources/QuotaModel.swift` shares `public/app.js`'s matching-window average rule and its hidden Codex Spark windows across the JSON boundary. It also checks observation age/reset time locally so offline data cannot stay current indefinitely. Nullable `stale` values are accepted with those timestamp checks. Tests live in `macos/Tests/`.

Verification on 2026-09-10: Apple Silicon/macOS 26, Swift 6.3.3 compiled the macOS 13-targeted app; standalone model tests passed, including null-stale, expiration, invalid ranges, and paused/reauth account cases. The native URLSession client decoded the live server, which served 6 providers and 10 accounts that day; both counts follow the OpenCodex configuration and change as providers and accounts are added. Accessibility inspection confirmed the menu-bar percentage title. AppKit-hosted rendering was used for summary and account layout inspection; remote screen capture and actual popover interaction were unavailable, so no complete interactive UI pass is claimed. `macos/build/` contains the ignored local ZIP and render previews.

### Web server

The Go binary serves the API and the UI. Building needs Go 1.22+ and Node.js 24+ (for the TypeScript compiler only). One command compiles the UI, syncs `webembed/static`, and writes the binary plus a hash manifest. A missing, empty, or stale asset fails the build:

```sh
bash scripts/build-quota-manager.sh
# dist/quota-manager
# dist/quota-manager.manifest.json
```

`QUOTA_PUBLIC_DIR` must contain every required module (`app.js`, `format.js`, `quota.js`, `dom.js`, `views.js`, `types.js`, `contract.js`, `index.html`, `style.css`). An incomplete directory is fatal; the process does not fall back to the embedded copy. Module URLs keep the `.js` suffix and match the Go static allowlist. Verify the TypeScript build and the real binary (not the Node `check:ui` path) with:

```sh
npm run typecheck
npm run build:web
npm run check:port:ui
```

Set `QUOTA_HOST` to your Tailscale IPv4 and `QUOTA_PORT` to an unused port for private remote access. `OPENCODEX_HOME` defaults to `~/.opencodex`; `QUOTA_CODEX_HOME` defaults to `CODEX_HOME`, then `~/.codex`. Do not expose the service publicly: it trusts tailnet network access and masks account emails, with no application login. Host/Origin guards are browser defenses, not user authentication.

## Data contract

`GET /api/v1/snapshot` returns `schemaVersion: 1`, ISO `observedAt`, `source`, `refreshIntervalSeconds`, `warnings`, and `providers`. Each provider has identity, enabled state, default model, and account rows. Account rows contain masked label, optional plan, selected-account flag, status, measurement timestamp, quota mode, and windows with used/remaining percentages and reset timestamps. `active` means configured selection, not current request traffic. There is no single percentage combining different providers or quota periods. Summary percentages are equal-account averages, not plan-capacity-weighted pools.

The backend reads OpenCodex snapshots without importing its SDK. When `QUOTA_OPENCODEX_ORIGIN` is configured, the collector also makes authenticated, loopback-only `GET` requests to OpenCodex quota endpoints every 10 seconds; it never calls inference, login, or account-selection endpoints. It persists normalized measurements so quota observations, including API-key quota responses, survive a monitor restart. Each account's last observation remains visible. Readings older than 15 minutes, invalid/future timestamps, or past reset times are stale. Missing, expired, or reauthentication-required quotas remain unavailable. All original OpenCodex files remain read-only.

The main Codex account uses only identity-bound `mainPolicyQuota` after matching the installed OpenCodex SHA-256 identity scheme to native auth. Configured extra accounts use their own opaque store IDs. Tokens and key hints are never returned. Config and credential files are never served as static assets. Errors use generic messages.

### Accounts and costs

`analytics.accounts` lists every account once, ordered by urgency. Each row carries `health`
(`critical` below 10% remaining or needing a login, `warning` below 30%, `ok` (a failed lookup that
keeps the previous reading does not raise it), `unknown` when no limit can be read, `idle` when OCX paused the account), a Korean
`reason`, the `lowest` window, `nextResetAt`, and `day` / `week` totals of calls, tokens and
API-equivalent amount with the last request time.

`analytics.costs.periods.{day,week,month}` groups the last 24 hours, 7 days and 30 days by provider,
model (top 40) and account, each with its share of the period total and its unpriced call count.
Providers that still have usage but no longer appear in the OCX configuration are kept with
`configured: false`, so removed providers such as `command-code` or `opencode-go` do not vanish from
the totals. `analytics.costs.daily` is a 30-day series split by provider; its day boundary follows
`QUOTA_TZ`, or the process time zone when unset. All amounts are API-equivalent references, never
charges.

### Usage periods

`analytics.periods` reports five trailing spans on every provider and account: `oneHour`, `fiveHour`, `twentyFourHour`, `weekly` and `monthly` — 1, 5, 24, 168 and 720 hours. All five end at the same instant, the last usage-log read that finished successfully, and each period carries its own `startedAt`, `endedAt` and `hours`. The boundary is half-open: a call exactly at `startedAt` is outside the period and a call exactly at `endedAt` is inside it. These are instants, never calendar-aligned, so `twentyFourHour` is the last 24 hours rather than today's date, and it does not restart at local midnight. `endedAt` always equals `pace.observedAt`; it equals the snapshot's `usageObservedAt` only when a read timestamp exists and is not ahead of the clock, since the boundary falls back to the caller's clock when no read has been recorded and never moves past it.

A period is a span of time, not a claim of observation. Two different fields describe what stands behind it, and they answer different questions.

`logCoverageHours` is how much of the span the retained usage log reaches back over. It is a property of the rows we kept: OpenCodex writes one log for every provider, so a single old row gives a full span to an account added this morning. It never means that account was watched, and it is never evidence that a period had no calls.

`observedCoverageHours` is how much of the span we were actually reading the log, taken from the run of reads that completed without a detected break. The run starts when reading began or restarted, and its far end only moves when a read reached the end of the file, so a record left half-written holds it back. A break is recorded when the file is not the one we were reading, when the bytes we already consumed or a record we saw left unresolved no longer match, when a record could not be decoded, or when a history reset or the retention boundary deliberately excluded rows. `usageObservedSince` and `usageObservedThrough` report that interval on the snapshot.

This is a detection claim, not a proof. A full `observedCoverageHours` means no break was detected across the span; it does not prove no call existed. A log rewritten so that its first bytes, its length past our cursor, its inode and its birth time all still match can hide a call, and we would not see it. The checks also run between reads, so a change made and undone in between goes unnoticed. Read the field as an operational observation, not a guarantee.

Breaks are recorded in the safe direction, so some spans read as unobserved although nothing was lost: a harmless malformed line, a rotation that dropped no call you care about, a break recorded just before a read failed, and the retention boundary advancing on a read that skipped nothing. `usageExcludedBefore` is a conservative completeness boundary, not evidence that rows were deleted. If every read leaves an unresolved record, the far end never advances and coverage stays at zero until one clean read completes.

Read these together with the amount, pricing and collection-status fields to tell four situations apart:

| Situation | How it reads |
| --- | --- |
| Not observed for the whole span | `observedCoverageHours` below `hours`; whatever the log happens to retain does not change this |
| Observed with no calls | `observedCoverageHours` equal to `hours` with `requests: 0` |
| Prices unconfirmed | `unknownPriceRequests` above 0; `apiUsd` is null when no call in the span had a confirmed price |
| Collection stopped | `endedAt` behind the snapshot's `observedAt`, with `usageStale` and `analytics.status` |

Because the span is anchored to the last successful read, an outage does not read as idle time: the numbers freeze instead of diluting. Retention interacts with the longer periods — after an outage longer than the gap between retention and a period, the start of that period falls outside what was kept, and both coverage figures shrink with it rather than overstating the sample. The one-hour figure also runs slightly low for a different reason: a call is recorded when it finishes but timestamped when it started, so work still in flight at the last read is not counted yet.

A provider period splits into three parts, each queried on its own rather than derived from the others: `listedAccount`* for the accounts the snapshot lists, `unattributed`* for calls no account claims, and `unlistedAccount`* for calls belonging to an account id the snapshot does not list, which is where a removed account's history lives. The three add up to the provider total for calls, tokens and amount, so every retained call is explained. Attribution is never rewritten and no total is reduced; a removed account keeps its rows and its identity, they simply move into the unlisted part. Adding up the account rows instead can disagree when a snapshot repeats an account id, which is why the listed subtotal is published separately. Amounts are sums of floating-point values, so the three parts match the total within 1e-9 relative rather than bit for bit; call counts are exact, and token counts are exact while the total stays a whole number below 2^53. A part is `null` rather than zero when it holds no priced call. `analytics.unattributed` remains the existing 7-day subtotal and matches `periods.weekly`.

The exhaustion forecast and the suggested account count keep their own 7-day sample and are not re-based on whichever period is being viewed; `pace.basisPeriod` names that sample.


### Quota precision and evidence

Every quota window carries `analytics.quotaPrecision`, built from stored observations rather than
from the transported chart. The percentage itself has always been stored as a real number; what is
new is the evidence recorded beside it, so a difference between two readings can be judged rather
than assumed.

`latest` is the most recent reading's own basis: the provider's reported percentage, our computed
one, the used quantity and its unit, the denominator and its state, the method, the scope and cycle
keys, the window semantics, the precision evidence, the reconciliation verdict, the accumulation
declaration, and the identity epoch it was read under. Percentages here are not capped at 100. The
window's own `usedPercent` is capped for display, but an over-limit reading is evidence and the
overage is the part worth keeping, so `137.5` stays `137.5` in the record while the window shows
`100`.

`changes` reports signed movement in the vocabulary of occupancy only: `netChangePp`,
`increasePp`, `decreasePp`, and `monotonic`. None of them is a consumption claim. A window whose
share rose is not thereby a window that consumed that much, and on a sliding or unknown window the
difference between two shares has no total behind it at all.

`consumption` is the only place a consumption number appears, and it is deliberately hard to reach.
It requires a fixed-reset window, an adapter that declared its used value cumulative, a present
denominator, a finite used quantity on every reading, one measurement basis across everything being
added, no fall inside a run or across the seam between runs in one cycle, and no overlapping time
spans. `usedDelta` additionally requires a recorded unit, since a quantity whose unit nobody wrote
down is not a quantity; `totalUsedPp` does not. When any condition fails both are `null` and
`reason` says which one. No shipped adapter declares accumulation yet, so existing history stays
unverified and no total is offered for it — that is the intended state, not a gap.

A run is cut wherever a difference would stop meaning anything: `basis` when the denominator,
scope, source, method, unit, precision, accumulation declaration or identity changed, or when the
cycle key itself changed in a way the reset does not explain; `cycle`
when the reset moved past the 60-second drift tolerance; `time_reversed` when a reading arrived
with an earlier instant than the one before it; and `gap` when nothing was recorded for longer than
twenty minutes. A cycle key that merely restates the row's own reset — the shape every
shipped adapter produces — is normalized inside the basis, so a sub-minute reset nudge neither
splits the run nor bypasses idle deduplication; the reset comparison alone decides whether the
cycle moved. `breakCount` counts all of them while `breaks` transports only the last twenty, and
`changes.recent` is capped the same way. The full record stays in the database; the response must
not grow with the number of readings.

`coverage` and `periods.*.coverage` say how much of a span was actually watched. Only forward gaps
inside the twenty-minute threshold count as watched time, and overlapping spans are merged before
they are added, so a reading that arrived out of order cannot push coverage above the span it sits
in. Each of the five usage periods is computed from the retained readings inside it, never from the
180-point chart array and never from an interpolated midnight boundary. `coverage.horizonHours`
names the read horizon, thirty days plus the gap threshold, which fully contains the longest period.

`analytics.quotaAdjustment.appliesTo` is `forecast-and-capacity`. The existing one-point downward
tolerance still smooths the exhaustion forecast and the limit-value estimate, and it does not touch
the record: the same half-point dip appears as `adjustedSamples: 1` in the estimate and as a real
`decreasePp` with `monotonic: false` in `quotaPrecision`. The two disagreeing on purpose is what
separates an estimate from an observation.

Readings are separated by the account they were read from. The identity travels with the reading
rather than being looked up when it is stored, because the public account id outlives a physical
replacement and an epoch's recorded start is when we noticed the change, not when the reading was
taken. This bounds the exhaustion forecast and the limit value too, not only the new record: after
an account is replaced behind the same id, the arriving account does not inherit a burn rate or a
dollar value measured on the account it replaced, and `12.34` on one is never joined to `12.56` on
the other as a `0.22` movement. A reading with no identity evidence stays unknown and is never
credited to whoever holds the id now, so samples recorded before this feature shipped are excluded
from an estimate whose current reading has a known identity. An install with no direct provider
reads has unknown identity everywhere, including on the current reading, and is therefore
unaffected.

Evidence is written in the same transaction as the sample it explains, deleted on the same
retention boundary, and bounded by the same database page cap. A reading is recorded when anything
about it differs from the last one — any of the raw numbers, the basis, the cycle — or when its
timestamp moved backwards, and otherwise at most once per four minutes. Because the two writes are
deduplicated independently, the record a sample is identified by is marked at insert time rather
than matched afterwards by timestamp. Rows recorded before this feature have no evidence and stay
unknown; history is never rewritten to fill them in.
