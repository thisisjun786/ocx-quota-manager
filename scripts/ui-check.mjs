// Dashboard smoke check: serves a deterministic snapshot to a local headless
// Chromium, drives the real UI, and asserts rendered output plus a clean console.
// Needs a Chromium binary, so it stays out of `npm test`. Run: npm run check:ui
import { buildFixture, FIXTURE_VARIANTS } from './ui-fixture.mjs';
import { openDashboard, SCREENS } from './ui-browser.mjs';
import { regressionFlow } from './ui-flow.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';


const failures = [];
const checks = [];
function expect(condition, description, detail) {
  checks.push(description);
  if (!condition) failures.push(detail === undefined ? description : description + ' — ' + JSON.stringify(detail));
}


// --- fixture contract: every variant must be a snapshot the server could produce ---
// A part cannot report a call, a token or a dollar its total does not hold, and every
// derived figure has to follow from the totals it claims to come from. Checking this
// here means a contradictory world fails the gate instead of quietly making an
// assertion pass for the wrong reason.
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
for (const name of FIXTURE_VARIANTS) {
  const world = buildFixture(name);
  const broken = [];
  const providerSubscriptions = world.providers.reduce((total, p) => total + p.analytics.subscriptionMonthlyUsd, 0);
  if (!near(world.analytics.subscriptionMonthlyUsd, providerSubscriptions)) {
    broken.push('top-level subscription ' + world.analytics.subscriptionMonthlyUsd + ' != providers ' + providerSubscriptions);
  }
  for (const p of world.providers) {
    const keys = Object.keys(p.analytics.periods);
    keys.forEach((key, index) => {
      const total = p.analytics.periods[key];
      const parts = p.accounts.map(a => a.analytics.periods[key]);
      const sum = pick => parts.reduce((s, part) => s + pick(part), 0);
      if (total.requests < sum(x => x.requests)) broken.push(p.id + '/' + key + ': accounts exceed the provider total');
      if (total.unknownPriceRequests < sum(x => x.unknownPriceRequests)) broken.push(p.id + '/' + key + ': unpriced calls exceed the provider total');
      if (total.requests === 0 && (total.tokens !== 0 || total.apiUsd !== null)) broken.push(p.id + '/' + key + ': no calls but tokens or an amount');
      if (total.cacheEstimatedRequests > total.requests) broken.push(p.id + '/' + key + ': more cache-estimated calls than calls');
      // The cache sidecar only attaches to a row whose price resolved, so an unpriced call
      // cannot also be cache-estimated.
      if (total.cacheEstimatedRequests > total.pricedRequests) broken.push(p.id + '/' + key + ': more cache-estimated calls than priced calls');
      if (total.unknownPriceTokens > total.tokens) broken.push(p.id + '/' + key + ': more excluded tokens than recorded tokens');
      if (total.unknownPriceRequests === 0 && total.unknownPriceTokens !== 0) broken.push(p.id + '/' + key + ': excluded tokens with no unpriced call');
      if (total.unknownPriceUnsizedRequests > total.unknownPriceRequests) broken.push(p.id + '/' + key + ': more calls without a token size than unpriced calls');
      if (total.pricedRequests + total.unknownPriceRequests > total.requests) broken.push(p.id + '/' + key + ': priced and unpriced exceed the calls');
      if (total.apiUsd === null && total.pricedRequests > 0) broken.push(p.id + '/' + key + ': priced calls with no amount');
      if (index > 0 && total.requests < p.analytics.periods[keys[index - 1]].requests) broken.push(p.id + '/' + key + ': a longer span holds fewer calls than a shorter one');
    });
    const week = p.analytics.periods.weekly, month = p.analytics.periods.monthly;
    // A seven-day consumption and the rate it was divided from are one measurement told two ways.
    // A variant that moves one without the other would let an assertion pass against a world the
    // server cannot produce. The rate may be withheld while the consumption is published, but not
    // the other way round, and neither exists without watched time.
    for (const a of p.accounts) for (const w of a.windows) {
      const wa = w.analytics, where = p.id + "/" + a.id + "/" + w.id;
      const has = value => typeof value === "number" && Number.isFinite(value);
      // legacy is the one world that predates these fields, and the screen has a branch for it.
      if (name !== "legacy" && typeof wa.providerWide !== "boolean") {
        broken.push(where + ": the window scope flag is missing");
      }
      // Every condition src/analytics.mjs returns on before the forecast runs. A fixture holding a
      // consumption through one of them is a world the server cannot produce, and an assertion
      // passing against it proves nothing.
      const earlyReturn = w.stale || !w.resetAt || !(Date.parse(w.resetAt) > Date.now()) ||
        ["reauth", "paused"].includes(a.status);
      if (has(wa.forecastDeltaPp) && earlyReturn) {
        broken.push(where + ": a consumption on a window the server returns before the forecast for");
      }
      // legacy predates the consumption field, so a rate standing alone is exactly what that
      // response looked like. Everywhere else a rate without it means one of the two was dropped.
      if (name !== "legacy" && has(wa.forecastRatePpHour) && !has(wa.forecastDeltaPp)) {
        broken.push(where + ": a burn rate with no consumption behind it");
      }
      if (has(wa.forecastDeltaPp) && !(wa.forecastObservedHours > 0)) {
        broken.push(where + ": a consumption with no watched time");
      }
      if (has(wa.forecastDeltaPp) && has(wa.forecastRatePpHour) &&
          !near(wa.forecastDeltaPp, wa.forecastRatePpHour * wa.forecastObservedHours)) {
        broken.push(where + ": the consumption does not follow from the rate and the watched hours");
      }
      if (has(wa.forecastDeltaPp) && wa.forecastSpanHours < wa.forecastObservedHours) {
        broken.push(where + ": more hours watched than the span they sit in");
      }
    }
    if (p.analytics.unattributed.requests > week.requests) broken.push(p.id + ': unattributed calls exceed the provider week');
    if (p.analytics.unpricedModels && month.unknownPriceRequests < p.analytics.unpricedModels.reduce((s, m) => s + m.requests, 0)) {
      broken.push(p.id + ': unpriced models exceed the unpriced calls');
    }
    if (week.apiUsd === null && p.analytics.pace.usdPerHour !== null) broken.push(p.id + ': a rate without a priced week');
    const rec = p.analytics.recommendation;
    if (month.apiUsd === null && rec.recommendedAccounts !== null) broken.push(p.id + ': an account need without a priced month');
    // Only an account that is reachable and whose weekly limit was actually converted
    // supplies capacity, which is what the demand is divided by.
    const usable = w => w && !w.stale && Number.isFinite(w.analytics.capacityApiUsd) && w.analytics.capacityApiUsd > 0;
    const configured = p.accounts.filter(a => !['reauth', 'paused', 'unavailable'].includes(a.status));
    const eligible = configured.filter(a => usable(a.windows.find(w => w.id === 'weekly' && (w.usageScope == null || w.usageScope === 'all'))));
    const noHistory = world.analytics.usageSince === null || world.analytics.usageSince === world.analytics.usageThrough;
    if (name === 'shortlog' && month.apiUsd !== null && eligible.length) {
      if (!near(rec.observedDays, 25 / 24) || !near(rec.recentObservedDays, 25 / 24) || rec.recommendedAccounts === null)
        broken.push(p.id + ': 25 observed hours must support a weekly recommendation');
    }
    if (name === 'unobserved' && rec.status !== 'collecting') broken.push(p.id + ': unobserved history must stay collecting');
    if (rec.status === 'provisional') {
      const capacity = eligible.reduce((s, a) => s + a.windows.find(w => w.id === 'weekly' && (w.usageScope == null || w.usageScope === 'all')).analytics.capacityApiUsd, 0) / eligible.length;
      // pricedBounds() counts only rows whose amount resolved, so the history is the
      // retained span for a provider that priced something and nothing otherwise.
      const start = Date.parse(world.analytics.usageSince ?? ''), end = Date.parse(world.analytics.usageThrough ?? '');
      const spanDays = Number.isFinite(start) && Number.isFinite(end) ? Math.min(30, Math.max(0, (end - start) / 86400000)) : 0;
      if (!near(rec.observedDays, Math.min(30, Math.max(spanDays, (month.observedCoverageHours ?? 0) / 24)))) broken.push(p.id + ': the observed days do not match the priced history');
      const baseline = month.apiUsd / rec.observedDays * 7;
      const recent = rec.recentObservedDays >= 1 && week.apiUsd !== null ? week.apiUsd / rec.recentObservedDays * 7 : null;
      const peakUsd = rec.fiveHourSampleAccounts > 0 ? month.apiUsd / 30 : null;
      const need = Math.max(baseline, recent ?? 0) / capacity;
      if (rec.currentAccounts !== configured.length) broken.push(p.id + ': the suggestion counts an account that cannot take work');
      if (rec.capacitySampleAccounts !== eligible.length) broken.push(p.id + ': the capacity sample does not match the eligible accounts');
      if (!near(rec.weeklyCapacityPerAccountUsd, capacity)) broken.push(p.id + ': the per-account capacity is not the measured mean');
      if (!near(rec.baselineWeeklyDemandApiUsd, baseline)) broken.push(p.id + ': the baseline demand does not follow from the month');
      if (recent !== null && !near(rec.recentWeeklyDemandApiUsd, recent)) broken.push(p.id + ': the recent demand does not follow from the week');
      if (!near(rec.weeklyDemandApiUsd, Math.max(baseline, recent ?? 0))) broken.push(p.id + ': the demand is not the larger of the two');
      if (!near(rec.recentObservedDays, Math.min(7, rec.observedDays))) broken.push(p.id + ': the rate and the suggestion read different priced histories');
      const expectedBasis = recent !== null && recent >= baseline ? 'recent-week' : 'monthly-baseline';
      if (rec.demandBasis !== expectedBasis) broken.push(p.id + ': the demand basis names the sample that did not win');
      if (rec.recommendedAccounts !== Math.max(1, Math.ceil(need / 0.8))) broken.push(p.id + ': the suggested account count does not follow from the weekly demand');
      if (rec.minimumAccounts !== Math.max(1, Math.ceil(need))) broken.push(p.id + ': the minimum does not follow from the weekly demand');
      if (rec.additionalAccounts !== Math.max(0, rec.recommendedAccounts - configured.length)) broken.push(p.id + ': the extra accounts do not follow from the suggestion');
      if (!near(rec.estimatedMonthlyUsd, rec.recommendedAccounts * 20)) broken.push(p.id + ': the budget does not follow from the suggestion');
      // A five-hour block cannot hold more than the month, nor less than an even share of it.
      if (peakUsd !== null && (peakUsd > month.apiUsd + 1e-9 || peakUsd < month.apiUsd / 144 - 1e-9)) {
        broken.push(p.id + ': the assumed five-hour peak is not a value the month could contain');
      }
      if (peakUsd !== null && rec.peakFiveHourAccounts !== Math.ceil(peakUsd / capacity)) broken.push(p.id + ': the peak account count does not follow from the peak');
    } else {
      // An unanswered suggestion still reports what it did work out. src/recommendation.mjs
      // settles the history and the demand before it ever looks for capacity, so a missing
      // weekly limit must not blank the days and the demand the function already had.
      const since = Date.parse(world.analytics.usageSince ?? ''), through = Date.parse(world.analytics.usageThrough ?? '');
      // pricedBounds() counts usd > 0, so a month that resolved to nothing is not a history.
      const pricedMonth = month.apiUsd > 0 && month.pricedRequests > 0;
      const pricedDays = pricedMonth && Number.isFinite(since) && Number.isFinite(through)
        ? Math.max(0, (through - since) / 86400000) : 0;
      const days = Math.min(30, Math.max(pricedDays, (month.observedCoverageHours ?? 0) / 24));
      if (rec.currentAccounts !== configured.length) broken.push(p.id + ': an unanswered suggestion still has to count the usable accounts');
      if (rec.capacitySampleAccounts !== 0) broken.push(p.id + ': an unanswered suggestion reports a capacity sample');
      if (rec.recommendedAccounts !== null) broken.push(p.id + ': an unanswered suggestion still names a count');
      if (!near(rec.observedDays, days)) broken.push(p.id + ': the observed days do not match the retained history');
      const demandKnown = days >= 1 && Number.isFinite(month.apiUsd);
      if (demandKnown) {
        const baseline = month.apiUsd / days * 7;
        const recent = rec.recentObservedDays >= 1 && week.apiUsd !== null ? week.apiUsd / rec.recentObservedDays * 7 : null;
        if (!near(rec.baselineWeeklyDemandApiUsd, baseline)) broken.push(p.id + ': an unanswered suggestion dropped the baseline it had worked out');
        if (!near(rec.weeklyDemandApiUsd, Math.max(baseline, recent ?? 0))) broken.push(p.id + ': an unanswered suggestion dropped the demand it had worked out');
        const expected = recent !== null && recent >= baseline ? 'recent-week' : 'monthly-baseline';
        if (rec.demandBasis !== expected) broken.push(p.id + ': an unanswered suggestion names the wrong demand basis');
      } else if (rec.weeklyDemandApiUsd !== null || rec.demandBasis !== null) {
        broken.push(p.id + ': a suggestion with no history or no amount still claims a demand');
      }
      if (eligible.length > 0 && demandKnown) {
        broken.push(p.id + ': the suggestion is unanswered although capacity, an amount and a history all exist');
      }
    }
    for (const a of p.accounts) {
      const m = a.analytics.periods.monthly;
      if (m.apiUsd === null && a.analytics.monthlyValueRatio !== null) broken.push(p.id + '/' + a.id + ': a ratio with no amount');
      if (m.apiUsd !== null && !near(a.analytics.monthlyValueRatio, m.apiUsd / a.analytics.subscription.monthlyUsd)) {
        broken.push(p.id + '/' + a.id + ': the ratio does not divide the month by the subscription');
      }
      if (m.apiUsd !== null && p.analytics.unattributed.requests > 0 && a.analytics.monthlyValueBasis !== 'partial') {
        broken.push(p.id + '/' + a.id + ': unattributed usage exists but the ratio calls itself complete');
      }
    }
    // The price-gap judgement has to be a world the server could publish too: the count is
    // the list length, the per-model periods are a breakdown of the aggregate beside them,
    // and no part of it carries an amount.
    const gaps = p.analytics.priceGaps;
    if (gaps.modelsNeedingPriceCheck !== gaps.models.length) broken.push(p.id + ': the gap count is not the gap list');
    for (const model of gaps.models) {
      if (!model.findings.length) broken.push(p.id + '/' + model.model + ': a flagged model with no reason');
      if (new Set(model.findings.map(f => f.reason)).size !== model.findings.length) {
        broken.push(p.id + '/' + model.model + ': the same reason twice');
      }
    }
    for (const [key] of Object.entries(gaps.periods ?? {})) {
      const summed = gaps.models.reduce((total, model) => total + (model.periods?.[key]?.requests ?? 0), 0);
      if (summed !== gaps.periods[key].requests) broken.push(p.id + '/' + key + ': the per-model periods do not add up to the aggregate');
      if (gaps.periods[key].requests > p.analytics.periods[key].requests) broken.push(p.id + '/' + key + ': the flagged calls exceed every call the provider made');
      for (const model of gaps.models) {
        const bucket = model.periods?.[key];
        if (!bucket) continue;
        if (bucket.unpricedRequests > bucket.requests) broken.push(p.id + '/' + model.model + '/' + key + ': more unpriced calls than calls');
        // A period is a subset of what the model retained, so it can never hold more.
        if (bucket.requests > model.requests) broken.push(p.id + '/' + model.model + '/' + key + ': a period holds more calls than the model retained');
        if (bucket.unpricedRequests > model.unpricedRequests) broken.push(p.id + '/' + model.model + '/' + key + ': a period holds more unpriced calls than the model retained');
        if (Object.keys(bucket).some(field => /usd/i.test(field))) broken.push(p.id + '/' + model.model + '/' + key + ': an amount on a missing price');
      }
    }
  }
  expect(broken.length === 0, 'the ' + name + ' fixture is a snapshot the server could produce', broken);
}

const snapshot = buildFixture();
// --- excluded-scope wording: the two cases no fixture world can reach on its own ---
// The integer formatter rounds a fraction of a token down to 0, and a world where every
// unpriced call has a zero token record has no tokens to report. Neither may be written
// as the measured zero it is not.
const { excludedNote } = await import('../public/quota.js');
const roundedDown = excludedNote({ unknownPriceRequests: 1, unknownPriceTokens: 0.1, unknownPriceUnsizedRequests: 0 });
expect(roundedDown === '단가 미확인 1회 · 기록된 < 1 토큰이 합계에서 빠짐',
  'a fraction of a token is not rounded into a zero-token exclusion', roundedDown);
const nothingSized = excludedNote({ unknownPriceRequests: 2, unknownPriceTokens: 0, unknownPriceUnsizedRequests: 2 });
expect(nothingSized === '단가 미확인 2회 · 2회는 토큰 기록이 0이라 이 값에 들어가지 않음',
  'unpriced calls with nothing recorded say so instead of reporting a zero total', nothingSized);
// A unit price has the same three cases and the fixture cannot hold the third: a rate below
// six decimal places is not the confirmed free rate that $0.00 means.
const { unitPrice } = await import('../public/format.js');
const priceCases = [null, undefined, NaN, 0, 0.0000001, 0.014].map(value => unitPrice(value));
expect(JSON.stringify(priceCases) === JSON.stringify(['미확인', '미확인', '미확인', '$0.00',
  '< $0.000001', '$0.014']),
  'an unknown rate, a confirmed free rate and a rate too small to print are three different things',
  priceCases);

// The session, the page helpers and the console collector live in ./ui-browser.mjs so that
// npm run check:ui and npm run check:ui:flow drive the same browser the same way.

// --- JUN-124 pure cases: boundaries no fixture world can hold at once ---
const { quotaFigure } = await import('../public/format.js');
// Each of these is a different fact and must not collapse into another. Read as pairs:
// value, then what a reader is entitled to conclude from the text.
const figureCases = [28, 28.5, 12.345, 0, -0, 0.004, -0.004, 0.01, 99.999, 100, 100.001, 137.5, null, NaN]
  .map(value => quotaFigure(value));
expect(JSON.stringify(figureCases) === JSON.stringify(['28', '28.5', '12.35', '0', '0', '<0.01',
  '>-0.01', '0.01', '<100', '100', '>100', '137.5', '미확인', '미확인']),
  'a whole number, a tiny positive, a signed tiny, an exhausted limit and an overage are six different readings',
  figureCases);
const { directStatusNote, directStatusIsWarning, instantNote } = await import('../public/quota.js');
// Every status merge() can produce, plus the transport failures, plus one nobody ships.
const statuses = ['ok', 'partial', 'unknown', 'observation_unavailable', 'credential_expired',
  'credential_missing', 'unauthorized', 'access_denied', 'rate_limited', 'server_error',
  'unexpected_status', 'invalid_json', 'oversized', 'timeout', 'network', 'redirect',
  'credential_echoed', 'endpoint_not_allowed', 'base_url_mismatch', 'a_status_from_the_future'];
const unworded = statuses.filter(status => !directStatusNote(status));
expect(unworded.length === 0, 'every direct-read status the code can produce has a word', unworded);
expect(directStatusNote('ok') === '조회 정상' && directStatusIsWarning('ok') === false
  && directStatusIsWarning('rate_limited') === true,
  'a healthy direct read is stated as healthy rather than shown as a warning',
  [directStatusNote('ok'), directStatusIsWarning('ok')]);
// A credential that never left and one that left and was refused are not the same sentence.
expect(directStatusNote('base_url_mismatch') === '대상 확인 실패로 미전송'
  && directStatusNote('redirect') === '응답 거부',
  'a refusal before the request is worded differently from a refusal after it',
  [directStatusNote('base_url_mismatch'), directStatusNote('redirect')]);
// A contract null and an unreadable value are different, and neither may throw.
const instants = [null, undefined, 'not-a-date', '2026-09-17T00:00:00.000Z']
  .map(value => instantNote(value, () => 'formatted'));
expect(JSON.stringify(instants) === JSON.stringify(['미제공', '미제공', '확인 불가', 'formatted']),
  'an absent instant, an unreadable one and a real one are three different answers', instants);


const page = await openDashboard({ snapshot, fail: message => failures.push(message) });
const { call, evaluate, settle, text, countOf, clickText, problems } = page;

try {
  const ready = await settle('document.querySelectorAll(".summary-provider").length || 0');
  expect(ready === snapshot.providers.length, 'overview lists every provider', { rendered: ready, expected: snapshot.providers.length });
  expect((await text('#title')) === '요약', 'title starts on the summary view', await text('#title'));
  expect((await countOf('.quota-bar')) > 0, 'quota bars render');
  expect((await countOf('.quota-bar.low')) > 0, 'a low remaining quota is marked');
  expect((await countOf('.track[role=progressbar]')) > 0, 'quota tracks expose progressbar semantics');
  expect(/일부 프로바이더/.test((await text('#notice')) ?? ''), 'server warnings reach the notice bar', await text('#notice'));
  expect(/수집$/.test(((await text('#updated')) ?? '').trim()), 'collection time is shown', await text('#updated'));
  expect(/\$/.test((await text('.summary-usage')) ?? ''), 'summary shows an API-equivalent amount', await text('.summary-usage'));
  // JUN-225: 같은 칸에서 금액과 최근 7일 쿼타 소모를 함께 읽는다.
  const quotaCells = await evaluate('(() => [...document.querySelectorAll(".summary-provider")].map(row => ({' +
    ' name: row.querySelector(".provider-link")?.textContent ?? null,' +
    ' order: [...row.querySelectorAll(".summary-usage .metric")].map(el => el.classList.contains("quota-used")),' +
    ' state: row.querySelector(".metric.quota-used")?.dataset.quotaUsage ?? null,' +
    ' window: row.querySelector(".metric.quota-used")?.dataset.quotaWindow ?? null,' +
    ' label: row.querySelector(".metric.quota-used > span")?.textContent ?? null,' +
    ' value: row.querySelector(".metric.quota-used > strong")?.textContent ?? null,' +
    ' note: row.querySelector(".metric.quota-used > small")?.textContent ?? null,' +
    ' title: row.querySelector(".metric.quota-used")?.title ?? null,' +
    ' bars: [...row.querySelectorAll(".quota-caption strong")].map(el => el.textContent) }))) ()');
  expect(quotaCells.length === snapshot.providers.length && quotaCells.every(q => q.order[0] === false && q.order[1] === true),
    'the API amount stays the first metric and the quota figure follows it', quotaCells.map(q => q.order));
  expect(quotaCells.every(q => q.label === '최근 7일 쿼타 소모 합계'),
    'every summary row names the period its quota figure covers', quotaCells.map(q => q.label));
  const quotaBy = Object.fromEntries(quotaCells.map(q => [q.name, q]));
  expect(quotaBy['Anthropic']?.window === 'weekly' && quotaBy['Anthropic']?.state === 'measured' &&
    quotaBy['Anthropic']?.value === '≈ 42%p',
    'a fully watched week reports through the provider-wide weekly limit, not the five-hour one', quotaBy['Anthropic']);
  expect(quotaBy['Anthropic']?.bars.includes('12% 남음') && quotaBy['Anthropic']?.value === '≈ 42%p',
    'the seven-day consumption is reported apart from the limit remaining right now', quotaBy['Anthropic']);
  expect(quotaBy['Cursor']?.window === 'monthly' && /월간/.test(quotaBy['Cursor']?.title ?? ''),
    'a provider with no weekly limit falls back to the monthly one and names it', quotaBy['Cursor']);
  expect(quotaBy['OpenAI']?.state === 'partial' && /1\/3계정/.test(quotaBy['OpenAI']?.title ?? ''),
    'accounts with no usable reading are left out of the average rather than counted as zero', quotaBy['OpenAI']);
  expect(quotaBy['Ollama Cloud']?.state === 'unobserved' && quotaBy['Ollama Cloud']?.value === '미관측' &&
    /사용량이 0이라는 뜻이 아닙니다/.test(quotaBy['Ollama Cloud']?.title ?? ''),
    'an unwatched limit says so instead of reporting a zero', quotaBy['Ollama Cloud']);
  expect(quotaCells.every(q => q.state === 'unobserved' || q.state === 'unsupported' || /^≈ /.test(q.value ?? '')),
    'every published figure is marked as an estimate', quotaCells.map(q => q.value));
  expect(quotaCells.every(q => q.note === null),
    'summary quota cells omit account and coverage metadata from visible text', quotaCells.map(q => q.note));
  expect(/필요 계정/.test((await text('.recommend')) ?? ''), 'recommendation reaches the summary row');
  expect((await countOf('#provider-order-list .order-row')) === snapshot.providers.length, 'order editor lists providers');

  await clickText('#period-picker button', '30일');
  const columns = await settle('document.querySelector(".summary-columns")?.textContent');
  expect(/최근 30일/.test(columns ?? ''), 'period picker switches the summary column', columns);

  await clickText('#providers button', 'OpenAI');
  const accounts = await settle('document.querySelectorAll(".account").length || 0');
  expect(accounts === 3, 'provider view renders every account', accounts);
  expect((await text('#title')) === 'OpenAI', 'title follows the selected provider', await text('#title'));
  expect(/로그인 필요/.test((await evaluate('document.querySelector(".accounts").textContent')) ?? ''), 'a reauth account is flagged');
  const delayNotes = await countOf('.refresh-note');
  expect(delayNotes === 1, 'a delayed lookup is flagged once, and not on the reauth account that already explains itself', delayNotes);
  expect((await countOf('.window')) > 0, 'quota windows render inside the account card');

  await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
  expect((await countOf('.spark-svg path')) > 0, 'history sparklines draw');
  expect(/API 환산액/.test((await evaluate('document.querySelector(".account-details").textContent')) ?? ''), 'account details show usage totals');

  await evaluate('document.getElementById("search").value = "계정 2"; document.getElementById("search").dispatchEvent(new Event("input"))');
  const filtered = await settle('document.querySelectorAll(".account").length || 0');
  expect(filtered === 1, 'search narrows the account list', filtered);
  await evaluate('document.getElementById("search").value = ""; document.getElementById("search").dispatchEvent(new Event("input"))');

  await clickText('#providers button', 'Anthropic');
  const conservative = await settle('document.querySelector(".provider-group")?.textContent');
  expect(/보수 추정/.test(conservative ?? ''), 'a conservatively estimated quota value is badged');
  await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
  const detail = await evaluate('document.querySelector(".account-details").textContent');
  expect(/환산 못한 쿼타 변화 24%p 포함/.test(detail ?? ''), 'unpriced quota movement is disclosed with its size', detail?.slice(0, 200));
  await evaluate('document.querySelectorAll("details.provider-details").forEach(el => el.open = true)');
  const cohort = await evaluate('document.querySelector(".provider-details")?.textContent');
  expect(/개는 보수 추정/.test(cohort ?? ''), 'a provider average says how much of its cohort is conservatively estimated', cohort?.slice(0, 200));

  await clickText('#providers button', 'Ollama Cloud');
  const ollama = await settle('document.querySelector(".provider-group")?.textContent');
  expect(/연결 비활성/.test(ollama ?? ''), 'a disabled provider is labelled');
  expect(/1%p 순증가당/.test(ollama ?? ''), 'ollama per-model calibration renders');

  await clickText('#providers button', 'Cursor');
  const cursor = await settle('document.querySelector(".provider-analytics")?.textContent');
  expect(/캐시 62% 가정/.test(cursor ?? ''), 'cursor cache assumption is disclosed', cursor?.slice(0, 200));
  expect(/미환산/.test(cursor ?? ''), 'unpriced models are disclosed');

  await clickText('#providers button', '요약');
  expect(await settle('document.querySelectorAll(".summary-provider").length || 0'), 'returns to the summary view');

  const accessibility = await evaluate('[...document.querySelectorAll("button")].filter(b => !b.textContent.trim() && !b.getAttribute("aria-label")).length');
  expect(accessibility === 0, 'every button has an accessible name', accessibility);

  // --- app shell: desktop chrome, mobile drawer, breakpoint focus, state across re-render ---
  const pressTab = async (shift = false) => {
    const key = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers: shift ? 8 : 0 };
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  };
  const focusId = () => evaluate('document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : null');
  const escapee = () => evaluate('(() => { const el = document.activeElement;' +
    ' if (!el || el === document.body || el === document.documentElement) return null;' +
    ' return document.getElementById("sidebar").contains(el) ? null : (el.id || el.className || el.tagName); })()');
  const openDrawer = async () => {
    await evaluate('document.getElementById("menu-toggle").click()');
    return settle('document.getElementById("sidebar").classList.contains("open")');
  };

  expect(await evaluate('getComputedStyle(document.getElementById("mobile-topbar")).display === "none"'),
    'desktop hides the mobile top bar');

  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  expect(await settle('getComputedStyle(document.getElementById("menu-toggle")).display !== "none"'),
    'mobile shows the menu toggle');
  expect(await settle('document.getElementById("sidebar").getBoundingClientRect().right <= 0'),
    'the closed drawer settles off-canvas');

  const topbarPadding = await evaluate('parseFloat(getComputedStyle(document.getElementById("mobile-topbar")).paddingTop)');
  const topbarBottom = await evaluate('parseFloat(getComputedStyle(document.getElementById("mobile-topbar")).paddingBottom)');
  const sidebarPadding = await evaluate('parseFloat(getComputedStyle(document.getElementById("sidebar")).paddingTop)');
  await call('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47 } });
  expect(await settle('parseFloat(getComputedStyle(document.getElementById("mobile-topbar")).paddingTop) >= ' + (topbarPadding + 47)),
    'the mobile top bar adds the emulated top safe-area inset');
  expect(await evaluate('parseFloat(getComputedStyle(document.getElementById("mobile-topbar")).paddingBottom)') === topbarBottom,
    'the top safe-area inset does not add blank space below the mobile top bar');
  expect(await settle('parseFloat(getComputedStyle(document.getElementById("sidebar")).paddingTop) >= ' + (sidebarPadding + 47)),
    'the mobile drawer adds the emulated top safe-area inset');
  expect(await evaluate('document.getElementById("menu-toggle").getBoundingClientRect().top >= 47'),
    'the menu toggle stays below the emulated top cutout');
  expect(await openDrawer(), 'the drawer opens');
  expect(await evaluate('document.getElementById("drawer-close").getBoundingClientRect().top >= 47'),
    'the drawer close button stays below the emulated top cutout');
  await call('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0 } });
  await call('Emulation.setDeviceMetricsOverride', { width: 734, height: 390, deviceScaleFactor: 1, mobile: true });
  await call('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 47, right: 47 } });
  expect(await evaluate('document.getElementById("menu-toggle").getBoundingClientRect().left >= 47'),
    'the landscape menu toggle stays outside the left cutout');
  expect(await evaluate('parseFloat(getComputedStyle(document.getElementById("mobile-topbar")).paddingRight) >= 47'),
    'the landscape top bar reserves the right safe area');
  expect(await settle('document.getElementById("sidebar").getBoundingClientRect().left === 0'),
    'the landscape drawer finishes opening before its safe-area position is checked');
  expect(await evaluate('document.querySelector("#sidebar .brand").getBoundingClientRect().left >= 47'),
    'the landscape drawer content stays outside the left cutout');
  await call('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0 } });
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  expect(await evaluate('document.getElementById("menu-toggle").getAttribute("aria-expanded") === "true"'),
    'the toggle reports its expanded state');
  expect(await evaluate('document.getElementById("sidebar").getAttribute("aria-modal") === "true"'),
    'the open drawer carries a literal aria-modal=true');
  expect(await evaluate('document.activeElement.id === "drawer-close"'),
    'opening the drawer focuses a visible control');
  expect(await evaluate('["main","mobile-topbar"].every(id => document.getElementById(id).hasAttribute("inert"))' +
    ' && document.querySelector(".skip").hasAttribute("inert")'),
    'the page, the top bar and the skip link are inert while the drawer is open');

  expect(await evaluate('(() => {' +
    ' const sel = \'a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex="-1"])\';' +
    ' const drawer = document.getElementById("sidebar");' +
    ' return [...document.querySelectorAll(sel)].filter(el => !el.closest("[inert]") && el.getClientRects().length > 0)' +
    '   .every(el => drawer.contains(el)); })()'),
    'every reachable control is inside the open drawer');

  const beforeTab = await focusId();
  await pressTab();
  expect(beforeTab !== (await focusId()), 'Tab actually moves focus, so the traversal checks are not vacuous', beforeTab);
  let escaped = await escapee();
  for (let i = 0; i < 11 && !escaped; i++) { await pressTab(); escaped = await escapee(); }
  expect(escaped === null, 'Tab never reaches a control behind the drawer', escaped);
  for (let i = 0; i < 8 && !escaped; i++) { await pressTab(true); escaped = await escapee(); }
  expect(escaped === null, 'Shift+Tab never reaches a control behind the drawer', escaped);

  await evaluate('document.querySelector("#providers .nav-item.active").dataset.qmMark = "drawer";' +
    ' document.getElementById("drawer-close").focus(); window.dispatchEvent(new Event("online")); true');
  expect(await settle('!document.querySelector("#providers .nav-item.active").dataset.qmMark && !document.getElementById("refresh").disabled'),
    'a refresh completes while the drawer is open');
  expect(await evaluate('document.getElementById("sidebar").classList.contains("open") && document.getElementById("main").inert'),
    'the open drawer and background isolation survive refresh');
  expect(await evaluate('document.activeElement.id === "drawer-close"'),
    'drawer keyboard focus survives refresh');

  await evaluate('document.getElementById("sidebar").style.setProperty("--motion-normal", "5s"); document.getElementById("drawer-close").click()');
  expect(await settle('!document.getElementById("sidebar").classList.contains("open")'), 'the close button closes the drawer');
  expect(await evaluate('document.activeElement.id === "menu-toggle"'), 'closing returns focus to the toggle');
  expect(await evaluate('getComputedStyle(document.getElementById("sidebar")).visibility === "visible"'),
    'the close animation is still visible during the immediate Tab check');
  await pressTab();
  expect(await evaluate('!document.getElementById("sidebar").contains(document.activeElement)'),
    'Tab cannot re-enter a drawer while its close animation is running');
  await evaluate('document.getElementById("sidebar").style.removeProperty("--motion-normal"); document.getElementById("menu-toggle").focus()');

  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1800, deviceScaleFactor: 1, mobile: false });
  expect(await settle('document.activeElement.matches("#providers .nav-item.active")'),
    'widening with a closed drawer moves focus from the hidden menu toggle to desktop navigation');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // JUN-225: 좁은 화면에서도 금액과 쿼타 수치가 둘 다 잘리지 않고 서로 겹치지 않아야 한다.
  await clickText('#providers button', '요약');
  await settle('document.querySelectorAll(".summary-provider").length || 0');
  for (const width of [320, 390, 540]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    const pair = await evaluate('(() => { const fits = el => { if (!el) return false;' +
      ' const box = el.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(el);' +
      ' const rects = [...range.getClientRects()];' +
      ' return box.width > 0 && box.height > 0 && box.right <= innerWidth + 1 && box.left >= -1 &&' +
      '   el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1 &&' +
      '   rects.length > 0 && rects.every(r => r.right <= innerWidth + 1 &&' +
      '     r.top >= box.top - 1 && r.bottom <= box.bottom + 1); };' +
      ' return [...document.querySelectorAll(".summary-provider")].map(row => {' +
      '   const amount = row.querySelector(".summary-usage .metric:not(.quota-used) > strong");' +
      '   const quota = row.querySelector(".summary-usage .metric.quota-used > strong");' +
      '   const cell = row.querySelector(".summary-usage .metric.quota-used");' +
      '   const overlap = amount && quota ? amount.getBoundingClientRect().bottom > quota.getBoundingClientRect().top + 1 : true;' +
      '   return { amount: amount?.textContent ?? null, quota: quota?.textContent ?? null,' +
      '     readable: fits(amount) && fits(quota) && fits(cell?.querySelector("span")) &&' +
      '       (!cell?.querySelector("small") || fits(cell.querySelector("small"))), overlap }; }); })()');
    expect(pair.length > 0 && pair.every(row => row.amount && row.quota && row.readable && !row.overlap),
      'the amount and the seven-day quota figure are both whole and separate at ' + width + 'px', pair);
    expect(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'),
      'no horizontal page overflow on the summary at ' + width + 'px');
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  await openDrawer();
  await evaluate('document.getElementById("drawer-scrim").click()');
  expect(await settle('!document.getElementById("sidebar").classList.contains("open")'), 'the scrim closes the drawer');

  await openDrawer();
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape"}))');
  expect(await settle('!document.getElementById("sidebar").classList.contains("open")'), 'Escape closes the drawer');
  expect(await evaluate('!document.getElementById("main").hasAttribute("inert")'), 'closing the drawer releases the page');

  await evaluate('document.querySelector(".skip").focus()');
  expect(await evaluate('(() => { const link = document.querySelector(".skip"); const r = link.getBoundingClientRect();' +
    ' if (r.top < 0) return false; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);' +
    ' return !!hit && link.contains(hit); })()'),
    'the focused skip link is not covered by the mobile top bar');
  await evaluate('window.scrollTo(0, document.documentElement.scrollHeight); document.querySelector(".skip").click()');
  expect(await evaluate('location.hash === "#main"'), 'the skip link activates its real main target');
  expect(await settle('document.getElementById("main").getBoundingClientRect().top >= document.getElementById("mobile-topbar").getBoundingClientRect().bottom - 1'),
    'the skip target stays below the sticky mobile top bar');
  expect(await evaluate('document.getElementById("title").getBoundingClientRect().top >= document.getElementById("mobile-topbar").getBoundingClientRect().bottom - 1'),
    'the page title remains visible after using the skip link');
  await evaluate('history.replaceState(null, "", location.pathname)');


  await openDrawer();
  await clickText('#providers button', 'OpenAI');
  expect(await settle('document.activeElement.id === "title"'), 'a mobile selection moves focus to the page title');
  expect(await evaluate('!document.getElementById("sidebar").classList.contains("open")'), 'a mobile selection closes the drawer');

  await clickText('#providers button', '요약');
  await settle('document.querySelectorAll(".summary-provider").length || 0');
  await evaluate('document.querySelector(".provider-link").click()');
  expect(await settle('document.activeElement.id === "title"'),
    'a closed-drawer provider link still lands focus on the page title');
  expect(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'),
    'no horizontal page overflow at 390px');

  // Real usage can exceed four figures; a fitting page must not split a currency amount.
  const originalAmounts = await evaluate('[...document.querySelectorAll(".provider-analytics > .usage-totals .metric > strong")].map(el => el.textContent)');
  // README §Usage periods: five trailing spans. 화면 상수가 아니라 계약 상수로 고정한다.
  expect(originalAmounts.length === 5, 'the amount boundary probe has all five provider periods');
  for (const width of [320, 390, 540]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('[...document.querySelectorAll(".provider-analytics > .usage-totals .metric > strong")].forEach(el => { el.textContent = "$12,345.67"; })');
    const amounts = await evaluate('(() => {' +
      ' return [...document.querySelectorAll(".provider-analytics > .usage-totals .metric > strong")].map(el => {' +
      ' const range = document.createRange(); range.selectNodeContents(el); const rects = [...range.getClientRects()];' +
      ' const box = el.getBoundingClientRect(); return { lines: rects.length, contained: rects.every(r => r.left >= box.left - 1 && r.right <= box.right + 1 && r.right <= innerWidth) }; }); })()');
    expect(amounts.length === 5 && amounts.every(a => a.lines === 1 && a.contained),
      'large provider amounts remain whole and contained at ' + width + 'px', amounts);
  }
  await evaluate('[...document.querySelectorAll(".provider-analytics > .usage-totals .metric > strong")].forEach((el, i) => { el.textContent = ' + JSON.stringify(originalAmounts) + '[i]; })');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  await openDrawer();
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1800, deviceScaleFactor: 1, mobile: false });
  expect(await settle('document.activeElement.classList.contains("nav-item")'),
    'widening past the breakpoint moves focus out of the now-hidden drawer control');
  expect(await evaluate('!document.getElementById("sidebar").classList.contains("open")'),
    'widening past the breakpoint clears the drawer state');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  expect(await settle('document.activeElement.id === "menu-toggle"'),
    'narrowing past the breakpoint moves focus off a now-hidden drawer button');
  await call('Emulation.clearDeviceMetricsOverride');

  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate('document.querySelector("#providers .nav-item.active").focus()');
  expect(await evaluate('document.activeElement.matches("#providers .nav-item.active")'),
    'desktop navigation has focus before the reduced-motion resize');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  expect(await settle('document.activeElement.id === "menu-toggle"'),
    'narrowing with reduced motion moves focus before the sidebar becomes hidden');
  await call('Emulation.clearDeviceMetricsOverride');
  expect(await settle('document.activeElement.matches("#providers .nav-item.active")'),
    'widening with reduced motion restores desktop navigation focus');
  await call('Emulation.setEmulatedMedia', { features: [] });

  // The 10-second timer takes the same render path, so drive it through the refresh button
  // and wait for the navigation node to actually be replaced before asserting anything.
  await clickText('#providers button', 'OpenAI');
  await settle('document.querySelectorAll(".account").length || 0');
  await evaluate('document.getElementById("search").value = "계정"; document.getElementById("search").dispatchEvent(new Event("input"))');
  await evaluate('document.querySelector("details.account-details").open = true');
  await evaluate('const b = document.querySelector("#providers .nav-item.active"); b.dataset.qmMark = "1"; b.focus(); true');
  await evaluate('document.getElementById("refresh").click()');
  expect(await settle('(() => { const b = document.querySelector("#providers .nav-item.active");' +
    ' return b && !b.dataset.qmMark && !document.getElementById("refresh").disabled ? true : null; })()'),
    'the refresh replaced the navigation before the preservation checks ran');
  expect(await evaluate('document.activeElement.dataset.provider === "openai"'),
    'keyboard focus survives the re-render', await focusId());
  expect(await evaluate('document.querySelector("#providers .nav-item.active").getAttribute("aria-current") === "page"'),
    'the selected destination keeps aria-current across the re-render');
  expect(await evaluate('document.getElementById("search").value === "계정"'), 'the search text survives the re-render');
  expect(await evaluate('!!document.querySelector("details.account-details[open]")'), 'an open disclosure survives the re-render');

  await evaluate('document.getElementById("search").value = ""; document.getElementById("search").dispatchEvent(new Event("input"))');
  await clickText('#providers button', '요약');
  await settle('document.querySelectorAll(".summary-provider").length || 0');


  // --- row hierarchy: one vocabulary across summary rows and account windows ---
  expect(/% 남음/.test((await text('.summary-provider .quota-caption')) ?? ''),
    'summary bars name the remaining share the way account windows do', await text('.summary-provider .quota-caption'));
  const missing = await countOf('.quota-bar.stale .quota-note');
  expect(missing > 0, 'a summary window with no eligible measurement says so in the row', missing);

  await clickText('#providers button', 'OpenAI');
  const named = await settle('document.querySelectorAll(".account-name").length || 0');
  expect(named === 3, 'the provider screen renders every account name', named);

  const badged = await evaluate('[...document.querySelectorAll(".window.stale")]' +
    '.map(w => { const b = w.querySelector(".window-title .badge"); return b ? b.textContent : null; })');
  expect(Array.isArray(badged) && badged.filter(Boolean).length === 1,
    'only a window-specific reason is badged; account-wide status stays in the heading', badged);
  expect(Array.isArray(badged) && badged.includes('리셋 후 갱신 대기'),
    'an elapsed reset on an otherwise healthy account is badged, not just dimmed', badged);
  const expiredMeta = await evaluate('(() => {' +
    ' const w = [...document.querySelectorAll(".window")].find(el => el.querySelector(".window-title .badge")?.textContent === "리셋 후 갱신 대기");' +
    ' return w?.querySelector(".window-meta").textContent; })()');
  expect(typeof expiredMeta === 'string' && !/대기/.test(expiredMeta) && /\d/.test(expiredMeta),
    'an expired reset keeps its timestamp in metadata without repeating the waiting badge', expiredMeta);
  const reauthWindow = await evaluate('(() => {' +
    ' const acc = [...document.querySelectorAll(".account")].find(a => a.textContent.includes("로그인 필요"));' +
    ' if (!acc) return null; const w = acc.querySelector(".window");' +
    ' return { badge: !!w.querySelector(".window-title .badge"), meta: w.querySelector(".window-meta").textContent }; })()');
  expect(reauthWindow && !reauthWindow.badge && /로그인/.test(reauthWindow.meta),
    'an account-wide status is stated once per window, not badged a second time', reauthWindow);

  const longName = await evaluate('(() => {' +
    ' const el = [...document.querySelectorAll(".account-name")].find(n => n.title.startsWith("장기 보관용"));' +
    ' return el ? { clipped: el.scrollWidth > el.clientWidth + 1, title: el.title, shown: el.textContent } : null; })()');
  expect(longName && longName.clipped, 'a long account name is clipped instead of pushing the row apart', longName);
  expect(longName && longName.title === longName.shown, 'the clipped name keeps its full value in its title', longName);

  const multiWindowAccount = snapshot.providers.find(p => p.id === 'anthropic').accounts[0];
  const previousObservation = multiWindowAccount.updatedAt;
  multiWindowAccount.updatedAt = new Date(Date.now() - 16 * 60000).toISOString();
  await clickText('#providers button', 'Anthropic');
  await evaluate('document.querySelector(".account").dataset.qmMark = "stale-age"; document.getElementById("refresh").click()');
  expect(await settle('!document.querySelector(".account").dataset.qmMark && !document.getElementById("refresh").disabled'),
    'the stale multi-window account has completed a refresh');
  expect((await countOf('.window.stale')) === 3 && (await countOf('.window-title .badge')) === 0,
    'an account-wide observation expiry does not produce repeated window warning badges');
  expect(/15분 이상 갱신 없음/.test((await text('.window-meta')) ?? ''),
    'the stale account still explains why its measurements are unavailable');
  multiWindowAccount.updatedAt = previousObservation;
  await evaluate('document.querySelector(".account").dataset.qmMark = "restoring"; document.getElementById("refresh").click()');
  expect(await settle('!document.querySelector(".account").dataset.qmMark && !document.getElementById("refresh").disabled'),
    'the restored observation has completed a refresh');

  await clickText('#providers button', '요약');
  await settle('document.querySelectorAll(".summary-provider").length || 0');

  const fills = await evaluate('(() => { const ok = document.querySelector(".quota-bar:not(.low) .fill"); const low = document.querySelector(".quota-bar.low .fill");' +
    ' return ok && low ? [getComputedStyle(ok).backgroundColor, getComputedStyle(low).backgroundColor] : null; })()');
  expect(Array.isArray(fills) && fills[0] !== fills[1], 'healthy and low quota fills use different semantic colours', fills);

  const lightBg = await evaluate('getComputedStyle(document.documentElement).backgroundColor');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const darkBg = await settle('(() => { const c = getComputedStyle(document.documentElement).backgroundColor;' +
    ' return c === ' + JSON.stringify(lightBg) + ' ? null : c; })()');
  expect(darkBg !== null, 'light-dark() resolves a separate dark surface', { light: lightBg, dark: darkBg });
  const darkText = await evaluate('getComputedStyle(document.documentElement).color');
  expect(darkText !== darkBg, 'dark text stays distinct from the dark surface', { darkText, darkBg });

  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  expect(await settle('getComputedStyle(document.getElementById("refresh")).transitionDuration === "0s"'),
    'reduced motion removes control transitions');
  await call('Emulation.setEmulatedMedia', { features: [] });


  // --- JUN-42: five usage periods wired to the summary, the provider and the account ---
  // Amounts come from the fixture contract (one price per recorded call), never from
  // reading the screen back. Provider and account amounts differ on purpose so a check
  // can tell which one a panel actually read.
  const PERIOD_PILLS = [
    // Provider totals are the composed sum of three listed accounts, the unattributed
    // part and one unlisted account; the account column is a1 alone.
    // Account calls come from the fixture request vector; tokens are 2250 / 625 / 1000 per
    // call, so every period has its own arithmetic rather than one shared number.
    { short: '1시간', label: '최근 1시간', key: 'oneHour', provider: '$2.00', account: '$0.50',
      calls: 1, tokens: ['2,250', '625', '1,000'] },
    { short: '5시간', label: '최근 5시간', key: 'fiveHour', provider: '$8.00', account: '$2.00',
      calls: 4, tokens: ['9,000', '2,500', '4,000'] },
    { short: '24시간', label: '최근 24시간', key: 'twentyFourHour', provider: '$24.00', account: '$6.00',
      calls: 12, tokens: ['27,000', '7,500', '12,000'] },
    { short: '7일', label: '최근 7일', key: 'weekly', provider: '$80.00', account: '$20.00',
      calls: 40, tokens: ['90,000', '25,000', '40,000'] },
    { short: '30일', label: '최근 30일', key: 'monthly', provider: '$320.00', account: '$80.00',
      calls: 160, tokens: ['360,000', '100,000', '160,000'] },
  ];
  const selectPeriod = async short => {
    if (await evaluate('!document.getElementById("period-picker").hidden')) {
      await clickText('#period-picker button', short);
      return settle('document.querySelector(\'#period-picker button[aria-pressed="true"]\')?.dataset.period ?? null');
    }
    const key = PERIOD_PILLS.find(p => p.short === short).key;
    await evaluate(`(() => {
      const keys = [...document.querySelectorAll('.detail-period select')].map(s => s.dataset.focus);
      for (const focus of keys) {
        const select = [...document.querySelectorAll('.detail-period select')].find(s => s.dataset.focus === focus);
        select.closest('details').open = true;
        select.value = ${JSON.stringify(key)}; select.dispatchEvent(new Event('change'));
      }
    })()`);
    return evaluate('document.querySelector(".account-details .detail-period select")?.value');
  };
  const seenMetric = period => '(() => { const el = document.querySelector(\'.usage-totals .metric[data-period="' +
    period + '"]\'); if (!el) return null; const small = el.querySelector("small");' +
    ' return { record: el.dataset.record || "", observation: el.dataset.observation || "",' +
    ' state: el.dataset.periodState || "", amount: el.querySelector("strong").textContent,' +
    ' note: small ? small.textContent : "" }; })()';
  const settleMetric = (period, predicate) => settle('(() => { const seen = ' + seenMetric(period) +
    '; return seen && (' + predicate + ') ? seen : null; })()');
  // The server hands back the object it is holding and serializes it per request, so a
  // world change is an in-place update, never a replacement of the reference.
  const swapMetric = async (variant, period, predicate) => {
    Object.assign(snapshot, buildFixture(variant));
    await evaluate('document.getElementById("refresh").click()');
    return settleMetric(period, predicate);
  };

  await clickText('#providers button', '요약');
  await settle('document.querySelectorAll(".summary-provider").length || 0');
  for (const period of PERIOD_PILLS) {
    expect((await selectPeriod(period.short)) === period.key, 'the ' + period.short + ' choice reports itself pressed');
    const head = await settle('(() => { const t = document.querySelector(".summary-columns")?.textContent || "";' +
      ' return t.includes(' + JSON.stringify(period.label) + ') ? t : null; })()');
    expect(head !== null, 'the summary column follows the ' + period.short + ' selection', head);
    const amount = await evaluate('document.querySelector(".summary-provider .summary-usage .metric > strong")?.textContent');
    expect(amount === period.provider, 'the summary row shows the API value for ' + period.short,
      { rendered: amount, expected: period.provider });
    // 금액과 쿼타 소모 모두 선택 기간을 따른다.
    const quotaHeld = await evaluate('(() => { const cell = document.querySelector(".summary-provider .metric.quota-used");' +
      ' return cell ? { label: cell.querySelector("span")?.textContent, value: cell.querySelector("strong")?.textContent } : null; })()');
    expect(quotaHeld !== null && quotaHeld.label === period.label + ' 쿼타 소모 합계' && quotaHeld.value === ({oneHour:'≈ 0.45%p',fiveHour:'≈ 2.25%p',twentyFourHour:'≈ 10.8%p',weekly:'≈ 18%p',monthly:'≈ 18%p'}[period.key]),
      'the quota figure follows the ' + period.short + ' amount is selected', quotaHeld);
    const need = await evaluate('document.querySelector(".summary-provider .recommend strong")?.textContent');
    expect(need === ({oneHour:'약 1개',fiveHour:'약 1개',twentyFourHour:'약 1개',weekly:'약 1개',monthly:'약 1개'}[period.key]),
      'the selected average changes account need for ' + period.short, need);
  }

  await clickText('#providers button', 'OpenAI');
  await settle('document.querySelectorAll(".account").length || 0');
  await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
  expect(await evaluate('document.getElementById("period-picker").hidden'), 'provider toolbar has no period buttons');
  expect(await evaluate('!document.querySelector(".provider-analytics > .usage-totals .selected")'), 'all-period provider totals imply no selected period');
  await evaluate(`(() => { const s=document.querySelector('.account-details .detail-period select'); s.focus(); s.value='oneHour'; s.dispatchEvent(new Event('change')); })()`);
  expect(await evaluate(`document.activeElement.matches('.account-details .detail-period select') && document.activeElement.value==='oneHour'`), 'local period selection restores keyboard focus');
  expect(await evaluate(`[...document.querySelectorAll('.account-details .detail-period select')].slice(1).every(s=>s.value==='weekly') && document.querySelector('.provider-details .detail-period select').value==='weekly'`), 'changing one account leaves sibling and provider details unchanged');
  expect(await evaluate('document.querySelector(\'#period-picker [aria-pressed="true"]\').dataset.period === "monthly"'), 'detail selection leaves summary period unchanged');
  await evaluate('document.getElementById("refresh").click()');
  await settle('!document.getElementById("refresh").disabled');
  expect(await evaluate(`document.activeElement.matches('.account-details .detail-period select') && document.activeElement.value==='oneHour'`), 'local selection and focus survive refresh');
  // Every choice has to reach the account detail, not only the one the next block checks.
  // A summary that moves while the detail stays behind is the bug this issue is about.
  for (const period of PERIOD_PILLS) {
    expect((await selectPeriod(period.short)) === period.key, 'the provider screen keeps the ' + period.short + ' choice pressed');
    const seen = await settle('(() => { const cell = document.querySelector(\'.account-details .usage-totals .metric[data-period="' + period.key + '"]\');' +
      ' if (!cell || !cell.classList.contains("selected")) return null;' +
      ' if (!cell.closest("details[open]") || cell.getClientRects().length === 0) return null;' +
      ' const tokens = [...document.querySelectorAll(".account-details .metrics")].find(el => el.textContent.includes("입력 토큰"));' +
      ' return { provider: document.querySelector(\'.provider-analytics > .usage-totals .metric[data-period="' + period.key + '"] > strong\')?.textContent,' +
      ' account: cell.querySelector("strong").textContent,' +
      ' calls: [...document.querySelectorAll(".account-details .sub-note")].map(e => e.textContent).find(t => t.includes("회 호출")) ?? "",' +
      ' tokens: tokens ? [...tokens.querySelectorAll(".metric > strong")].map(e => e.textContent) : null }; })()');
    expect(seen !== null && seen.provider === period.provider && seen.account === period.account,
      'the provider total and the account detail each read their own ' + period.short + ' value',
      { seen, expectedProvider: period.provider, expectedAccount: period.account });
    expect(seen !== null && seen.calls.startsWith(period.label + ' ' + period.calls + '회 호출'),
      'the account call line counts the ' + period.short + ' calls', seen && seen.calls);
    expect(seen !== null && JSON.stringify(seen.tokens) === JSON.stringify(period.tokens),
      'the token breakdown carries the ' + period.short + ' totals',
      { rendered: seen && seen.tokens, expected: period.tokens });
  }
  await selectPeriod('24시간');
  await settle('document.querySelector(\'.account-details .usage-totals .metric[data-period="twentyFourHour"]\')?.classList.contains("selected") || null');
  expect((await evaluate('document.querySelector(\'.provider-analytics > .usage-totals .metric[data-period="twentyFourHour"] > strong\')?.textContent')) === '$24.00',
    'the provider total reads its own 24-hour value');
  expect((await evaluate('document.querySelector(\'.account-details .usage-totals .metric[data-period="twentyFourHour"] > strong\')?.textContent')) === '$6.00',
    'the account detail reads the account 24-hour value rather than the provider one');
  expect(await evaluate('(() => { const grids = [...document.querySelectorAll(".account-details .usage-totals")];' +
    ' if (grids.length < 2) return false;' +
    ' return grids.every(g => { const marked = [...g.querySelectorAll(".metric.selected")];' +
    ' return marked.length === 1 && marked[0].dataset.period === "twentyFourHour"' +
    ' && marked[0].getAttribute("aria-current") === "true"; }); })()'),
    'every usage grid marks exactly one period, the chosen one, as selected');
  const callLine = await evaluate('[...document.querySelectorAll(".account-details .sub-note")].map(el => el.textContent).find(t => t.includes("회 호출")) ?? null');
  expect(/최근 24시간 12회 호출/.test(callLine ?? ''), 'the account call line follows the selected period', callLine);
  const tokenValues = await evaluate('(() => { const m = [...document.querySelectorAll(".account-details .metrics")]' +
    '.find(el => el.textContent.includes("입력 토큰"));' +
    ' return m ? [...m.querySelectorAll(".metric > strong")].map(el => el.textContent) : null; })()');
  expect(Array.isArray(tokenValues) && tokenValues[0] === '27,000' && tokenValues[1] === '7,500' &&
    tokenValues[2] === '12,000',
    'the token breakdown carries the selected period, twelve calls worth', tokenValues);
  const ratioLine = await evaluate('[...document.querySelectorAll(".account-details .sub-note")].map(el => el.textContent).find(t => t.includes("구독료")) ?? null');
  expect(/구독료 대비 최근 30일/.test(ratioLine ?? ''), 'the subscription ratio still names its own thirty days', ratioLine);

  await clickText('#providers button', '전체 계정');
  await settle('document.querySelectorAll(".account").length || 0');
  await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
  expect(await evaluate('!!document.querySelector(\'.account-details .usage-totals .metric[data-period="twentyFourHour"].selected\')'),
    'the same account retains its own detail period on the all-accounts screen');

  await clickText('#providers button', 'OpenAI');
  await settle('document.querySelectorAll(".account").length || 0');
  await evaluate('document.querySelectorAll("details.provider-details").forEach(el => el.open = true)');
  const projections = () => evaluate('document.querySelector(".provider-details .metrics")?.textContent ?? null');
  await selectPeriod('1시간');
  const shortPace = await projections();
  await selectPeriod('30일');
  const longPace = await projections();
  expect(shortPace !== null && shortPace !== longPace && /최근 7일 속도 기준/.test(shortPace),
    'account need follows the selected period while pace projections name their separate seven-day sample', { shortPace, longPace });
  // Account need names the selected quota sum and the chosen capacity period.
  const needMetric = await evaluate('(() => { const m = [...document.querySelectorAll(".provider-details .metric")]' +
    '.find(el => el.querySelector("span")?.textContent === "필요 계정");' +
    ' return m ? m.textContent : null; })()');
  // API dollar usage does not set account need.
  expect(needMetric !== null && /최근 30일 소모 합계 기준 · 주간 한도 기준/.test(needMetric),
    'the account need names the demand basis its own numbers imply and the weekly capacity', needMetric);

  await selectPeriod('1시간');
  await evaluate('document.querySelector("details.account-details").open = true');
  await evaluate('(() => { const nav = document.querySelector("#providers .nav-item.active");' +
    ' nav.dataset.qmPeriod = "1"; nav.focus(); return true; })()');
  await evaluate('document.getElementById("refresh").click()');
  expect(await settle('(() => { const b = document.querySelector("#providers .nav-item.active");' +
    ' return b && !b.dataset.qmPeriod && !document.getElementById("refresh").disabled ? true : null; })()'),
    'the refresh replaced the navigation before the period preservation checks ran');
  expect(await evaluate('document.activeElement.dataset.provider === "openai"'), 'keyboard focus survives a period-aware re-render');
  expect(await evaluate('document.querySelector(\'.account-details .detail-period select\')?.value === "oneHour"'),
    'the selected period survives the auto-refresh render path');
  expect(await evaluate('!!document.querySelector("details.account-details[open]")'), 'an open disclosure survives the period-aware re-render');

  // The button and the ten-second timer both call refresh(), but only the timer exercises
  // the unattended path the issue names. A cleared marker is not evidence: the once-a-minute
  // clock re-render clears it too. Count the snapshot request and wait for a value only the
  // new response can carry, so a timer that never fetches cannot pass on a minute boundary.
  await evaluate('(() => { window.__qmFetches = 0; const original = window.fetch;' +
    ' window.fetch = (...args) => { if (String(args[0]).includes("/api/v1/snapshot")) window.__qmFetches++;' +
    ' return original(...args); }; return true; })()');
  const timerToken = '타이머-증거-' + Date.now();
  const priorWarnings = snapshot.warnings;
  snapshot.warnings = [timerToken];
  await evaluate('(() => { document.querySelector("#providers .nav-item.active").focus(); return true; })()');
  const ticked = await settle('(() => { const notice = document.getElementById("notice");' +
    ' return window.__qmFetches > 0 && notice && notice.textContent.includes(' + JSON.stringify(timerToken) + ')' +
    ' && !document.getElementById("refresh").disabled ? window.__qmFetches : null; })()', 200);
  expect(ticked !== null, 'the ten-second timer fetches a new snapshot on its own, with nobody pressing refresh', ticked);
  expect(await evaluate('document.querySelector(\'.account-details .detail-period select\')?.value === "oneHour"'),
    'the selected period survives an unattended refresh');
  expect(await evaluate('document.activeElement.dataset.provider === "openai"'),
    'keyboard focus survives an unattended refresh');
  expect(await evaluate('!!document.querySelector("details.account-details[open]")'),
    'an open disclosure survives an unattended refresh');
  snapshot.warnings = priorWarnings;
  await evaluate('document.getElementById("refresh").click()');
  await settle('!document.getElementById("notice").textContent.includes(' + JSON.stringify('타이머-증거-') + ') || null');

  await clickText('#providers button', '요약');
  await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  expect(await settle('document.documentElement.scrollWidth <= window.innerWidth + 1 ? true : null'),
    'no horizontal page overflow at 320px with the period picker on screen');
  const pillNames = await evaluate('[...document.querySelectorAll("#period-picker button")]' +
    '.map(b => b.getAttribute("aria-label") + "|" + b.textContent.trim())');
  expect(JSON.stringify(pillNames) === JSON.stringify(['최근 1시간|1시간', '최근 5시간|5시간',
    '최근 24시간|24시간', '최근 7일|7일', '최근 30일|30일']),
    'each period choice states its span in an accessible name that contains its visible text', pillNames);
  expect(await evaluate('[...document.querySelectorAll("#period-picker button")]' +
    '.every(b => !b.disabled && b.tabIndex >= 0 && b.getClientRects().length > 0)'),
    'every period choice stays reachable by keyboard at 320px');
  await call('Emulation.clearDeviceMetricsOverride');
  await clickText('#providers button', 'OpenAI');
  await settle('document.querySelectorAll(".account").length || 0');

  // --- six worlds of usage evidence, each one internally consistent with the server ---
  await selectPeriod('24시간');
  const legacyMetric = await swapMetric('legacy', 'twentyFourHour', 'seen.state === "unsupported"');
  expect(legacyMetric && legacyMetric.note === '미지원' && legacyMetric.amount === '—',
    'a three-key response says the new period is unsupported instead of filling it in', legacyMetric);
  expect((await evaluate('document.querySelector(\'.usage-totals .metric[data-period="weekly"] > strong\')?.textContent')) === '$80.00',
    'the periods an older response does carry still read their own value');
  // 그 응답은 창이 제공자 전체를 재는지도 말해 주지 않는다. 그것은 한도가 없다는 뜻이 아니므로
  // '미지원' 과 다른 글자를 써야 한다.
  await clickText('#providers button', '요약');
  await settle('document.querySelectorAll(".summary-provider").length || 0');
  const legacyQuota = await evaluate('(() => { const cell = document.querySelector(".summary-provider .metric.quota-used");' +
    ' return cell ? { state: cell.dataset.quotaUsage, value: cell.querySelector("strong")?.textContent, title: cell.title } : null; })()');
  expect(legacyQuota && legacyQuota.state === 'unknown-scope' && legacyQuota.value === '범위 확인 불가' &&
    /사용량이 0이라는 뜻이 아닙니다/.test(legacyQuota.title ?? ''),
    'a response that never declares window scope says so rather than claiming the limit does not exist', legacyQuota);
  await clickText('#providers button', 'OpenAI');
  await settle('document.querySelectorAll(".account").length || 0');

  const stalledMetric = await swapMetric('stalled', 'twentyFourHour', 'seen.record === "full" && seen.observation === "partial"');
  expect(stalledMetric && /관측 부족/.test(stalledMetric.note),
    'a stalled collection reads as partly observed even where the retained log is complete', stalledMetric);
  expect(/갱신 지연/.test((await text('#notice')) ?? ''), 'a stalled collection is announced', await text('#notice'));

  const unobservedMetric = await swapMetric('unobserved', 'oneHour', 'seen.observation === "none"');
  expect(unobservedMetric && /미관측/.test(unobservedMetric.note) && /회 호출/.test(unobservedMetric.note),
    'a span we never read says so even where calls were recorded', unobservedMetric);

  const shortlogMetric = await swapMetric('shortlog', 'oneHour', 'seen.record === "none" && seen.observation === "full"');
  expect(shortlogMetric && /기록 부족/.test(shortlogMetric.note) && !/기록 없음/.test(shortlogMetric.note) &&
    /회 호출/.test(shortlogMetric.note),
    'a log that barely reaches the span is short rather than absent while calls exist', shortlogMetric);

  const freshMetric = await swapMetric('fresh', 'oneHour', 'seen.record === "none" && seen.note === "기록 없음"');
  expect(freshMetric && freshMetric.amount === '—', 'a store holding no row says the record is missing', freshMetric);

  const backMetric = await swapMetric('default', 'weekly', 'seen.record === "full" && seen.observation === "partial"');
  expect(backMetric && /관측 부족/.test(backMetric.note),
    'the ordinary world reads a fully retained but partly observed week', backMetric);
  const spans = await evaluate('document.querySelector(\'.provider-analytics > .usage-totals .metric[data-period="monthly"]\')?.title ?? null');
  expect(/기록 \d/.test(spans ?? '') && /관측 \d/.test(spans ?? ''),
    'the metric title keeps the retained log and the observed run apart', spans);

  await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
  const measuredZero = await evaluate('(() => { const acc = [...document.querySelectorAll(".account")]' +
    '.find(a => a.textContent.includes("장기 보관용"));' +
    ' const el = acc && acc.querySelector(\'.usage-totals .metric[data-period="weekly"]\'); if (!el) return null;' +
    ' return { amount: el.querySelector("strong").textContent, note: el.querySelector("small")?.textContent ?? "" }; })()');
  expect(measuredZero && measuredZero.amount === '$0.00' && /회 호출/.test(measuredZero.note),
    'a call that really cost nothing shows a measured zero, not an unknown price', measuredZero);

  await clickText('#providers button', 'Ollama Cloud');
  await settle('document.querySelectorAll(".account").length || 0');
  await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
  const unpricedMetric = await evaluate('(() => { const el = document.querySelector(\'.account-details .usage-totals .metric[data-period="monthly"]\');' +
    ' if (!el) return null; const small = el.querySelector("small");' +
    ' return { amount: el.querySelector("strong").textContent, note: small ? small.textContent : "" }; })()');
  expect(unpricedMetric && unpricedMetric.amount === '—' && /단가 미확인/.test(unpricedMetric.note),
    'calls whose price never resolved stay unpriced instead of turning into zero', unpricedMetric);


  // --- JUN-43: the repeated estimate badge leaves the rows for one caveat and the details ---
  // A row keeps what changes per row. A provider-wide assumption is said once under the usage
  // area, and the scope the total left out is named where the numbers are explained.
  const CAVEAT = 'API 환산액은 실제 청구액이 아니며, 캐시 사용량은 추정될 수 있고 가격 미확인 사용은 합계에서 제외됩니다.';
  expect((CAVEAT.match(/\./g) ?? []).length === 1 && CAVEAT.endsWith('제외됩니다.'),
    'the caveat is one sentence', CAVEAT);
  for (const [destination, label] of [['요약', 'summary'], ['Cursor', 'provider'], ['전체 계정', 'all-accounts']]) {
    await clickText('#providers button', destination);
    await settle('document.querySelectorAll(".summary-provider, .account").length || 0');
    const seen = await evaluate('(() => { const all = [...document.querySelectorAll(".usage-caveat")];' +
      ' return { count: all.length, text: all[0] ? all[0].textContent.trim() : null }; })()');
    expect(seen && seen.count === 1 && seen.text === CAVEAT,
      'exactly one caveat sentence stands under the ' + label + ' screen', seen);
  }

  await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  const wrapped = await settle('(() => { const el = document.querySelector(".usage-caveat"); if (!el) return null;' +
    ' const style = getComputedStyle(el);' +
    ' return { lines: Math.round(el.getBoundingClientRect().height / parseFloat(style.lineHeight)),' +
    ' overflow: el.scrollWidth - el.clientWidth, wordBreak: style.wordBreak,' +
    ' page: document.documentElement.scrollWidth - window.innerWidth }; })()');
  expect(wrapped && wrapped.lines >= 2 && wrapped.overflow <= 1 && wrapped.page <= 1 && wrapped.wordBreak === 'keep-all',
    'the caveat wraps over several lines at 320px without overflowing', wrapped);
  await call('Emulation.clearDeviceMetricsOverride');

  await clickText('#providers button', 'Cursor');
  await settle('document.querySelectorAll(".account").length || 0');
  await selectPeriod('30일');
  await evaluate('document.querySelectorAll("details.account-details, details.provider-details").forEach(el => el.open = true)');
  const partlyPriced = await settle('(() => { const el = document.querySelector(\'.provider-analytics > .usage-totals .metric[data-period="monthly"]\');' +
    ' if (!el) return null; return { note: el.querySelector("small")?.textContent ?? "",' +
    ' pricing: el.dataset.pricing || "", cache: el.dataset.cache || "", title: el.title }; })()');
  expect(partlyPriced && /회 호출/.test(partlyPriced.note) && /일부/.test(partlyPriced.note) &&
    !/캐시 추정/.test(partlyPriced.note),
    'a partly priced, cache-estimated row keeps its call count and 일부 and stops repeating the cache clause', partlyPriced);
  expect(partlyPriced && partlyPriced.pricing === 'partial' && partlyPriced.cache === 'estimated' &&
    /단가 미확인 \d/.test(partlyPriced.title) && /캐시 추정 \d/.test(partlyPriced.title),
    'the estimate facts stay on the cell and in its description after leaving the visible note', partlyPriced);
  const cacheInRows = await evaluate('[...document.querySelectorAll(".usage-totals .metric small")]' +
    '.map(el => el.textContent).filter(t => t.includes("캐시 추정"))');
  expect(Array.isArray(cacheInRows) && cacheInRows.length === 0,
    'no usage row repeats the cache-estimate clause', cacheInRows);

  const cursorDetail = await evaluate('(() => { const t = [...document.querySelectorAll(".account-details .sub-note")].map(e => e.textContent);' +
    ' return { excluded: t.find(s => s.includes("단가 미확인")) ?? null, cache: t.find(s => s.includes("캐시 추정")) ?? null,' +
    ' zero: t.some(s => s.includes("기록된 0 토큰")),' +
    ' calls: t.find(s => s.includes("회 호출")) ?? null }; })()');
  expect(cursorDetail && /단가 미확인 40회/.test(cursorDetail.excluded ?? '') &&
    /기록된 115,000 토큰이 합계에서 빠짐/.test(cursorDetail.excluded ?? ''),
    'the account details name the calls and the tokens the total left out', cursorDetail);
  expect(cursorDetail && /캐시 추정 120회/.test(cursorDetail.cache ?? '') &&
    /캐시 미적용 \$97\.20 → 추정 적용 \$60\.00/.test(cursorDetail.cache ?? ''),
    'the account details show what the cache assumption changed', cursorDetail);
  expect(cursorDetail && cursorDetail.zero === false &&
    /최근 30일 160회 호출/.test(cursorDetail.calls ?? ''),
    'no detail line claims a zero-token exclusion, and the call line is still the first one', cursorDetail);
  // Every period line, not the first one a find() happens to reach.
  const providerExcluded = await evaluate('[...document.querySelectorAll(".provider-details .sub-note")]' +
    '.map(e => e.textContent).filter(t => /회 호출 · 단가 확인/.test(t))');
  expect(Array.isArray(providerExcluded) && providerExcluded.length === 5 &&
    providerExcluded.every(t => /미확인 \d+회/.test(t) && /(토큰 제외|토큰 기록 0)/.test(t)),
    'every period line in the provider details names the excluded scope', providerExcluded);

  // A stored token count of zero cannot say whether the report was missing or really zero,
  // so those calls are counted apart from the tokens that were recorded.
  await clickText('#providers button', 'Ollama Cloud');
  await settle('document.querySelectorAll(".account").length || 0');
  await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
  await selectPeriod('30일');
  const unsized = await settle('[...document.querySelectorAll(".account-details .sub-note")]' +
    '.map(e => e.textContent).find(t => t.includes("단가 미확인")) ?? null');
  expect(/단가 미확인 160회/.test(unsized ?? '') && /기록된 345,000 토큰이 합계에서 빠짐/.test(unsized ?? '') &&
    /40회는 토큰 기록이 0이라/.test(unsized ?? '') && !/기록된 0 토큰/.test(unsized ?? ''),
    'calls whose stored token count is zero are counted apart from the tokens that were recorded', unsized);

  await clickText('#providers button', 'OpenAI');
  await settle('document.querySelectorAll(".account").length || 0');
  const stillFlagged = await evaluate('(() => ({ reauth: /로그인 필요/.test(document.querySelector(".accounts").textContent),' +
    ' delay: document.querySelectorAll(".refresh-note").length, stale: document.querySelectorAll(".window.stale").length,' +
    ' caveat: document.querySelectorAll(".usage-caveat").length }))()');
  expect(stillFlagged && stillFlagged.reauth && stillFlagged.delay === 1 && stillFlagged.stale > 0 &&
    stillFlagged.caveat === 1,
    'a login, a delayed lookup and an expired window stay where they are instead of being absorbed by the caveat', stillFlagged);

  await clickText('#providers button', '요약');
  expect(await evaluate('!document.querySelector("#providers [data-provider=prices]") && !document.querySelector("[data-price-check]")'),
    'automatic reference pricing requires no model-price navigation or confirmation entry');

  // --- JUN-124: fractional precision, the basis behind a number, and what is withheld ---
  await clickText('#providers button', 'OpenAI');
  await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
  const figures = await evaluate('(() => {' +
    ' const a = [...document.querySelectorAll(".account")].find(el => el.querySelector(".account-name")?.textContent === "계정 1");' +
    ' return [...a.querySelectorAll(".detail-window")].map(w => ({' +
    '   head: w.querySelector("h4")?.textContent,' +
    '   used: [...w.querySelectorAll("p.sub-note")].map(p => p.textContent).find(t => /% 사용/.test(t)) ?? null })); })()');
  const usedByWindow = Object.fromEntries((figures ?? []).filter(f => f.used).map(f => [f.head, f.used]));
  // An integer-only reading is not dressed up. 28 stays 28.
  expect(usedByWindow['주간'] === '28% 사용', 'a reading reported as a whole number is not padded with decimals', usedByWindow);
  // And a fractional one keeps both places rather than being rounded to one.
  expect(usedByWindow['5시간'] === '12.34% 사용', 'a fractional reading keeps two decimals instead of one', usedByWindow);

  const basis = await evaluate('(() => {' +
    ' const a = [...document.querySelectorAll(".account")].find(el => el.querySelector(".account-name")?.textContent === "계정 1");' +
    ' const w = [...a.querySelectorAll(".detail-window")].find(el => el.querySelector("h4")?.textContent === "5시간");' +
    ' const grid = w.querySelector(".measurement-basis");' +
    ' const origin = w.querySelector(".measurement-origin");' +
    ' return { source: grid.dataset.basisSource, scope: grid.dataset.basisScope,' +
    '   limitState: grid.dataset.limitState, reconciliation: grid.dataset.reconciliation,' +
    '   metrics: [...grid.querySelectorAll(".metric")].map(m => m.querySelector("span").textContent + "=" + m.querySelector("strong").textContent),' +
    '   origin: [...origin.querySelectorAll(".metric")].map(m => m.querySelector("span").textContent + "=" + m.querySelector("strong").textContent),' +
    '   notes: [...w.querySelectorAll("p.sub-note")].map(p => p.textContent) }; })()');
  // Visible text, not a data attribute. Confirming a basis means a person can read it.
  expect((basis?.origin ?? []).join('|').includes('읽은 곳=synthetic/usage')
    && (basis?.origin ?? []).join('|').includes('집계 범위=all'),
    'the detail names which reading a number came from and what it was scoped to, in visible text', basis?.origin);
  expect((basis?.origin ?? []).join('|').includes('단위=credits')
    && (basis?.origin ?? []).join('|').includes('주기 키=미제공'),
    'a null field in the contract is written as absent rather than silently dropped', basis?.origin);
  expect((basis?.metrics ?? []).join('|').includes('제공사 보고=12.34%')
    && (basis?.metrics ?? []).join('|').includes('계산값=12.34%'),
    'the reported figure and the calculated one are shown side by side rather than reconciled', basis?.metrics);
  expect((basis?.metrics ?? []).join('|').includes('사용량=123.4 credits')
    && (basis?.metrics ?? []).join('|').includes('한도=1,000 credits'),
    'the raw used and limit are shown with their unit', basis?.metrics);
  expect((basis?.notes ?? []).some(n => n.includes('제공사 값과 계산값 일치')),
    'the reconciliation verdict is stated rather than implied', basis?.notes);
  expect((basis?.notes ?? []).some(n => /^관측 /.test(n)) && (basis?.notes ?? []).some(n => /^조회 /.test(n)),
    'the detail separates when a reading was observed from when it was fetched', basis?.notes);

  // A reading the contract accepted but could not rate. It must not pretend to be a window.
  const evidenceRow = await evaluate('(() => {' +
    ' const el = document.querySelector(".evidence-window");' +
    ' if (!el) return null;' +
    ' const grid = el.querySelector(".measurement-basis");' +
    ' const origin = el.querySelector(".measurement-origin");' +
    ' return { window: el.dataset.evidenceWindow,' +
    '   endpoint: [...origin.querySelectorAll(".metric")].map(m => m.querySelector("span").textContent + "=" + m.querySelector("strong").textContent).join("|"),' +
    '   limitState: grid.dataset.limitState,' +
    '   metrics: [...grid.querySelectorAll(".metric")].map(m => m.querySelector("span").textContent + "=" + m.querySelector("strong").textContent),' +
    '   text: el.textContent, hasBar: Boolean(el.querySelector(".track")) }; })()');
  expect(evidenceRow?.window === 'monthly' && (evidenceRow?.endpoint ?? '').includes('읽은 곳=synthetic/usage'),
    'an unrateable reading is kept and names, in visible text, which reading produced it', evidenceRow);
  expect(evidenceRow?.limitState === 'zero' && /한도 0/.test(evidenceRow?.text ?? ''),
    'a zero limit is described as a zero limit, not as zero usage', evidenceRow);
  expect((evidenceRow?.metrics ?? []).join('|').includes('제공사 보고=미보고')
    && (evidenceRow?.metrics ?? []).join('|').includes('계산값=계산 불가'),
    'no percentage is invented for a reading that has none', evidenceRow?.metrics);
  expect(evidenceRow?.hasBar === false && !/% 사용/.test(evidenceRow?.text ?? ''),
    'an unrateable reading draws no bar and claims no share', evidenceRow);

  // Every directQuota status has a word, and the account-level one sits with the other badges.
  const directState = await evaluate('(() => {' +
    ' const b = document.querySelector(".badge.direct-status");' +
    ' const n = document.querySelector(".direct-next");' +
    ' return { status: b?.dataset.directStatus, label: b?.textContent,' +
    '   next: n?.textContent, nextAt: n?.dataset.directNext }; })()');
  expect(directState?.status === 'partial' && directState?.label === '일부 조회 실패',
    'an account whose endpoints disagree says so instead of reading as healthy', directState);
  expect(typeof directState?.next === 'string' && /조회/.test(directState.next) && Boolean(directState?.nextAt),
    'the next direct read is announced with its own instant', directState);

  // The withheld account: a login that needs attention keeps its last reading visible without
  // that reading being presented as current headroom.
  const withheldBlock = await evaluate('(() => {' +
    ' const a = [...document.querySelectorAll(".account")].find(el => el.querySelector(".account-name")?.textContent === "계정 2");' +
    ' const el = a?.querySelector(".last-known");' +
    ' return { status: el?.dataset.lastKnown, text: el?.textContent,' +
    '   rows: [...(el?.querySelectorAll("[data-last-known-window]") ?? [])].map(p => p.textContent),' +
    '   badge: [...a.querySelectorAll(".badge")].map(b => b.textContent) }; })()');
  expect(withheldBlock?.status === 'reauth' && /현재 가용량으로 쓰지 않습니다/.test(withheldBlock?.text ?? ''),
    'a withheld reading says outright that it is not current headroom', withheldBlock);
  expect((withheldBlock?.badge ?? []).includes('로그인 필요'),
    'the account still tells an existing client that a login is needed', withheldBlock?.badge);
  // 0.004% is a real positive reading. Rounded to two places it would read as a measured zero.
  expect((withheldBlock?.rows ?? []).some(r => r.includes('<0.01% 사용')),
    'a positive reading below the display threshold is distinguished from a measured zero',
    withheldBlock?.rows);

  // A reading whose instant the provider sent in a shape we cannot parse. Formatting it
  // blindly throws RangeError and the account stops rendering mid-way, so the screen has to
  // say it cannot read it and carry on.
  const unreadable = await evaluate('(() => {' +
    ' const a = [...document.querySelectorAll(".account")].find(el => el.querySelector(".account-name")?.textContent === "계정 1");' +
    ' const w = [...a.querySelectorAll(".detail-window")].find(el => el.querySelector("h4")?.textContent === "모델별 주간");' +
    ' return { notes: [...(w?.querySelectorAll("p.sub-note") ?? [])].map(p => p.textContent),' +
    '   windows: a.querySelectorAll(".detail-window").length }; })()');
  expect((unreadable?.notes ?? []).some(n => n === '관측 확인 불가'),
    'an instant we cannot parse is reported as unreadable instead of throwing', unreadable);
  expect(unreadable?.windows >= 3,
    'a window with an unreadable instant does not stop the rest of the account from rendering', unreadable);

  // Nothing here adds two readings together. The account carries two windows measured by
  // different endpoints at different scopes; their used quantities are 280 and 123.4 and 50.
  // No rendered number may be any of their sums, and evidence stays out of the window list.
  const summed = await evaluate('(() => {' +
    ' const a = [...document.querySelectorAll(".account")].find(el => el.querySelector(".account-name")?.textContent === "계정 1");' +
    ' const sources = [...a.querySelectorAll(".measurement-origin")].map(g => g.querySelector(".metric strong").textContent);' +
    ' const text = a.textContent ?? "";' +
    ' return { sources, evidenceInWindows: a.querySelectorAll(".windows .evidence-window").length,' +
    '   totals: [...a.querySelectorAll("*")].filter(el => /총소모|합계/.test(el.textContent ?? "")).length,' +
    '   sums: ["403.4", "330", "173.4", "453.4"].filter(n => text.includes(n)) }; })()');
  expect(new Set(summed?.sources ?? []).size >= 2,
    'the account really does carry readings from more than one source, so the next check is not vacuous',
    summed?.sources);
  expect((summed?.sums ?? []).length === 0,
    'no rendered figure is the sum of readings from different sources or scopes', summed?.sums);
  expect(summed?.evidenceInWindows === 0 && summed?.totals === 0,
    'evidence is kept out of the window list and no total is claimed across sources', summed);


  // The route from the summary to a price check and back, plus what the screen says while
  // the server is unreachable. It runs here, before the console collection below, so a
  // console error the route provokes is still counted.
  const flow = await regressionFlow({ page, snapshot, expect, screens: SCREENS });
  expect(flow?.partial !== true, 'the route ran to its end rather than stopping early, so this run can be read as a whole one', flow);

  for (const problem of problems) failures.push(problem);
  expect(problems.length === 0, 'browser console stays clean', problems);
} finally {
  await page.close();
}

if (failures.length) {
  console.error('ui-check failed (' + failures.length + ' of ' + checks.length + '):');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('ui-check passed: ' + checks.length + ' assertions');
console.log('ui-check screens: ' + SCREENS);
