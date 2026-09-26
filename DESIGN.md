# Quota Manager for OCX

Display name **Quota Manager for OCX** / **쿼타 매니저 for OCX**, short form **OCX QM**. Shared terms:
남은 한도, 사용현황, API 환산액, 모델 가격. The macOS menu-bar project uses this name and these terms;
native screens belong to that project. Storage, service and setting identifiers keep the earlier
`quota-monitor` spelling — README lists them.

## Native Mac menu-bar client

The `macos/` client is a 400-point utility popover: a summary selector and a bounded three-column provider grid, provider
headings, and compact account quota bars. Use native system typography (headline
13pt, body 13pt, quota labels 11pt), semantic light/dark system colors, the system
blue accent, and SF Symbols for refresh, settings and pin actions. This adapts
the existing utility design to macOS controls. Variance 3, motion 1, density D4;
no concept images are needed. Keep financial analysis in the web dashboard. Toolbar controls are plain SF Symbols; quota percentages use 14pt semibold blue/orange tabular figures and 5pt capsule tracks.
Unavailable readings display `—`; errors retain previous data with a visible
warning. Account and provider lists stay top aligned. The initial loading state reserves body space. Content and chrome measurements drive explicit NSPopover sizing up to the status item display limit; the provider selector caps at 120pt and scrolls separately. Selecting a summary pin persists that one provider/limit in the menu bar.

## Web dashboard

A Korean quota utility that shares the OpenCodex GUI's visual language: a white/near-black monochrome base, hairline borders, flat opaque surfaces, pill controls, and monospace only for machine data. Semantic colour is reserved for state — green for a healthy quota, amber for a low one or a warning. The overview puts each provider in one row, with remaining quota first and API-equivalent usage beside it. Account details use the same columns, typography, and quota tracks. Utility density D4, design variance 3, motion 1; feedback only. Existing SVG controls and text provider names are sufficient; no concept images or new icon dependencies.

### When the reading cannot be refreshed

A screen that empties itself when the network hiccups is worse than one that admits its age. So the
dashboard keeps the last reading on screen, says in one line that the connection dropped and that the
values below are the previous ones, and goes on judging their freshness on its own clock: a window
whose account has not been read for fifteen minutes, or whose reset has passed, is marked stale with
the reason, whether or not a new response ever arrives. Losing the network is stated differently from
a server that cannot be reached, because the two behave differently — an unreachable server is asked
again every ten seconds, while a browser reporting no network stops asking until it returns.
`scripts/ui-flow.ts` step 08 is the check for all of this.

### OCX GUI reference

Reference commit `c15a98caa9ab4b24256bd16a49b0947bea72d5c6` of OpenCodex, files `gui/src/styles.css`, `gui/src/styles/provider-quota.css`, `gui/src/App.tsx`, `gui/src/ui.tsx`, and `docs/design-system/{README,foundations,components}.md`. Re-pin this commit before a later alignment pass: the values below are copies, and drift is only visible against a stated source.

| OCX GUI | Quota Manager | Note |
|---|---|---|
| `.app` shell | `.app`, `.sidebar`, `.main-inner` | 232px rail, then page head, then body |
| `.nav-item` | `.nav-item` | Same padding, radius, control text, soft active background |
| Off-canvas drawer | `.sidebar.open`, `.mobile-topbar`, `.drawer-scrim` | Below 760px the rail becomes a drawer |
| `.btn.btn-ghost` | `.refresh` | Pill, hairline border, raised hover |
| `.input` | `.search input` | See the boundary exception below |
| `.badge`, `.badge-amber` | `.badge`, `.badge.warning` | Pill, caption text, semibold |
| `.bar` / `.bar-fill` | `.track` / `.fill` | 5px track, `--radius-2xs`, semantic fill |
| `.card` | `.summary-list`, `.provider-group` | Border and surface only; padding belongs to the context |
| `.stat` | `.metric` | Label, value, note; monospace value |
| `.empty` | `.empty` | Dashed border, centred, one action |
| `.notice` | `#notice` | Soft tinted background with a matching border |
| `.page-head` | `.page-head` | Title left, actions right |
| Segmented filters | `.period-picker` | Pill group on a raised track |

### Tokens

`web/style.css` is the web token source and the only place a literal colour appears. Colours are declared once with `light-dark()`, so light and dark are one definition instead of two blocks.

- Surfaces: `--bg`, `--rail`, `--surface`, `--raised`, `--raised-hover`, `--border`, `--border-soft`
- Text: `--text`, `--muted`, `--faint`
- Primary: `--accent` (monochrome), `--accent-ink`, `--accent-soft`, `--accent-ring`
- State: `--green`, `--amber`, `--amber-soft`, `--red`
- Geometry: `--space-*` on a 4px grid, `--radius-2xs|xs|sm|pill`, `--control-sm|md|lg|touch`
- Type: `--font-ui` with Korean fallbacks, `--font-code` for machine data, eight `--text-*` roles, three weights, four line heights
- Motion: `--motion-fast` for colour, `--motion-normal` for position and size

`--accent` is monochrome here — the same near-black or near-white as `--text` — so it can no longer carry the quota bar. A healthy remaining quota is `--green`, a low one is `--amber`, and an expired measurement is `--faint` at reduced opacity. Selection is background plus semibold rather than a blue label, and links and hovers keep an underline, so no state depends on colour alone.

One deliberate exception: the search field's boundary uses `--faint`, not `--border`. OCX's `.input` puts `--border` on `--raised`, about 1.14:1, below the 3:1 that WCAG 1.4.11 asks of a control boundary. Every other border follows OCX.

### Information hierarchy

- Overview: one provider row contains its name, account count, matching quota windows, selected rolling-period usage/quota consumption sum, and estimated account need. The 1-hour / 5-hour / 24-hour / 7-day / 30-day buttons appear only here; `24시간` means the trailing 24 hours. Account need extrapolates the selected quota consumption rate to the weekly or monthly allowance. Provider-defined remaining-quota windows do not change with the selection.
- Provider/all accounts: all rolling usage totals, a collapsed estimate breakdown, then accounts; no toolbar period buttons. Each provider estimate and each account calculation disclosure has its own labeled period select, defaulting to7days and independent of the summary and sibling details. Each account aligns remaining quota, 100% API-equivalent limit, remaining API-equivalent amount, and exhaustion estimate. Hide Codex Spark windows across the web dashboard and the native panel, so both surfaces summarize the same limits; other model-specific and credit windows remain visible. Hidden windows do not determine the displayed account status.
- Account details: usage, tokens, observation time, subscription-price ratio, quota history and calculation evidence. Long diagnostics and price references remain collapsed. Keep necessary uncertainty visible with `≈`, `일부`, or a short unavailable-state label.
- Model prices: one destination listing every provider's models with their four unit prices, the confirmation state, and the source behind each rate. A confirmed zero is `$0.00` and an unknown rate is `미확인`; a partially published rate set is `일부 누락`. Conditions that bill differently for the same model — long input, service tier, cache-write retention, schedule phase — are separate blocks in the detail, each naming what selects it, the multiplier applied and its own rates, so no two prices share a line. Flat subscription and API-equivalent unit price stay separate statements.

### Meaning

Summary percentages are equal-account averages of matching windows, not a weighted pool or one global balance. Each account contributes its remaining percentage once. Ignore paused/reauth/unavailable accounts and missing, invalid, expired or older-than-15-minute measurements; one expired window does not invalidate another fresh window. Show the measured-account count in the accessible description, with the full rule in calculation details.

Measurement age and lookup status are separate. Account headings show the last successful observation age and a quiet second line only when lookup is delayed, including the next retry when scheduled. A transient failed lookup keeps recent bars, summary participation and estimates; it never advances the observation timestamp. Do not use an “이전 측정” badge. Muted quota rows explain an actual expiry, elapsed reset, invalid measurement, paused state or login requirement. Keep the existing utility density D4, variance 3 and feedback-only motion 1.

API-equivalent usage is a reference cost, not a charge or savings. Use `API 환산액`, `100% 한도`, `잔여분`, `소진 예상`, and `필요 계정` consistently. Missing values use `—`; zero is reserved for a measured zero. Partially priced totals carry `일부`. Estimated capacities always carry `≈`; incomplete capture and changing model mix prevent a guaranteed lower bound. A window whose quota also moved without any priced usage carries the badge `보수 추정` and names that movement in details, because its estimate was divided by consumption the log could not price. Subscription ratios are named `구독료 대비 환산액`, not performance or efficiency. Recommendations display as estimates, with the selected quota consumption, weekly/monthly allowance and coverage available in details. A usage row shows only what changes with that row — its call count, and `일부` when part of the total went unpriced. An assumption that holds the same across the whole screen, such as cache estimation, is stated once in a single sentence under the usage area and kept on the cell as `data-pricing`/`data-cache` and in its description, rather than repeated in every row's note. The calculation details name what the total left out: the unpriced calls, the tokens actually recorded for them, what the cache assumption changed, and the calls priced from the local catalog. Calls whose stored token count is zero are counted separately, because storage cannot tell a missing usage report from a reported zero and neither may be shown as a measured zero-token exclusion. States that need action stay in place and are never absorbed by that sentence.

### Interaction and layout

Collection logs use the same pill period controls, labeled selects, flat bordered tables and semantic badges. Labeled filter selects share the search field's `--faint` boundary exception. Summaries keep their all-result denominator when the request list is filtered by result. Detail metadata sits in native disclosures with their built-in markers. On mobile, tables scroll within their own labeled region rather than widening the page; filters wrap and retain touch-sized controls. The read timestamp is quiet (`aria-live="off"`); the status region speaks only user-initiated loads and failures. Loading, empty and failed reads are explicit, and a failed refresh retains the previous log page. The collection destination hides financial footnotes and states that these are quota lookups, not inference calls. Details are retained for 30 days; historical failures are not reconstructed.

Sidebar order, overview order and account groups share browser-persisted provider ordering. Order editing sits in the sidebar. At 760px and below the rail becomes an off-canvas drawer behind a top bar: the menu button opens it, the close button, the scrim and Escape all close it, and focus moves to the close button on open and back to the menu button on close. While the drawer is open the page, the top bar and the skip link are `inert`, so neither Tab nor Shift+Tab can reach a control behind the scrim. Choosing a destination on a narrow screen closes the drawer and moves focus to the page title. Crossing the breakpoint in either direction moves focus off whichever control just became hidden. Provider rows stack at that width, and quota/value columns wrap without horizontal page overflow. Maximum page width 1500px, content width 1200px. Mobile controls are at least 44px. Keep a visible keyboard focus and respect reduced motion.

Refresh every 10 seconds while visible. Preserve selected provider, period, search, open disclosures and keyboard focus across refreshes. Failed refreshes retain previous values with a connection warning. Re-evaluate observation/reset expiry locally so stale snapshots cannot remain current while offline. Search applies to account rows; provider totals remain clearly labeled as all-account totals.

Quota consumption uses retained history anchored to the snapshot time, independently of current collection status. Same-account, same-basis fixed-cycle gaps may contribute a recovered total; long gaps crossing the selected period boundary are never spread into that period. Summary hover text and expanded account details identify the included recovered pp. Observation coverage excludes recovery time and missing prefix/tail time. The DB stays raw; contradictory or reversed observations remain in precision evidence and are barriers to aggregate pairing.
