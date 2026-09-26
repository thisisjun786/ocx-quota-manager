# Quota reads, forecasts and pricing

## Direct quota reads

Quota collection no longer requires OpenCodex to be running. If a valid credential is
already on disk, the monitor can read a provider's own quota endpoint itself, so neither the
OpenCodex process, its management API, nor `admin-api-token` is a precondition any more.
`QUOTA_OPENCODEX_ORIGIN` still works and is still read when set; it is simply no longer
required. A missing or malformed `config.json` produces a warning and a roster rebuilt from
the credential stores instead of a failed snapshot.

Credentials are reused read-only. Only these files are read, and no other home or keychain
is searched: `config.json`, `auth.json` and `codex-accounts.json` under the OpenCodex home,
`auth.json` under the Codex home, and `.credentials.json` under the Claude home. Only an
access token or API key is used. Refresh-token exchange, login, account selection and any
write to a source file are never performed — when a credential expires and its owning client
does not renew it, collection stops and the last observation keeps its own timestamp. Tokens
are held in memory and reachable only through an accessor, so they do not appear in the API
response, the database or the logs.

Observations are separated by physical account. An internal identity epoch, distinct from
the published account id, is persisted so that refreshing a token keeps one account's
history while replacing the account, organisation or key starts a new boundary. A reply that
arrives after the account behind an id has changed is discarded rather than filed under the
previous one. For an API key, where the key itself is the only identifier, sameness cannot be
proven across a restart, so the boundary is reopened rather than assumed; nothing derived
from a credential is written to the database.

Each window may carry an optional `measurement` describing what the number is based on: the
provider's reported percentage, a used-over-limit calculation, or neither. Where both exist
the reported figure is published and any disagreement is preserved rather than reconciled
away. `schemaVersion` 1 and the existing menu-bar selection keys are unchanged, and the
published fields are identical whether or not a direct reading is present.

Seven endpoints are declared for six providers. Codex reads its usage endpoint on
`chatgpt.com`, Claude reads `api.anthropic.com/api/oauth/usage`, Cursor reads its own period
usage on `api2.cursor.sh`, and Grok reads weekly credits and the legacy monthly pool
separately on `cli-chat-proxy.grok.com`. Hosts and paths come from a fixed table rather than
from any configured base, and a credential is sent only when the provider's configured base
is the vendor's own — a configuration pointing a provider at a relay means the token on disk
was issued by that relay, and it is never forwarded to the vendor. A provider that is turned
off is neither read nor published.

Which window a reading belongs to is decided by what the provider declares, not by where it
sits in the response. Codex classifies by `limit_window_seconds`, so a seven-day primary
window is the weekly limit and never the five-hour one. Claude keeps its overall five-hour
and weekly windows apart from the model-scoped weekly ones, which arrive both as named
buckets and in a `limits` array and are collected once. Cursor's reported percentage and the
spend it reports are both preserved: the reported figure is published, the computed one sits
beside it, and they disagree often enough that the disagreement is recorded rather than
resolved. Grok's weekly and monthly windows come from different endpoints and neither stands
in for the other; an omitted percentage stays unreported rather than being read as zero.

Decimals are passed through without intermediate rounding. Seeing a decimal is recorded as
evidence that the provider can report one; seeing a whole number is not recorded as evidence
that it cannot, so no resolution is ever claimed from a single sample.

One account can be read by more than one endpoint. Each endpoint keeps its own stored result
and its own freshness, so a failure on one does not withdraw the other's reading, and a
window measured twice goes to the earlier adapter in the registered order rather than to
whichever reply arrived last. `account.directQuota.endpoints` reports each endpoint
separately, and the account's own status reads `partial` when some endpoints answered and
others did not.

Each window is judged by the reading behind it: it is published when that reading is at least
as new as what the account already carries, and a window this reading does not cover keeps
whatever the earlier source published. An account read by several endpoints therefore has no
single instant that is true for all of its windows, so each window carries the instant it was
measured at and a history sample is recorded at that instant rather than at the account's.
`account.updatedAt` still reports the newest reading, which is what decides whether the
account as a whole looks current, and the published response is unchanged.

Registering the adapters is what enables this path. The adapters live in `internal/collect`;
adding a provider is adding a parser there and registering it with the collector.

The service entry point turns this on through `QUOTA_DIRECT_PROVIDERS`, a comma-separated
list of provider ids. Unset or blank is off, and off passes `createCollector` the same empty
list and null hook it already defaulted to, so an install that does not set it fetches
nothing and publishes exactly the fields it published before — including no
`analytics.directQuota`. A list rather than a switch, because the question worth answering
is which providers are being read.

`openai`, `anthropic`, `cursor` and `xai` register the shipped adapters above.
`command-code` and `opencode-go` register the two readers that are built per destination.
The Go runtime also registers `kimi`: opt in with `QUOTA_DIRECT_PROVIDERS=kimi`
(or append it to the existing list). Its fixed GET endpoint is
`https://api.kimi.com/coding/v1/usages`; only the canonical Code base is accepted.
Five-hour and weekly limits remain independent, and total subscription credits
remain a separate scoped window. Stored OAuth or active API-key credentials must
match the configured authentication mode. Expired credentials are renewed by OCX,
not by this monitor.
A name nothing ships is reported on stderr and ignored rather than enabling anything.
Whichever providers are named, a credential is still only sent where the endpoint table and
the configured base agree it may go, and turning a provider off in OpenCodex still stops it.

The Command Code and OpenCode Go readers are built per destination rather than declared in
that list, because each is constructed with the provider’s configured destination. Their
destinations are declared in the same endpoint table and carry the same accepted origins, so
the base check applies to them exactly as it does to the rest.

Two providers now have a reader of their own. Command Code's five-hour and weekly windows come
from the used and the cap of the same window, so a limit that exists with nothing used against
it publishes 0 percent rather than disappearing, and a window that has not opened reports no
reset rather than one in 1970. The credit pools and the lifetime spend beside those windows are
a different quantity and never become a window limit. OpenCode Go keeps the rolling, weekly and
monthly percentages it reports and derives no used-over-limit pair from plan prices; a window
whose `status` is a string other than `ok` is left out instead of published as a zero. The
endpoint table declares those two destinations beside the ones the direct provider reads use,
and nothing beyond the seven.

A reader is inert until it is given the provider's configured destination, and it then refuses
to spend a credential on a provider that was disabled or on a base URL pointing somewhere else.
Command Code also refuses a credential mode that is not the one routing requests and an
organisation account, when its registrar states one, whose scope a fixed endpoint table cannot
express; OpenCode Go is read with the provider key only. The credential contract those readers
waited on now carries the account reference, a configured organisation and the configured base
origin, and the base check and the disabled-provider guard are enforced by the reader rather
than by each adapter.

Naming `command-code` or `opencode-go` in `QUOTA_DIRECT_PROVIDERS` registers these two
readers, each constructed with the destination its provider declares in `config.json`. A
provider entry that declares no base is not a provider without a destination: that is the
state the credential contract calls `default`, meaning the client's own default applies, and
for both of these the default is the vendor's own host. A base that is present but unusable
is a different state and stays refused rather than falling back to that default. That
destination is re-read immediately before every credential-source read rather than once at
startup, because the readers decide applicability synchronously and so cannot wait on a file.
Those reads overlap, so at most one is ever in flight and concurrent callers join it rather
than racing; a configuration that cannot be read leaves the destination unknown, which both
readers treat as "do not send".

The destination and the account roster are two separate reads of that file, so a change made
between them is seen by one and not the other until both have been read again. What a stale
destination can still do is bounded, and the bound does not rest on the reader: the transport
checks the base carried with the credential itself against its own fixed endpoint table, so a
stale applicability decision cannot send anything to a host the configuration does not name —
it produces a refusal instead. Nor can it misattribute a reading, because a stored observation
is committed under the binding it was fetched for and re-checked against that account's epoch
and physical evidence. What can lag is which credential mode is considered worth reading, and
that settles once a later refresh reads a stable configuration. That is the staleness bound
each reader documents for its registrar.

An organisation-scoped Command Code account stays unread. The contract carries an organisation
that a configuration states, but this provider's organisation is not one of those: the client
reads that scope at runtime from the provider's own whoami surface and keeps it neither in its
configuration nor with the stored login, so a reader of those files has nothing to carry.
Reaching it needs the scope fetched, a query the fixed table cannot build today, and the
reader's own refusal lifted. A normal install still fetches nothing on this path.

Ollama Cloud is read through its existing probe rather than a second request: the same
`/api/usage` answer that files the per-model counters now also carries each window's
measurement, with the provider's own fraction kept beside the percentage derived from it. An
observation recorded before that fraction was kept keeps its number and gains no basis, because
dividing the stored percentage back does not return what the provider sent. A lookup that fails
reports which kind of failure it was — a refused credential, an unreachable provider, a sound
answer carrying no window, or a configuration that could not be read — instead of one word for
all four.

## Retained estimates during quota lookup failures

When a newer OpenCodex cache supplies the displayed percentage, an enabled direct reader
keeps ownership of that window's stored analysis. Its verified account identity and actual
observation timestamp travel separately from the display value. Cache/direct switching
therefore cannot reset consumption totals or required-account estimates. Derived balances
from an older direct reading remain dated historical estimates until that reader catches up.


A failed lookup does not erase DB-derived analysis. Windows keep a separately dated
`historicalCapacity` (100% allowance and remaining value at the recorded reading), while
current capacity, current remaining value and exhaustion forecasts remain unavailable when
stale. Account cards and provider averages label historical estimates explicitly. Values
remain API-equivalent estimates, not provider billing or a guaranteed current allowance.

`consumptionPeriods` always measures the selected trailing period ending now. If it has no
usable observation, `historicalConsumptionPeriods` can show the same duration ending at the
last eligible stored observation. The browser labels this as previous observations; account
recommendations are provisional and disclose differing account end times. It never fills
an unobserved current hour with fabricated usage. Identity and scope boundaries still apply.

Direct collection saves each endpoint's retry deadline and failure count with its existing
identity-bound record. Restarting the monitor preserves the deadline, including Retry-After,
without making a provider request just to rebuild the schedule. Successful collection resumes
normal pacing; a replaced physical account cannot inherit the old account's schedule.

## Usage efficiency and quota forecasts

The server samples quota and usage every 10 seconds even with no browser open. `QUOTA_DATA_DIR` (default `~/.local/state/quota-monitor`, respecting `XDG_STATE_HOME`) contains a private SQLite history database. OpenCodex files are still read-only. The collector saves only allowlisted quota observations and normalized usage totals; no credentials, emails, prompts, conversation IDs or credential contents are saved in the history database. Existing source `usage.jsonl` is imported incrementally; offsets commit with imported records, partial trailing lines wait for completion, and request/attempt IDs are hashed for deduplication. The database persists through service restarts. Treat it as personal usage data and back up this directory to retain history. Changing the data directory starts a separate history. A deliberate clean reset creates an empty database with a persisted `historyResetAt` timestamp and a usage-log cursor at the last complete pre-reset line. The collector excludes quota samples and usage entries older than that timestamp, including later log replays and rotation. That cursor carries no observation history, so observed coverage restarts at the first read after the reset, and the reset timestamp also bounds the observed span. Existing raw logs and account settings stay intact; archive the previous database before switching. Capacity and forecasts rebuild from the new observations.

Storage defaults: `QUOTA_RETENTION_DAYS=90` and `QUOTA_DB_MAX_MIB=512`. On collection, once per day, records strictly older than the retention cutoff are removed from quota samples, usage, usage timings, and Ollama observations in one transaction. A price link goes with the usage row it explains, and a price record is dropped once no link points at it. Cursor and pricing metadata remain intact. Imports skip expired rows even during replay, so source logs cannot repopulate removed history. The source OpenCodex logs are never modified. Retention must be at least 31 days to preserve the 30-day calculations. Back up before deploying a shorter retention policy.

The size limit applies to SQLite's main database pages, including indexes and free pages. Full storage fails new writes and the collector reports a collection error; it never evicts recent records to make room. Freed pages are reused; cleanup does not immediately shrink the file. WAL uses automatic checkpoints and a 16MiB post-checkpoint size target, not a hard total-directory cap: transactions or blocked checkpoints can temporarily exceed it. Leave disk headroom for WAL and backups. An existing database larger than the configured main-file limit is rejected without truncation. Increasing the limit or archiving data requires an explicit operational action.

`GET /api/v1/snapshot` retains schema version 1 and all existing fields. Additive `analytics` fields appear on the snapshot, providers, accounts and quota windows. No new web write endpoint is exposed.

- **Actual API equivalent:** rolling 1 hour, 5 hours, 24 hours, 7 days and 30 days, all ending at the same successful usage-log read. Boundaries and sample coverage are defined under [Usage periods](architecture.md#usage-periods). Each physical upstream attempt is counted once, including billed retries; parent totals are not added again. Amounts with unknown prices are partial subtotals, never zero-priced usage. Price basis and coverage are shown; a local catalog is an estimate, not verified official billing.
- **Average pace:** recorded API equivalent over the past 7 days (or available shorter log span), including idle hours. It keeps that 7-day sample whichever period is being viewed, and `pace.basisPeriod` names it. Normalizing this rate to 5 hours or 7 days is a usage forecast, not a provider quota limit. Providers without a 5-hour limit still have a time-normalized usage estimate, not an invented 5-hour quota.
- **Subscription value:** rolling 30-day API equivalent divided by the user's confirmed monthly subscription price, or a detected plan's public monthly list price when no override exists. Taxes, promotions, annual billing and actual payment dates are not inferred. Quota resets are not subscription renewal dates. Plan information comes from configured metadata or identity-bound local login/profile claims.
- **Quota velocity:** percentage-point change per elapsed hour, recent 1-hour view and average of observed intervals in the same reset window. Requires at least 5 minutes of new provider observations. Re-reading one cache timestamp is not a new observation. Only the latest contiguous run is used: gaps longer than 20 minutes, non-increasing timestamps, large downward adjustments, and intervening resets start a new run. Within a fixed-reset run, readings up to 1 percentage point below its high-water value are held at that value for calculation, so a dip and rebound cannot count the same consumption twice. A larger fall starts a new run; repeated small falls are compared with the high-water value, not the immediately preceding reading. The recent hour is anchored to the latest observation, with partial boundary intervals counted proportionally. Reset timestamp rounding within 60 seconds of the segment anchor is tolerated; a current run must also match the current reset within 60 seconds. Every rate and capacity calculation uses the same segment boundaries. Stale, paused and reauthentication-needed accounts do not receive a current exhaustion prediction.
- **Exhaustion ETA:** project remaining quota from the latest observation timestamp, using total consumed percentage points divided by observed hours over the latest 7 days, or all available history if shorter. Observed idle time and valid intervals from previous reset cycles are included. A gap over 20 minutes whose endpoints satisfy the same recovery contract consumptionPeriods uses (same account epoch, compatible basis, one fixed-reset cycle) contributes its whole consumption over its whole elapsed span, and gaps crossing the 7-day horizon boundary are never prorated; forecastRecoveredHours and forecastRecoveredDeltaPp report that share beside the watched-only forecastObservedHours and coverage. Other gaps, downward adjustments beyond the 1pp envelope, and intervals crossing a reset contribute neither time nor consumption. Held small dips contribute observed time without new consumption. Missing observations are not assumed to be idle. Each account and quota window stays separate. A positive forecast requires 15 observed minutes and 2 percentage points of change; this is only a minimum, not evidence of a mature long-term estimate. Under 24 hours is explicitly labeled an initial estimate. `forecastObservedHours` reports the actual denominator and `forecastRatePpHour` is this long-term mean; `recentRatePpHour` remains the recent hourly average of the same reconciled observations for diagnostics. `forecastObservedAt` identifies the measurement basis. Re-reading a cached sample cannot move the ETA. Compare it with the actual reset timestamp; expired resets suppress forecasts. Zero observed change produces no finite ETA, and an already full quota is exhausted before reset.
- **Selected-period quota consumption:** `consumptionPeriods` supplies the summary and account detail for trailing1h/5h/24h/7d/30d periods ending at the common snapshot time (`periodEndedAt`). Stored consumption survives stale/paused/reauth status, missing current resets and uncaptured current readings. A gap longer than20 minutes is recovered only when both endpoints lie inside the selected period and identify the same non-null account epoch, compatible measurement basis and fixed-reset cycle. Reported percentages without a numeric limit use a normalized100% allowance as an estimate; used/limit-derived percentages additionally require a declared cumulative counter; known denominator/source/scope changes, reset crossings, sliding/unknown windows and missing provenance never recover a gap. Reset-derived ISO or millisecond cycle keys tolerate60 seconds from the first cycle reset, without chaining drift. Long gaps crossing a period boundary are never prorated. Short intervals retain proportional boundary estimates and the1pp running-high correction, including estimated zero. `deltaPp` includes `recoveredDeltaPp`; `recoveredHours` is separate from `observedHours`. `coverage` divides observedHours by the entire selected duration, excluding recovered time from its numerator and keeping missing prefix/tail in its denominator. No usable interval yields null; a compatible flat interval yields estimated0. `spanHours` describes retained first-to-last time clipped to the period; `observedAt` is the last retained eligible reading. A reset confirmed only after a collection gap is reported as `resetGapCount`/`resetGaps` with the last pre-gap level, and the pre-reset tail it hides is never estimated. Storage-order identity/basis/reversal barriers prevent false joins. Raw DB rows and strict quotaPrecision remain unchanged. Raw observed percentages above100 remain in consumption even though bars and legacy forecasts are capped. The summary sums matching overall weekly windows, or monthly when no overall weekly window exists; model-scoped and short windows are not substituted. Only value/state is visible; hover and expanded detail explain partial and recovered evidence. Legacy forecastDeltaPp keeps its separate freshness and continuity requirements.
- **100% quota value:** matched API equivalent divided by the consumed percentage points of every contiguous interval whose usage log has been read, scaled to 100%. Every window calibrates over the last 30 days, not only its own period: the dollar value of a limit is a property of the plan, so more observed cycles beat a shorter, fresher sample. The quota history chart spans the window own period instead: five hours for a five-hour limit, seven days for a weekly one, thirty days for a monthly one, and seven days for a window whose length is not known. While a reading is unchanged the collector keeps one sample every four minutes instead of one per collection, which stays well inside the 20-minute gap threshold so idle time is still observed. A window without a reset timestamp cannot receive this fixed-cycle dollar conversion. Ollama has a separate low-confidence, counter-matched workload estimate described under Ollama legacy GPU quota; it does not assert a fixed reset cycle. A run is never excluded because its own dollars came out zero: that made the estimate depend on whether a stray cheap request happened to land inside a window consumed elsewhere. Runs with no priced usage contribute their consumption to the denominator and nothing to the numerator, are reported as `unexplainedDeltaPp`, and set `capacityBasis` to `lower-bound`, shown as `보수 추정`. Publishing a value still requires at least one run with attributed, priced usage; when none exists the value stays unknown rather than zero. Quota movement past the last log read stays out of both sides. Changes below 2 percentage points are retained as low-confidence estimates, with the rounding and refresh-delay limitation shown. Missing attribution or unpriced calls produce a partial estimate. `capacityMatchedQuotaCoverage` reports the share of observed quota growth linked to priced usage, and `capacityObservedAt` identifies the last matched run. These estimates are not guaranteed lower bounds: unrecorded usage pulls the value down, while integer-percent reporting can round a consumed interval down and push the value up. Custom model-specific/credit windows do not receive an all-model dollar conversion. Per-window values overlap and must not be added together. Untracked use outside OpenCodex can bias this estimate.

The 1pp envelope is a calculation assumption, not proof that a provider refunded nothing. It can absorb a real small downward adjustment or a trailing dip; capacity confidence is lowered when it applies. `quotaAdjustment` reports the tolerance and adjusted sample count. Stored observations, chart values and the current remaining percentage stay raw; freshness is checked against the raw latest observation. Missing resets remain unsupported by fixed-cycle forecasts and calibration; Ollama uses its separately labelled increase/workload estimates. Reset timestamps are anchored rather than chained across a moving window.

Account attribution follows installed OpenCodex's durable `main`, `p<hex6>` and `o<hex6>` labels, including `main` and `p<hex6>` provider suffixes. OAuth `o<hex6>` attribution uses the explicit `accountLogLabel` field. Ambiguous, removed or unlabeled accounts stay in provider totals and an unattributed subtotal; they are never assigned to today's selected account. Historical identity changes behind the `main` label cannot be reconstructed from usage logs alone.

Implementation: `internal/store` owns storage, ingestion, identity matching and price provenance, `internal/calc` and `internal/runtime` own the estimates, and `internal/collect` owns the timer and provider reads.

### Subscription count suggestions

The dashboard reads `analytics.quotaRecommendations[oneHour|fiveHour|twentyFourHour|weekly|monthly]`.
The rule is `ceil(total consumption pp / 100 * quota period hours / selected hours)`.
The overall weekly limit supplies168 hours; when absent, monthly supplies720 hours (30 days).
For example, four accounts consuming25pp each over24 hours total100pp and imply7 accounts.
No API-dollar conversion, learned dollar capacity, peak override or20% reserve is applied.
The same selected-period weekly-or-monthly measurements supply the summary sum and recommendation.
Zero measured consumption implies0; no usable readings remain unknown. Missing accounts or
short/gapped history stay provisional: recorded consumption and compatible recovered differences are summed, and the denominator
is the selected tab duration, so an incomplete record can underestimate need. Each account's
100% is one account-unit; different plans may supply different real capacity. Both the summary and account need use the monthly window when no overall weekly window exists;24h100pp then implies30 accounts. Estimates assume the current rate continues and round up fractional accounts.
Legacy `analytics.recommendation` and `analytics.recommendations` keep their USD-based
calculations for older API clients; the dashboard does not use them.
Subscription prices affect only the optional budget estimate, never the count.

### Confirmed subscriptions and Ollama credit comparison (2026-09-10)

The bundled subscription table uses these monthly prices (edit it for your plans): ChatGPT Pro $200, Claude Max $200, Grok $300, Cursor Ultra $200, legacy Ollama Cloud Max $100, and OpenCode Go $10 per account. `overrides` in `internal/runtime/subscription_catalog.json` supplies these with `basis: user-confirmed`. They take precedence over incomplete provider plan claims; the `plans` table still requires a known plan. Provider and overview subscription totals count all registered accounts. These amounts do not set quota capacities or imply migration to a new plan.

The standalone Ollama credit-comparison report was part of the retired Node implementation and is no longer shipped.

The default cache assumption is the sum of reported cache-read tokens divided by reported input tokens from other providers in the same interval. Only records with valid explicit cache fields enter this denominator; estimated tokens, absent cache, and Ollama itself are excluded. Ollama records with actual cache values keep them, including a measured zero. Only missing cache fields use the assumption. Missing reference data leaves the estimate unavailable until a manual rate is supplied. Models without a published cache price retain full input price and are counted separately.

Model prices are hardcoded from [Ollama's pricing table](https://ollama.com/pricing), checked 2026-09-10. DeepSeek prices double Monday through Friday, 12:00–18:00 UTC, using each request's timestamp. New Pro costs $20/month with $60 credits, Max $100 with $300, and Team $500 with $1,000. The comparison prices recorded work under those current rates; it is not the old GPU quota, an actual bill, a measured monthly credit balance, or a forecast. Partial token/model coverage remains visible. The raw-log comparison can include records older than a dashboard history reset; it does not restore them into dashboard history.

### Cursor cache assumption and 10-second refresh (2026-09-10)

Cursor API-equivalent amounts now use the same measured, token-weighted cache share as the Ollama comparison. The collector calls `compareOllamaUsage` on the retained raw log over the latest 30 days every five minutes. Cursor and Ollama are excluded from the reference; only valid, explicitly reported cache and input tokens from other providers count. This may include pre-reset raw observations for the reference average, but never restores pre-reset usage into dashboard totals. A report generated at another time or with a manual slider value is a separate scenario; matching log and interval produce the same default rate.

Only Cursor calls with absent cache-read fields and supported token/cache prices receive an assumption. Explicit cache values (including zero), malformed cache fields, reported cache writes, unknown models and unsupported price/tier cases are not replaced. Missing reference data leaves the undiscounted estimate; a failed reference read keeps the last successful rate and is marked stale. Cursor input/output tokens also remain estimates.

`cursor_cache_costs` preserves each eligible call's no-cache/full-cache prices and eligible input token count. The original `usage` amount, token fields and attribution remain intact. Existing history gets these coefficients during the normal pricing revision replay. `usage_valued` is a temporary read view applying the current average, so amounts, pace, quota value and recommendations all use the same rate; a new average updates existing eligible history without rescanning or rewriting those rows. Original zero-cache and other-provider amounts stay unchanged. Coefficients expire with the corresponding retained usage. `cacheEstimatedRequests`, `estimatedCachedTokens`, and `noCacheApiUsd` disclose the scenario separately from measured cache. The UI shows the applied percentage, before/after amounts, and an estimate marker.

The web timer, snapshot refresh hint, and server collection interval are 10 seconds. Local ingestion is single-flight; each provider has an independent external collection lane. Slow provider responses do not delay local ingestion or HTTP reads. Cache-reference scans remain five minutes apart. The separately installed native Mac application still uses its existing timer.

### Claude cache-write retention

`QUOTA_CLAUDE_CACHE_TTL=1h` and `QUOTA_CLAUDE_CACHE_FROM=<ISO instant>` select the one-hour cache-write reference price for `anthropic` calls at or after that instant. The start is inclusive; older calls, `anthropic-apikey`, Cursor-routed Claude and other providers retain their existing valuation. One-hour writes cost 2× base input, compared with 1.25× for five-minute writes ([Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), checked 2026-09-15). Input, output and cache-read token amounts and rates stay unchanged.

The setting is a user assumption because OCX's normalized log does not retain cache TTL. `anthropic.analytics.cacheWriteAssumption` exposes its TTL, start and basis; current model price quotes use the same setting after the start. Missing settings retain the five-minute default. Invalid TTL values and a one-hour setting without a valid start fail startup rather than silently choosing a different valuation. Set `5m` or remove the settings and restart to restore the original amounts.

`claude_cache_costs` stores each eligible call's five-minute and one-hour reference amounts plus cache-write token count. The normal pricing revision replay backfills these coefficients from retained raw logs, matching the existing row's identity, tokens and base amount. `usage_valued` applies the setting when reading statistics; it never overwrites the original `usage.usd`, tokens or attribution. Replaying or restarting does not duplicate calls. A row whose raw record is unavailable or does not match retains its original amount; a configured setting alone does not prove every retained call was revalued. Wait for pricing replay completion and verify matched row coverage before comparing amounts. Sidecar rows expire with their usage rows, and history-reset exclusions still apply. The previous release can read the same database and ignores the added table.

### Price evidence (2026-09-09, Ollama rechecked 2026-09-10)

Public subscription sources: [ChatGPT Pro tiers](https://help.openai.com/en/articles/9793128-what-is-chatgpt-pro), [Claude Max tiers](https://support.claude.com/en/articles/11049741-what-is-the-max-plan), [Cursor](https://cursor.com/pricing), [Ollama](https://ollama.com/pricing), [Grok](https://x.ai/pricing). Without a user-confirmed override, ChatGPT's stored `pro` label cannot distinguish tiers, and Claude Max also requires an exact detected tier. A published service price does not prove an account's plan.

API reference sources: [OpenAI](https://developers.openai.com/api/docs/pricing), [Claude](https://platform.claude.com/docs/en/about-claude/pricing), [xAI](https://docs.x.ai/developers/pricing). For the current GPT-6/GPT-5.6 reference rows, OpenAI prompt sizes above 272k use their long-context price; xAI at or above 200k uses its long-context price. Known confirmed service tiers are included; unsupported tier combinations remain unpriced. Cached input is included in input, reasoning is included in output, and neither is added twice. Claude cache writes default to the 5-minute price as an explicit estimate because normalized usage does not retain cache TTL. The time-bounded [Claude cache setting](#claude-cache-write-retention) can apply the 1-hour price to attributed `anthropic` usage. Gemini 3.8 Flash uses the exact installed OpenCodex 2.48.0 expected-price tuple as a **local catalog estimate**; the current official row was not located. GPT-5.4 mini uses its verified base input/cache/output rates; its unsupported long-context, Fast-tier and cache-write cases remain unpriced. Composer 2.5 Fast uses the official Cursor token rates and does not assume a cache-write price. Rates are reference valuations, not reconstructed historical invoices.

### New model prices and DeepSeek V4.1 Flash (2026-09-10)

The OpenCode Go rows use the [Go-specific official price table](https://opencode.ai/docs/go/), including Qwen/Grok/Luna context thresholds. Zen and Ollama have different tariffs and are not aliases for Go. Go DeepSeek peak hours are weekdays 01:00–04:00 and 06:00–10:00 UTC; Ollama retains its own 12:00–18:00 UTC schedule.

The [DeepSeek release announcement](https://api-docs.deepseek.com/news/news260910) sets the new Flash tariff's start to 2026-09-10 04:00 UTC. `deepseek-flash`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp` use $0.15 input, $0.003 cached input, and $0.60 output per million tokens off-peak; peak doubles all three. Earlier unpriced calls stay unknown because their historical tariff is not verified here. The direct DeepSeek API redirects V4 Pro to Flash from 2026-09-14 04:00 UTC. Go's post-transition Pro tariff is not yet confirmed, so those future calls stay unpriced until Go confirms it. No automatic Flash substitution is applied to Ollama. Go's monthly model limits differ, even across the Flash aliases; this module values tokens and does not merge or infer those quota capacities.

The collector also reads the installed OpenCode/models.dev cache at `$XDG_CACHE_HOME/opencode/models.json` (default `~/.cache/opencode/models.json`), or `QUOTA_MODEL_CATALOG`. Only an exact provider plus model match can supply a missing base price. Such values are always `local-catalog` estimates, never upgraded to official evidence. Official prices and explicit unsupported tariff conditions take precedence. Unknown cache prices, invalid/all-zero rates, unrecognized price tiers and unsupported service tiers remain unpriced. This read-only integration adds no network download; new models become available when OpenCode refreshes its local cache. Missing or invalid cache files do not interrupt usage collection; last valid rows are retained as stale, with status and timestamp in `analytics.pricingCatalog`.

### Model price evidence

`lookupModelPrice(provider, model, conditions)` returns one model's unit price together with the evidence behind it: `rates` in `usd-per-million-tokens` (input, output, cache read, cache write), `sourceUrl`, `checkedAt`, `effectiveFrom`/`effectiveTo`, the `conditions` that change the rate, and a `status`. A provider and an exact model ID are both required — a model ID alone never selects a price, because the same ID is published by many providers at different prices. It resolves through the same selection order the usage valuation uses, so a quoted unit price cannot drift from the amount recorded.

`status` ranks the evidence: `official` (the provider's own published page), `ocx-provided` (a price the installed OpenCodex publishes with its own source and check date: `gpt-daybreak-blue-latest` and `gemini-3.8-flash` from 2.55.0, and the Devin model table from 2.56.0), `local-catalog` (a models.dev/OpenCode cache row), and `unpriced`. When a lower-ranked source states a different number for the same conditions, the higher rank is used and the disagreement is reported in `conflict` rather than merged away. Both sides are compared after their own conditions are applied, so a catalog row without a long-context tier conflicts with a built-in rate that has one, and a catalog row carrying the same tier does not. The catalog expresses context thresholds and nothing else, so under an applied service tier or an active peak multiplier it states nothing comparable and no conflict is claimed. This is separate from the `basis` stored on each usage row, which remains the two-value estimate flag that existing capacity confidence and monthly value ratios read.

A missing rate stays `null` and a published free rate stays `0`; conditional multipliers never turn the first into the second. `unsupported` names a field whose tuple holds a number the valuation still refuses, such as Ollama cache writes. Effective windows are enforced, not decorative. Go's V4 Pro transition and the `google`/`cursor` Gemini 3.8 Flash promotional rate both stop at their published endpoint (2027-01-01T00:00:00Z for the latter) and stay unpriced afterwards rather than assuming a successor tariff nobody verified. Where a provider does publish the successor, both periods are recorded instead and the call is priced by its own instant; `devin/gemini-3-8-flash` is the current example.

`provider.analytics.modelPrices` lists models from two separate discovery sources, marked per row in `sources`: `ocx-config` (OCX's `providers.<id>.models` and `defaultModel`, minus provider-qualified `disabledModels`) and `observed` (models actually recorded in the usage log across retained history, uncapped). The models.dev cache supplies prices to these rows but never creates them, so a catalog of several thousand foreign models never enters the response. A model with no public price keeps its place with null rates and a reason. Model ids are validated by shape rather than by an allowlist, so real OCX context variants such as `k3[1m]`, `glm-5.3[1m]` and `claude-opus-4-8[1m]` stay listed, as does the catalog's leading-tilde alias `~anthropic/claude-opus-latest`; across the installed 2.55.0 package and the models.dev cache every model id passes. Configuration and home paths do not: a segment beginning with a dot is a hidden file rather than a model name, a tilde is an alias marker only as a single leading character of a two-segment id, and traversals, drive letters, whitespace and control characters are refused as before. A dot-free relative path such as `jun/config.json` is still accepted as a model name, because separating one from a vendor namespace is not something the shape can decide. Condition labels are sent once as `analytics.modelPriceConditions`.

Two limits are deliberate. These are the attributed provider's **current** prices, not a reconstruction of the tariff that priced a past call: usage attribution folds `chatgpt` and `openai-multi` into `openai`, so `providerBasis` is `attributed` and a stored key may quote a price the original key did not have. And the list covers providers present in OCX configuration, like every other provider panel; usage retained under a provider no longer configured has no row.

### Price evidence

`provider.analytics.priceEvidence` answers the other question: what actually valued the calls already recorded. Each row is one model and one distinct price record — source, evidence grade, unit rates, tier multiplier, conditions, effective window, and the catalog revision that first produced that content — with the request count, the stored amount, and the spans the calls and the pricing cover. A record is identified by what it says rather than by the revision that produced it, so a catalog rewrite that leaves a price alone does not split it into a second record.

The record is written once, by the write that settles an amount, and no statement updates one afterwards. Three things follow. A later tariff cannot restate what an already settled call was valued by. A row that was unpriced gets its record when a replay fills it. And a model the catalog has since dropped keeps its rates here while its `modelPrices` row reports no current price at all.

A row whose amount was stored before this field existed carries `evidence: null` and keeps it. A current price is never applied backwards to explain an old amount, so the absence is reported rather than filled.

`storedApiUsd` sums the stored amounts, and it is not `stats().apiUsd`. The Cursor cache average and the time-bounded Claude cache setting revalue eligible rows on read through `usage_valued`; the record describes the number that was stored. Model names pass the same shape and secret gates as configured ones, applied to both the recorded name and the canonical name the price was selected under, since an aliased call can be priced under an id that is itself a configured key. What that recognises is a key the current configuration declares, with the same residuals as the list above.

The list is computed on the collection cycle rather than per request, because the query covers the whole retained window and the database driver is synchronous; `analytics.priceEvidenceComputedAt` reports when it last ran, and a failed collection keeps the previous result rather than emptying it. It is not capped: a capped list would silently drop retained records, which is the opposite of what it is for.

`conditions` name only what this provider, model and input size actually price. `service-tier-priority` (priority and fast at 2x) is declared for OpenAI and xAI routes, but not for `gpt-5.4-mini`, whose priority rate is unverified, and not for xAI at or above its long-input threshold, where the combination is unverified. `service-tier-discount` (flex and batch at 0.5x) is OpenAI only. A tier the valuation refuses is never advertised, and no price is invented to match a label.

A configured credential is treated as a secret wherever it appears, not only inside the provider that declares it: the `apiKey` and pooled keys read from OCX configuration are excluded by value from `supportedModels`, `defaultModel`, `modelPrices[].model`, `unpricedModels[].model` and account labels. A value that is not in that configuration cannot be recognised by shape and is not guessed at.

`provider.analytics.modelRoster` keeps what the price list cannot: the previous readings. `modelPrices` describes the configuration as it stands right now, so on its own it can never say whether a model is new, whether one disappeared, or whether a disappearance was real. The roster retains every model this installation has offered, in the same `ocx-config` and `observed` vocabulary, and names each transition once in `changes`: `added`, `removed`, `returned` for a model configured again after a removal, and `observed` for one the usage log saw without it ever being configured. `models[].state` is `listed`, `removed` or `observed-only`, and a removed model keeps its identifier, its `firstSeenAt` and its priced history — removal ends a listing, it does not delete a record. The roster's own reading state is separate from the collection's: `analytics.modelRoster` carries `lastSuccessAt` for the last list actually read and `failureSince` for an unbroken run of failures, so a configuration that cannot be read never reads as a configuration without models. A usage log that fails after the list was read is not a failed lookup.

A first reading is a baseline rather than a page of new models, and a provider's basis is settled by its first reading that lists something: a list that projects to nothing never becomes one. A reading that would drop a model and lists nothing but the default selector is exactly what a mistyped `models` field projects to, so it is held as `suspect` with the previous list intact instead of being recorded as removal. The consequence is deliberate and worth stating: emptying a provider's models, disabling all of them, or reducing the list to exactly its default selector is retained as suspicion rather than confirmed as removal, and the price list will disagree until a caller supplies `modelListStatus`, which confirms a verified list as it stands. A model is forgotten only when a lookup that actually ran shows the usage log no longer holds it and its last activity predates the retention boundary; a failed lookup and an absent provider forget nothing. Two limits are shared with the price list rather than solved here: a model that was never called leaves `modelPrices` as soon as it leaves the configuration and survives only in the roster, and a rotated credential whose old value was recorded as a model name in the usage log is republished by both surfaces, because only the current configuration identifies a secret.

A key counts as present when it stands as a complete piece of a value, delimited by whitespace or by the punctuation model syntax puts around a name (`/`, `:`, `[`, `]`, `~`). That is what keeps a decorated key out: `<key>[1m]`, `vendor/<key>:latest` and `hf:<key>` are all excluded, and every occurrence is scanned so a bounded later one is not missed. The in-word characters `-`, `.`, `_`, `+` and `@` are deliberately not delimiters, because a key of `gemini-3` must not delete `gemini-3.8-flash`; an earlier revision used a raw substring rule and it removed 126 real model names.

Two consequences are intended, and they pull against each other. A key written as a whole piece of a real model id removes that id, so configuring `k3` as an `apiKey` drops `k3[1m]` from the list. And a key wearing an in-word suffix, such as `<key>-x`, is not recognised at all. Tightening either one loosens the other, so both are stated rather than fixed: the rule leaves an ordinary model name alone unless the name literally contains a configured key as a whole piece. These residuals, and the dot-free relative path above, can arrive from the usage log as well as from configuration.

The pricing-source digest and normalized catalog revision trigger an idempotent replay from retained raw logs. Replay fills only null amounts with matching provider/model/time/token records, preserves already-priced amounts and original attribution, and honors retention and `historyResetAt`. A price record attaches to the same write that settles an amount, so a replay records what it just used to fill a row and leaves an already-priced row's record untouched. Failed batches resume from their committed cursor without inflating invalid-line counts. Removed/rotated-away raw records cannot be recovered. Already-priced base amounts stay immutable; the Cursor cache and time-bounded Claude cache settings revalue eligible rows through `usage_valued`. Other historical repricing still requires a separately named data directory. The dashboard lists up to 20 unpriced models per provider and shows sub-cent amounts to six decimals so a small successful call does not round to $0.00.

### Price confirmation gaps

`provider.analytics.priceGaps` answers a third question beside the two above: which models still need a price checked, what is missing from each, and how many calls and tokens every one of the five usage periods rests on that. It judges the `modelPrices` rows published in the same response, so a finding and the row it describes cannot drift apart.

`modelsNeedingPriceCheck` counts **models**, never reasons, and is derived from the length of `models` rather than tallied beside it. One model routinely carries several reasons, so a reason count would disagree with the list it heads.

| Reason | What it means |
| --- | --- |
| `price-missing` | The quote resolved no price at all; `detail` carries the lookup's own reason |
| `unpriced-usage` | The current price is complete, yet recorded calls were still excluded from the valuation |
| `rate-missing` | A rate item is absent, undeclared and actually needed; `items` names each with its `need` |
| `source-missing` | A price with no source link |
| `checked-at-missing` | A price with no last-checked date |
| `condition-missing` | A catalog row stating rates and nothing about what changes them |
| `alias-unevidenced` | A rate taken from another model id that the provider's own page has not confirmed |
| `price-conflict` | A lower-ranked source states a different number for the same conditions |

`unsupported` is a published statement that a source bills nothing for an item, so a rate it names is declared rather than missing. Only an undeclared `null` is unconfirmed, and then only where recorded usage reaches it: an absent cache-read rate is an item once cache reads have been recorded and not before, and a configured model nobody has called yet acquires no item at all. Cache-write need is the one thing that cannot be observed, because a usage row retains input, output, cache-read and total tokens and no cache-write count. Such an item is reported with `need: unknown` alongside the others, but it never raises `rate-missing` by itself, which would warn about every model with no published cache-write rate whether or not anything ever wrote a cache. When one does bite, the call it could not price is excluded and reported as `unpriced-usage` instead. An unpriced model reports its missing price once rather than restating every field it necessarily lacks.

`unpriced-usage` exists because the valuation and the quote are not asked the same question. A quote is taken for the model as it stands now; the valuation also weighs the input size, the service tier that was actually applied and the instant of the call. So a model whose current price looks complete can still hold calls nobody could value, and without this reason those calls would vanish from the impact while the model looked confirmed. Every excluded call in a period therefore lands in one of three places and none is lost between them: attributed to a flagged model, counted under `withheldModel`* when it was recorded under a name this response may not repeat, or under `unnamedModel`* when no model name was recorded at all. A name is withheld when its shape is not a model id or when the configuration now holds it as a credential; its calls are still counted, just never named.

`periods` reports calls and tokens for the flagged models across the same five trailing spans, on the same anchor and the same half-open boundary as `analytics.periods`, read from the exported `usageAnchor` rather than derived a second time. `unpricedRequests`, `unpricedTokens` and `unpricedUnsizedRequests` mean exactly what `unknownPriceRequests`, `unknownPriceTokens` and `unknownPriceUnsizedRequests` mean on the provider period, because both read the same re-valued rows. No amount appears anywhere in this object: what a missing price would have cost is not estimated. A period in which nothing was priced keeps `apiUsd: null` on the provider row rather than reporting zero, which would claim the calls were free. A call with no recorded model name can carry no finding, so it is reported on its own as `unnamedModel`* rather than dropped.

`findings[].key` is stable across readings, so one shortage is one entry however often it is read, and `changes` names each transition once as `opened`, `resolved` or `recurred`. A recurrence keeps the original `firstSeenAt` and counts itself in `recurrences`. A provider's first reading is a baseline rather than a page of new problems, and `since` says where the recorded history starts: nothing before it is claimed resolved. A finding nothing has seen since the retention boundary is forgotten whether or not it closed, and a provider that left the configuration is forgotten whole once that boundary passes the last reading that saw it.

Closing a finding requires a reading that actually ran, and absence is never taken for evidence. Only a model still present in the reading can show that a reason stopped applying; one that vanished is left alone, because a `models` field that failed to parse projects to the same empty list as a model deliberately removed. Coming back later is therefore not a recurrence. The price catalog reports a failed read and merely old rows with the same `stale`, so only an `ok` catalog and an `ok` configuration read resolve anything; anything else leaves every open finding exactly where it was and sets `resolutionBlocked`, with `catalogStatus` and `modelListStatus` reporting both sources verbatim beside it. A finding the live quote still shows is never listed as resolved, whatever the stored state last managed to record.

`confirmedNewModels` and `retiredModels` keep a priced arrival and a clean removal out of the shortage list, using the roster's own transitions: a model added with a confirmed price is an arrival, and one added without one stays a warning.

`modelPrices[].pricedModel` reports the id a rate was found under, which is how an Ollama tag alias becomes visible. It passes the same shape and secret gates as the recorded name, applied separately, because the two are different strings: a configured key is not a whole delimited piece of `<key>-cloud`, so that tag is admitted while the canonical name it resolves to is the key exactly. A canonical name the configuration holds as a credential is withheld as `null` and the borrowing it would have shown is then not named at all. Every identifier in `priceGaps` passes the gate again at publication, including stored ones in `resolved`, `changes` and finding keys, since a name admitted when it was recorded can be a credential by the time it is read back.

Two limits are stated rather than papered over. Devin's suffix collapsing happens inside the price lookup and its contract does not report it, so an alias of that shape cannot be shown and none is invented. And the gap state is recorded on the collection cycle rather than per request, so `analytics.priceGaps.lastSuccessAt` can be older than the response by up to that interval while the judged rows themselves are current. The impact query is read against the response's own anchor and cached on that anchor together with a revision of the rows behind it, so it runs once per change rather than once per request. Two simpler keys look sufficient and are not. The anchor lags, because ingestion commits batch after batch and yields between them and sets the anchor only once the whole file is consumed, so a response taken mid-ingest would serve rows its own totals can already count. The import cursor repeats, because a pricing replay rewinds it to zero, rewrites the amounts on rows it already held, and lands back on exactly the offset it started from. The revision is therefore a counter advanced inside the same transaction as the rows themselves.

### Devin reference valuation

The `devin` and `devin-cli` routes price the exact model `swe-2` at its published list rates: $3 input, $15 output and $0.30 cached input per million tokens ([Devin models](https://docs.devin.ai/desktop/models), checked 2026-09-15). This matches OCX's list-price comparison. Free self-serve periods and enterprise discounts do not turn the reference amount into an invoice or a zero token price. Cache reads are included in input and are subtracted before pricing uncached input. Cache-write pricing is unconfirmed, so positive writes stay unpriced; unreported tokens, unknown models and unsupported service tiers also stay unknown. Other providers cannot inherit this model's price.

The flat part of the Devin table lives in `internal/store/price_rules.json` and is transcribed from the installed OpenCodex 2.56.0 overlay, so those rows read `ocx-provided` with check date 2026-09-13 rather than `official`. `gemini-3-8-flash` is the exception below: it was read from the provider's page and carries its own later date. Effort suffixes collapse to the base ID, and the collapsed ID is what the evidence is keyed on, so `kimi-k3-high` keeps the same provenance as `kimi-k3` instead of degrading to an anonymous catalog row. They are provider-scoped on purpose: a reselling surface charges its own rate for a model it forwards, and Devin's `grok-4-6` publishes $0.30 cached input where xAI's own `grok-4.6` publishes $0.50. A model ID alone therefore cannot select one of these rows. `kimi-k3` is the only currently supported Devin model this transcribed table newly prices (`gemini-3-8-flash` below is the other newly priced Devin model, from the provider's own page); the remaining rows cover models listed in the OpenCodex configuration but disabled today, so they do not appear in the price list until they are used again.

Cache writes stay `null` across the Devin rows added here and are reported in `unsupported`. The pre-existing `swe-2` row also publishes no cache write and refuses positive cache-write tokens, but it predates that field and reports an empty `unsupported`. This repository read no cache-write rate from the Devin page on 2026-09-15 while the 2.56.0 overlay carries one for some rows; rather than reconcile that disagreement into a number, positive cache writes stay unpriced. Publishing `0` would claim the write is free, and copying the upstream vendor's write rate would price a Devin call with another provider's number.

`devin/gemini-3-8-flash` is published by Devin as a dated pair rather than a single rate: an introductory tariff of $0.75 input and $3.75 output per million through 2026-12-31, and $1.50 / $7.50 from 2027-01-01 (rechecked 2026-09-17). Both are recorded, so a call is priced by when it happened; quoting only the introductory rate would let an ended promotion persist, and quoting only the regular rate would overstate calls made today. The quote carries `promotional` with an `effectiveTo` before the step-up and an `effectiveFrom` after it. Devin publishes no cache rate for this model, so `cache-read` and `cache-write` are both declared in `unsupported` and cache tokens stay unpriced rather than borrowing Google's. Effort suffixes such as `-high` collapse to the base ID the way the provider's own catalog does.

The upstream `google/gemini-3.8-flash` row is untouched and still stops pricing after its own promotional end date, because the successor tariff was never verified on that path. The same model answering differently on two surfaces is the intended result of ranking evidence per provider rather than per model ID.

`command-code` publishes its own per-token table for the DeepSeek models it forwards (`commandcode.ai/docs/resources/pricing-limits`, checked 2026-09-17): $0.15 input, $0.60 output and $0.003 cache read per million off-peak, with input and output doubled during the weekday UTC peak windows it states. Those rows are priced from that table and carry `peak-hours`. The credit plans the same site advertises describe how prepaid credit is valued, not the token rate, so they are not used. The published peak statement raises input and output only, so cache read keeps its single figure; and a call with no timestamp is left unpriced rather than guessing across a 2x boundary. A command-code model with no row in that table stays unpriced and says so, rather than inheriting the upstream vendor's rate. Every command-code model quota-manager currently supports or has observed does have a row, so this is the fallback path rather than a present gap.

`ollama-cloud` size tags such as `qwen3-coder:480b` remain unpriced because they appear only on third-party aggregators, not on the official price table. A subscription fee is never converted into a token rate.

The existing pricing revision replay fills matching previously unpriced records from retained raw logs. Original attribution, tokens, request counts and already-priced amounts are preserved. Model quotes carry the source date and `list-price-reference` condition. Missing or unreported usage cannot be reconstructed from the price table.

### Ollama legacy GPU quota

The collector polls the configured canonical Ollama `GET /api/usage` every five minutes per logical account endpoint with the existing API key (no inference requests). It persists only allowlisted quota fractions and per-model request counters in the monitor DB. Keys and raw API payloads are never exposed. API-key rotation starts a separate observation series. Session/weekly and migrated monthly windows remain distinct; missing reset timestamps are not invented.

Ollama calls retain input/output/cache tokens and latency per request. Published token prices provide a reference valuation, not legacy GPU billing. Existing unpriced Ollama history is replayed once with deduplication to populate reference values and timing records. Old request records are not assigned to the currently active API key.

Model calibration uses at least five minutes and 0.2 percentage points of net quota growth, contiguous samples, one changing model, and exact agreement between server request-counter growth and recorded calls. An unmatched single-model interval is retained until the provider counters and log agree across a wider interval; a successful match advances the boundary exactly once. Counter drops, percentage drops, non-increasing timestamps, gaps over three minutes, and mixed models break that interval. Missing or unreported calls never become a match. Only observations through the last successful usage-log read can calibrate capacity. Multiple distinct configured keys suppress model/token/USD calibration because provider-only logs cannot identify a key. Repeated aliases containing the exact same key are fetched once and collapse to the first still-present alias in the snapshot, so subscription counts and quota sums cannot count that source twice. Configuration files are not changed; different keys are not assumed to be different physical subscriptions. Separate input/output amounts per percentage point describe the observed workload mix; they do not independently estimate GPU input/output coefficients. Rolling-window expiry can offset consumption, so these are net observed ratios, not exact per-call GPU charges. Latency includes queue/network time and is never treated as GPU time. Reset and exhaustion forecasts remain unavailable when the provider has not supplied the necessary reset data.

Ollama's selected-period `consumptionPeriods` use `basis: observed-increase`: the sum of nonnegative adjacent quota changes across at least five observed minutes, with proportional clipping at period boundaries. Only stored fractions in range and intervals no longer than three minutes qualify. Missing windows, declines and model-counter drops break the interval; they are not claimed as resets. No gap recovery or 1pp dip correction applies. Unknown cycle semantics remain unknown. Flat readings can produce an estimated zero, since rolling expiry and new use may offset. These estimates feed the same weekly-or-monthly summary and account-count arithmetic, always provisional even with full coverage. Different API keys may belong to one underlying subscription; key totals are not proof of independent physical accounts.

Counter-matched model observations additionally publish `capacityBasis: workload-estimate`, always low confidence. The 100% API equivalent is matched dollars divided by matched percentage-point growth, scaled to100; model detail also scales input/output tokens to100%. These are ratios for the observed model/workload mix, not official GPU capacity or a bill. Unknown prices withhold the aggregate dollar estimate; model token evidence remains visible. Cache discounts and rolling expiry can materially change it. Stored consumption remains available when stale, but current capacity and remaining-dollar estimates are withheld. No reset time or exhaustion ETA is fabricated.

### Devin quota and Google API-key limits

Add `devin` to `QUOTA_DIRECT_PROVIDERS` to read the existing OCX Devin login. The fixed read-only Connect RPC is `https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus`. Its credential belongs in the JSON metadata body; no login, refresh-token exchange or inference is performed. Custom relay origins are refused before building the body. The monitor keeps only daily/weekly percentages and reset times, respecting `hideDailyQuota`; absent weekly quota is never filled with daily quota. Authentication without a physical account ID uses process-local credential equality: replacement invalidates old responses, and restart begins an unverified identity boundary without storing a token fingerprint. HTTP continues serving the last published snapshot independently.

The configured `google` provider uses a Gemini API key. Its limits are per project/model (RPM, TPM, RPD), not a weekly subscription percentage ([Google rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)). The documented [Cloud Quotas reader](https://docs.cloud.google.com/docs/quotas/reference/rest/v1/projects.locations.services.quotaInfos/list) requires Cloud OAuth plus `cloudquotas.quotas.get`; usage additionally needs `monitoring.timeSeries.list` ([AI Studio permissions](https://ai.google.dev/gemini-api/docs/troubleshoot-ai-studio), checked2026-09-18). The current key does not provide that identity. Usage logs remain collected, but no quota is invented and no unsupported forced management probe runs. A Cloud quota/usage reader requires a separately authorized project credential.

### Automatic provider refresh

The current Go runtime uses direct reads with the five-minute per-account endpoint cadence below. The management fallback and worker-lane descriptions in this section describe the earlier collector, not active Go behavior; see [the current data contract](architecture.md#data-contract). In particular, `QUOTA_OPENCODEX_ORIGIN` does not enable a management fallback in the Go runtime.

Set `QUOTA_OPENCODEX_ORIGIN=http://127.0.0.1:10104` to the existing local OpenCodex management listener. Only an explicit HTTP loopback origin is accepted. The monitor reads `admin-api-token` locally, never serves it, and issues GET quota refreshes only for providers without direct ownership, independently at most once every120 seconds. OpenCodex owns provider authentication and token renewal; no login, account selection, or inference endpoint is called.

Active refresh ownership is exclusive per provider:

| Provider | Owner when direct collection is enabled | Cadence |
|---|---|---|
| OpenAI | Direct wham usage |5m, account/endpoint backoff|
| Anthropic | Direct OAuth usage |5m, account/endpoint backoff|
| Cursor | Direct period usage |5m, account/endpoint backoff|
| xAI | Direct credits and billing (distinct endpoints) |5m, account/endpoint backoff|
| Command Code, OpenCode Go | Destination-checked direct reader |5m, account/endpoint backoff|
| Ollama Cloud | Dedicated usage reader, independent keys |5m|
| Devin | Direct GetUserStatus using existing OCX login; weekly and visible daily quota |5m + backoff|
| Google (Gemini API key), Devin CLI without direct ownership | Passive usage logs/cache; no supported OCX quota reader | No forced quota calls |
| Other enabled providers, or direct-off providers | Separate OpenCodex management reader per provider |120s|

A direct-owned provider never also receives monitor-triggered OpenCodex forced refreshes, including credential modes its direct adapter cannot read. Unsupported modes remain unavailable; existing passive cache values may still be displayed. OpenCodex's own independent scheduling is outside this monitor's control.

The server main thread reads only its last published snapshot in memory. A background worker owns SQLite, files and provider calls. It publishes retained data before starting network work and runs local ingestion then publishes a completed snapshot on a10second schedule, independently of provider requests. Slow ingestion leaves the previous complete snapshot available. Cold startup returns a collecting response immediately until retained data is ready. A publication failure or more than30 seconds without publication marks the retained response delayed/error; it never makes HTTP await the worker. Per-provider lanes prevent a slow provider from delaying another, and local log ingestion never awaits those lanes. Graceful shutdown drains writes before closing SQLite, with an8second worker termination bound for stuck IO. The explicit `collector.collect()` library call still awaits quota work for deterministic tests/offline recovery; production `start()` uses separate jobs.

Fallback OpenAI management refresh covers every native/pool account, OAuth providers every stored account, and API-key providers the per-key quota API. The direct Anthropic quota reader normally refreshes every five minutes per account endpoint; the legacy management fallback described below is not implemented by the current Go runtime. A failed request, missing account or unavailable account backs off forced retries for two, four, then at most eight minutes; a healthy sibling does not bypass this delay. A complete successful lookup restores the two-minute cadence. Newer valid account observations can replace an older failed lookup while retries wait. The web reads the monitor every 10 seconds. During a quota refresh, the last completed result stays available until the next result is ready. New configured providers are discovered on each collection. Ollama retains its dedicated probe for model counters. A legacy bare key is matched to OpenCodex's exact key-ID projection, without publishing a key fingerprint. Normalized measurements are persisted in the monitor DB so API-key quotas survive a restart. Failed, missing, expired, or reauth-required responses never acquire a fresh observation timestamp. A transient lookup failure preserves recent measured values and their calculations. Account `status` and window `stale` describe measurement eligibility; optional `account.refresh` separately reports `status` (`ok` or `delayed`), `lastAttemptAt` and `nextAttemptAt` (nullable ISO timestamps). The next-attempt time is a schedule, not a guaranteed completion time. The management response does not expose the upstream error reason, so the dashboard reports lookup delay without claiming every failure is rate limiting. Values older than 15 minutes, future-dated values, elapsed reset windows, paused accounts and reauthentication requirements remain excluded from current calculations. Repeated cache reads never add new observation timestamps or manufactured idle history.

Dashboard account need uses recorded quota consumption and its weekly/monthly period, independently of API-dollar valuation. Legacy dollar-based API estimates retain their pricing rules.

## Editing prices

Both tables are plain JSON embedded into the binary at build time; edit them directly and rebuild.

`internal/store/price_rules.json` holds one row per selector: `provider`, `model`, `peak`,
`inputFrom` (the prompt-size threshold in tokens where a long-context rate starts) and `tier`
(`default`, `priority` or `flex`). `quote` carries the rates in USD per million tokens (`input`,
`output`, `cacheRead`, `cacheWrite`, `null` when unpublished), `status` (`official`,
`ocx-provided`, `local-catalog` or `unpriced`), `sourceUrl`, `checkedAt`, and an optional
`effectiveFrom` / `effectiveTo` for dated tariffs. A call is priced from the row whose selector
matches it at the call's own time.

`internal/runtime/subscription_catalog.json` holds monthly fees: `overrides` per provider (applies
to every account of that provider) and `plans` per provider and plan name. A plan whose price
cannot be told apart uses `monthlyUsd: null` with `basis: "ambiguous"`.

`go test ./internal/store ./internal/runtime` rejects duplicate selectors, unknown tiers or
statuses, negative rates, priced rows without input and output rates, and malformed dates. Stored
amounts are not recalculated automatically: to re-price history for a changed model, bump
`TariffRevision` and add the model to `repricedModels` in `internal/store/tariff_revision.go`.
