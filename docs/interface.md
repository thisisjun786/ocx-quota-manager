# Interface

## Interface

The sidebar opens with 요약, 계정 현황 and 비용 분석, then the provider list; `#accounts` and `#costs` link to those views directly. 요약 starts with the accounts that need attention (below 30% remaining or a required login) and their reset countdown, or `모든 계정 정상` when there are none. Each quota bar takes the colour of the lowest account in its group: amber below 30%, red below 10%. 계정 현황 lists `analytics.accounts` by urgency; 비용 분석 draws `analytics.costs` for the selected 24-hour, 7-day or 30-day span, with a 30-day daily chart split by provider.

The default **요약** view presents each provider once: account count, average remaining quota by window, API-equivalent usage, and estimated account need. The 1-hour / 5-hour / 24-hour / 7-day / 30-day selector changes the usage period; it never changes or combines the provider's quota windows. It appears only in the summary; expanded provider and account details have independent period selectors. The 24-hour choice is labeled `24시간`, not `1일`, because the span is the last 24 hours rather than a calendar date. Figures that keep their own sample say so instead of following the selection. The five-hour and seven-day pace projections carry `최근 7일 속도 기준`. The suggested account count follows the selected period and names it as, for example, `최근 1시간 소모 합계 기준 · 주간 한도 기준`. Quota consumption also follows the selection; the actual remaining quota windows keep their provider-defined periods. The subscription ratio reads `구독료 대비 최근 30일 환산액`.

A provider opens its rolling usage totals and account rows. Each quota row aligns remaining percentage, estimated 100% API-equivalent limit, remaining equivalent and exhaustion estimate. Codex Spark windows are hidden in the web overview, account rows and details. Other model-specific and credit windows remain visible. This display choice leaves the API, collected history and usage totals unchanged. Unsupported conversions use `—`. Usage records, token breakdowns, forecasts, subscription ratios and calculation evidence are available in collapsed details.

API-equivalent amounts are reference estimates, not invoices or savings. `일부` marks a partially priced subtotal; `≈` marks estimated capacity. A subscription ratio is labeled `구독료 대비 최근 30일 환산액`. No recorded calls display `호출 없음`; unpriced calls display `단가 미확인`. Neither is silently converted to a measured zero.

A usage row carries only what changes with that row: its call count, and `일부` when part of the total went unpriced. An assumption that holds the same across the whole screen is said once instead of on every row. One sentence under the usage area reads "API 환산액은 실제 청구액이 아니며, 캐시 사용량은 추정될 수 있고 가격 미확인 사용은 합계에서 제외됩니다." and the cell keeps the estimate facts in `data-pricing`, `data-cache` and its description. The calculation details carry the evidence: the calls and the recorded tokens the total left out, what the cache assumption changed, and how many calls used a local-catalog price. A stored token count of zero cannot say whether the usage report was missing or the call really used nothing, so those calls are counted on their own (`unknownPriceUnsizedRequests`) rather than reported as a zero-token exclusion. States that need action — a login, a delayed lookup, an expired observation — stay where they happen and are never folded into that sentence.

A period also says how much stands behind it, using the two fields defined under [Usage periods](architecture.md#usage-periods) and keeping them apart. `기록` reports `logCoverageHours`: how far the retained usage log reaches over the span. It is a property of the log we kept for every provider, never proof that this account was watched that long. `관측` reports `observedCoverageHours`: how much of the span we were actually reading. A span we never read displays `미관측`; a span we read only part of displays `관측 부족`; a span the retained log barely reaches displays `기록 부족`, and one it does not reach at all with no calls displays `기록 없음`. A log length of zero is not the same as an absent row, because a first call timestamped at the read instant leaves the length at zero while the call exists, so a period with calls never reads `기록 없음`. The exact spans stay in the metric title and the calculation details. A period key an older response does not carry displays `미지원` and is never filled in from a different period; a response with no period object at all displays `기간 정보 없음`.

Summary bars average fresh accounts with matching window ID, label and model scope. For example, 50% and 100% remaining average to 75%. This is equal-account normalization, not a plan-weighted pool. Paused, reauth and unavailable accounts are excluded. Observation age, reset expiry and percentage range are checked in the browser; one expired window does not invalidate a different fresh window on the same account. Account rows show the last measurement age separately from lookup delay and the next retry. Temporary lookup failures keep valid percentages, summary participation and estimates. Only expired or invalid measurement rows are muted and hide current estimates, with a concrete reason instead of an “이전 측정” badge.

Quota figures are written to two decimal places, and only as many as the reading actually has: a
provider that reports a whole 28 displays `28`, never `28.00`, because the extra places would
claim a precision nobody measured. A positive reading too small to show reads `<0.01` rather
than `0`, since a measured zero and an almost-zero are different facts. The same care applies at
the top of the range: a reading that rounds to 100 but is not exactly 100 reads `>100` or
`<100`, so an overage stays visible and a not-quite-exhausted limit is not announced as
exhausted. The progress bar's accessible text uses the same figure as the visible one.

Where a direct reading exists, the account's calculation details say what the number rests on:
the provider's reported percentage and our own used-over-limit calculation side by side, the raw
used and limit with their unit, which reading and which scope it came from, the cycle key, the
window semantics, when it was observed and when it was fetched, whether the provider is known to
report fractions, and whether the two percentages agree. A disagreement is recorded, not
resolved. A field the contract allows to be null reads `미제공`; an instant that arrives in a
shape we cannot read reads `확인 불가` rather than being dropped or formatted into an error.

A reading that has no percentage is kept rather than discarded. Used credits against a limit of
zero, a missing limit or no limit at all cannot produce a share, so the reading appears in the
details as evidence with its own basis and no bar. `한도 0` means the limit is zero — never that
nothing was used. These rows carry no `usedPercent` at all, because a null there would be read as
a measured zero.

An account whose login needs renewing, or which is paused, keeps its last reading visible under
마지막으로 읽은 값, marked as not being current headroom. That reading is not promoted into the
account's own windows, so the badge still says 로그인 필요 and every existing client — the web
summary bars and the menu-bar app alike — goes on refusing to treat it as available quota. The
account also reports the direct-read status in a word rather than a code, and when the next
direct read is due. Refreshing the page does not bring that read forward: the browser only reads
the snapshot, and the provider schedule is the collector's.

Model prices are applied automatically using the existing provider/model reference table and matching local catalog fallback. There is no model-price tab, confirmation filter, price-management notification or manual approval step. Missing prices remain excluded rather than guessed. API-equivalent totals, quota sums and account projections continue normally. Source links remain under the collapsed calculation explanation. Backend price evidence, roster and gap records remain available through the compatible snapshot API and are not deleted.

Provider order is edited in the sidebar and saved to this browser. Sidebar, overview and all-account groups share that order. Unknown providers append in source order. At 760px and below the sidebar becomes an off-canvas drawer behind a top bar; the close button, the scrim and Escape close it, and the page behind it is `inert` so keyboard focus cannot reach it. Keyboard focus, selected period, search, ordering and open details survive refreshes. Search filters account rows; provider usage totals stay labeled as all-account totals.

The browser refreshes every 10 seconds while visible. A failed refresh retains the previous snapshot with a connection warning. Local expiry checks prevent offline snapshots from remaining current indefinitely. Usage totals and pace are anchored to the last successful log read; interrupted collection is not counted as idle time. `usageObservedAt`, `usageStale`, and per-provider `pace.observedAt` make that boundary explicit. Quota forecasts require the displayed percentage to match the last captured observation, and an observed 100% usage is exhausted even without a learned rate.

Design tokens and interaction rules: [DESIGN.md](DESIGN.md). Runtime dependencies and the `/api/v1/snapshot` version remain unchanged. The web service can be previewed without invoking the collector by importing `createApp` with a read-only snapshot callback; this isolates UI work from provider refreshes and persistent history writes.

Mac repair 0.1.1: the former fixed-parent render hid the initial 173-point popup size. The repair moves window sizing to an AppKit delegate and reserves a loading viewport. `QuotaPanelLayoutTests.swift` opens the actual NSPopover and tests delayed/long/short/reopen cases; it requires an unlocked Mac GUI session. `macos/build.sh` compiles and runs only `QuotaModelTests.swift`, so the layout harness must be compiled and run by hand. Remote locked-session failures are failures, not an interactive pass.

The summary alone has top-level period buttons. Provider and all-account screens always show all usage periods. Their collapsed provider estimates and account calculation details each have an independent `조회 기간` select (default7days), kept across refresh/search/navigation. Summary selection and sibling details remain unchanged; focus returns to the same local select after rendering.
