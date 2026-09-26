// Deterministic snapshots for the dashboard smoke check. They mirror the shape
// the Go analytics produce and cover the states the UI must distinguish: fresh,
// stale, reauth, paused, disabled provider, partial capacity, cursor cache
// assumption, ollama calibration, an unpriced model — and six worlds of usage
// evidence, one per variant.
//
// Every offset is measured from the variant's own anchor T, the last successful
// usage-log read, never from the wall clock, so the coverage numbers come out as
// exact integers. The two coverage figures follow the server's usage periods:
// logCoverageHours is min(span, T − oldest retained row) and observedCoverageHours
// is the overlap between the span and the observation run, or 0 when that run has
// no far end.
//
// Provider totals are composed from the parts they actually hold — the listed
// accounts, the calls no account claims, and the rows of an account this snapshot
// no longer lists — so a subset can never report a call, a token or a dollar the
// total does not. Rates, ratios and the account suggestion are derived from those
// totals for the same reason.
const HOUR = 3600000;
const PERIODS: [string, number][] = [['oneHour', 1], ['fiveHour', 5], ['twentyFourHour', 24], ['weekly', 168], ['monthly', 720]];
const LEGACY_KEYS = new Set(['fiveHour', 'weekly', 'monthly']);
const UNIT = 0.5;
const SUBSCRIPTION_USD = 20;

// since, obsSince and obsThrough are offsets from T. A null since means not one
// usage row is retained; since === 0 means every retained row sits on the anchor,
// which is why those variants report the same count in all five spans. A null
// obsThrough means the observation run has no far end because an unresolved
// record is still holding it back.
const VARIANTS = {
  default:    { anchor: -5000,     since: -480 * HOUR, obsSince: -25 * HOUR, obsThrough: 0,    requests: [1, 4, 12, 40, 160] },
  legacy:     { anchor: -5000,     since: -480 * HOUR, obsSince: -25 * HOUR, obsThrough: 0,    requests: [1, 4, 12, 40, 160], legacy: true },
  stalled:    { anchor: -2 * HOUR, since: -478 * HOUR, obsSince: -23 * HOUR, obsThrough: 0,    requests: [1, 4, 12, 40, 160], stale: true, error: true },
  unobserved: { anchor: 0,         since: 0,           obsSince: -25 * HOUR, obsThrough: null, requests: [1, 1, 1, 1, 1] },
  shortlog:   { anchor: 0,         since: 0,           obsSince: -25 * HOUR, obsThrough: 0,    requests: [1, 1, 1, 1, 1] },
  fresh:      { anchor: 0,         since: null,        obsSince: -600000,    obsThrough: 0,    requests: [0, 0, 0, 0, 0] },
};

export const FIXTURE_VARIANTS = Object.keys(VARIANTS);

// The server's needed-account estimate (internal/calc RecommendFromTotal): the
// provider-wide weekly (else monthly) window's summed %p inside the period,
// scaled to the window's length and rounded up, with no headroom.
function quotaNeed(provider: any, key: string, periodHours: number) {
  const accounts = provider.accounts ?? [];
  const windowId = ['weekly', 'monthly'].find(id => accounts.some(a =>
    a.windows?.some(w => w.id === id && w.analytics?.providerWide === true)));
  const capacityHours = windowId === 'weekly' ? 168 : windowId === 'monthly' ? 720 : null;
  const current = accounts.filter(a => !['reauth', 'paused'].includes(a.status)).length;
  const result = { status: 'collecting', basisPeriod: key, periodHours, demandBasis: 'quota-consumption',
    headroomPercent: 0, windowId: windowId ?? null, capacityHours, currentAccounts: current, minimumAccounts: null,
    recommendedAccounts: null, additionalAccounts: null, totalConsumedPp: null, sampleAccounts: 0, estimatedMonthlyUsd: null,
    reason: '주간·월간 쿼타 소모 기록을 기다리고 있습니다.' };
  const measured = accounts.flatMap(a => {
    const sample = a.windows?.find(w => w.id === windowId && w.analytics?.providerWide === true)
      ?.analytics?.consumptionPeriods?.[key];
    return Number.isFinite(sample?.deltaPp) && sample.deltaPp >= 0 ? [{ a, sample }] : [];
  });
  if (!measured.length || !(periodHours > 0)) return result;
  const total = measured.reduce((sum, { sample }) => sum + sample.deltaPp, 0);
  const raw = total / 100 * capacityHours! / periodHours;
  const nearest = Math.round(raw);
  const needed = Math.ceil(nearest > 0 && Math.abs(raw - nearest) <= Number.EPSILON * Math.max(1, raw) * 8 ? nearest : raw);
  const incomplete = measured.length < accounts.length || measured.some(({ sample }) =>
    !Number.isFinite(sample.spanHours) || sample.spanHours < periodHours - 1 / 3600 ||
    !Number.isFinite(sample.coverage) || sample.coverage < 1 - 1e-9);
  const observedIncrease = measured.some(({ sample }) => sample.basis === 'observed-increase');
  const prices = measured.map(({ a }) => a.analytics?.subscription?.monthlyUsd);
  return { ...result, status: observedIncrease || incomplete ? 'provisional' : 'ready', minimumAccounts: needed,
    recommendedAccounts: needed, additionalAccounts: Math.max(0, needed - current), totalConsumedPp: total,
    sampleAccounts: measured.length,
    estimatedMonthlyUsd: prices.every(p => Number.isFinite(p) && p > 0) ? needed * prices.reduce((s, p) => s + p, 0) / prices.length : null,
    reason: `${windowId === 'weekly' ? '주간' : '월간'} 쿼타 소모 합계 ${Number(total.toFixed(4))}%p ÷ 100 × (${capacityHours}시간 ÷ ${periodHours}시간), 올림 = ${needed}개. 여유분을 더하지 않습니다.` };
}

export function buildFixture(variantName = 'default') {
  const v = VARIANTS[variantName];
  if (!v) throw new Error('unknown fixture variant: ' + variantName);
  const now = Date.now();
  const T = now + v.anchor;
  const at = offset => new Date(now + offset).toISOString();
  const fromT = offset => new Date(T + offset).toISOString();
  // A priced history only has length when a retained row is older than the anchor.
  const hasSpan = v.since !== null && v.since < 0;
  const logCoverage = hours => v.since === null ? 0 : Math.min(hours, -v.since / HOUR);
  const observedCoverage = hours => v.obsThrough === null
    ? 0 : Math.max(0, v.obsThrough - Math.max(-hours * HOUR, v.obsSince)) / HOUR;
  const keys = PERIODS.filter(([key]) => !v.legacy || LEGACY_KEYS.has(key));
  const build = make => Object.fromEntries(keys.map(([key, hours]) =>
    [key, make(key, hours, PERIODS.findIndex(entry => entry[0] === key))]));
  const span = hours => {
    const row: Record<string, unknown> = { startedAt: fromT(-hours * HOUR), endedAt: fromT(0), hours,
      logCoverageHours: logCoverage(hours), observedCoverageHours: observedCoverage(hours) };
    // A three-key server knew none of this metadata, so it must not appear here.
    if (v.legacy) { delete row.hours; delete row.logCoverageHours; delete row.observedCoverageHours; }
    return row;
  };
  // priced: every call resolved a price. zero: the calls really cost nothing.
  // unknown: no call in the span ever resolved one, so the amount stays null.
  // partial: some calls priced and some not, which is the only state that carries 일부.
  //
  // A quarter of an unknown world's calls have a stored token count of zero. The store folds
  // a missing usage report and a reported zero into the same 0 (the store keeps them apart), so the
  // excluded-token total cannot size those calls and they are counted on their own instead.
  // The cache sidecar only attaches to a row whose price resolved, so cache estimation follows
  // the priced calls rather than every call; otherwise this would not be a world the server could produce.
  const part = (scale, kind = 'priced', cache = false) => build((key, hours, index) => {
    const requests = v.requests[index] * scale;
    const unpriced = kind === 'unknown' ? requests : kind === 'partial' ? Math.floor(requests / 4) : 0;
    const unsized = kind === 'unknown' ? Math.floor(requests / 4) : 0;
    const pricedRequests = requests - unpriced;
    const sized = requests - unsized;
    const apiUsd = pricedRequests === 0 ? null : pricedRequests * (kind === 'zero' ? 0 : UNIT);
    const cached = cache ? pricedRequests : 0;
    return { requests, tokens: sized * 2875, inputTokens: sized * 2250, outputTokens: sized * 625,
      cachedTokens: sized * 1000, pricedRequests,
      apiUsd: requests === 0 ? null : apiUsd, unknownPriceRequests: unpriced,
      unknownPriceTokens: kind === 'unknown' ? sized * 2875 : unpriced * 2875,
      unknownPriceUnsizedRequests: unsized,
      localPriceRequests: 0, cacheEstimatedRequests: cached,
      estimatedCachedTokens: cached * 400,
      noCacheApiUsd: requests === 0 || apiUsd === null ? null : apiUsd * (cache ? 1.62 : 1),
      ...span(hours) };
  });
  const EMPTY = part(0);
  // Compose a provider total from the parts it actually holds.
  const compose = parts => build((key, hours) => {
    const rows = parts.map(p => p[key]).filter(Boolean);
    const sum = pick => rows.reduce((total, row) => total + pick(row), 0);
    const priced = rows.filter(row => row.apiUsd !== null);
    return { requests: sum(r => r.requests), tokens: sum(r => r.tokens), inputTokens: sum(r => r.inputTokens),
      outputTokens: sum(r => r.outputTokens), cachedTokens: sum(r => r.cachedTokens),
      pricedRequests: sum(r => r.pricedRequests),
      apiUsd: priced.length ? priced.reduce((total, row) => total + row.apiUsd, 0) : null,
      unknownPriceRequests: sum(r => r.unknownPriceRequests), localPriceRequests: sum(r => r.localPriceRequests),
      unknownPriceTokens: sum(r => r.unknownPriceTokens),
      unknownPriceUnsizedRequests: sum(r => r.unknownPriceUnsizedRequests),
      cacheEstimatedRequests: sum(r => r.cacheEstimatedRequests),
      estimatedCachedTokens: sum(r => r.estimatedCachedTokens),
      noCacheApiUsd: priced.length ? priced.reduce((total, row) => total + (row.noCacheApiUsd ?? row.apiUsd), 0) : null,
      ...span(hours) };
  });
  // A rate needs a priced week and a history with length. Without both the server
  // reports null rather than a rate built from an amount it does not have.
  // pace and the account suggestion read one priced history, so they share its length:
  // the week, clipped to whatever the retained rows actually cover.
  const retainedDays = v.since === null ? 0 : -v.since / HOUR / 24;
  const pricedWeekHours = Math.min(168, retainedDays * 24);
  const paceOf = periods => {
    const weekly = periods.weekly;
    const rate = hasSpan && pricedWeekHours >= 1 && weekly && weekly.apiUsd !== null
      ? weekly.apiUsd / pricedWeekHours : null;
    return { usdPerHour: rate, projectedFiveHourUsd: rate === null ? null : rate * 5,
      projectedWeekUsd: rate === null ? null : rate * 168,
      observedHours: rate === null ? 0 : pricedWeekHours,
      observedAt: fromT(0), stale: Boolean(v.stale), basisPeriod: 'weekly',
      pricedCoverage: weekly && weekly.requests ? weekly.pricedRequests / weekly.requests : 0 };
  };
  const ratioOf = periods => periods.monthly && periods.monthly.apiUsd !== null
    ? periods.monthly.apiUsd / SUBSCRIPTION_USD : null;
  // The account need keeps its own sample and follows the server's recommendation:
  // the larger of the thirty-day baseline and the recent week, with five-hour peaks kept as reference, divided by the measured per-account capacity.
  const recommendationOf = (periods, configured, eligible, fiveHourAccounts) => {
    const monthly = periods.monthly, weekly = periods.weekly;
    const accountCount = eligible.length;
    const capacity: any = accountCount
      ? eligible.reduce((sum, a) => sum + a.windows.find(w => w.id === 'weekly' && (w.usageScope == null || w.usageScope === 'all')).analytics.capacityApiUsd, 0) / accountCount
      : null;
    // Configured accounts are what the user has; the capacity sample is the subset that
    // could be measured. A limit we could not convert does not un-register an account.
    // The suggestion measures its history with pricedBounds(), and that query counts only
    // rows whose amount resolved (the store's priced sum). A provider holding nothing but
    // unconfirmed prices therefore has no history at all, however long the log is.
    const pricedHistory = hasSpan && monthly && monthly.apiUsd > 0 && monthly.pricedRequests > 0;
    const observedDays = Math.min(30, Math.max(pricedHistory ? retainedDays : 0,
      (monthly?.observedCoverageHours ?? 0) / 24));
    const base = { status: 'collecting', observedDays, weeklyDemandApiUsd: null,
      weeklyCapacityPerAccountUsd: null, minimumAccounts: null, recommendedAccounts: null,
      currentAccounts: configured.length, additionalAccounts: null, estimatedMonthlyUsd: null,
      headroomPercent: 20, demandBasis: null, baselineWeeklyDemandApiUsd: null,
      recentWeeklyDemandApiUsd: null, recentObservedDays: 0, peakFiveHourAccounts: null,
      reason: '계정당 한도 가치와 사용 기록을 수집 중입니다.', planLabel: null,
      capacitySampleAccounts: 0, fiveHourSampleAccounts: 0, observedAt: fromT(0),
      usageStale: Boolean(v.stale) };
    // The server decides in this order: a history, then a priced month,
    // then the demand, and only then the capacity to divide it by. Missing capacity does
    // not erase a demand the function had already worked out, so neither does this.
    if (observedDays < 1) return { ...base, reason: '최소 하루의 사용 기록이 필요합니다. 최근 30일이 쌓일수록 안정적입니다.' };
    if (!monthly || monthly.apiUsd === null) return { ...base, reason: '환산 가능한 사용 기록을 기다리고 있습니다.' };
    const recentObservedDays = Math.min(7, observedDays);
    const baseline = monthly.apiUsd / observedDays * 7;
    const recent = weekly && weekly.apiUsd !== null && recentObservedDays >= 1
      ? weekly.apiUsd / recentObservedDays * 7 : null;
    const demand = Math.max(baseline, recent ?? 0);
    const known = { ...base, recentObservedDays, baselineWeeklyDemandApiUsd: baseline,
      recentWeeklyDemandApiUsd: recent, weeklyDemandApiUsd: demand,
      demandBasis: recent !== null && recent >= baseline ? 'recent-week' : 'monthly-baseline' };
    if (!accountCount) return { ...known, reason: '주간 한도가 측정된 계정을 기다리고 있습니다.' };
    const weeklyNeed = demand / capacity;
    // The busiest five-hour block over thirty days is not derivable from period totals.
    // The fixture pins an average day's spend, taken from the month so that a response
    // carrying fewer period keys still has the same basis behind its suggestion. Any
    // thirty-day arrangement can hold a block that large, which the gate also checks.
    const peakUsd = fiveHourAccounts.length ? monthly.apiUsd / 30 : null;
    const peakNeed = peakUsd === null ? 0 : peakUsd / capacity;
    const need = weeklyNeed;
    const recommended = Math.max(1, Math.ceil(need / 0.8));
    return { status: 'provisional', observedDays, weeklyDemandApiUsd: demand,
      weeklyCapacityPerAccountUsd: capacity, minimumAccounts: Math.max(1, Math.ceil(need)),
      recommendedAccounts: recommended, currentAccounts: configured.length,
      additionalAccounts: Math.max(0, recommended - configured.length),
      estimatedMonthlyUsd: recommended * SUBSCRIPTION_USD, headroomPercent: 20,
      demandBasis: recent !== null && recent >= baseline ? 'recent-week' : 'monthly-baseline',
      baselineWeeklyDemandApiUsd: baseline, recentWeeklyDemandApiUsd: recent,
      recentObservedDays, peakFiveHourAccounts: peakUsd === null ? null : Math.ceil(peakNeed),
      reason: '여유를 반영한 필요 구독 ' + recommended + '개 · 설정된 사용 가능 구독 ' + accountCount + '개.',
      planLabel: '관측 계정 평균', capacitySampleAccounts: accountCount,
      fiveHourSampleAccounts: fiveHourAccounts.length, observedAt: fromT(0), usageStale: Boolean(v.stale) };
  };

  // A window the server returns early for carries no forecast at all. Mirroring emptyResult
  // here is what lets a variant show the difference between an unwatched limit and an idle one.
  const NO_FORECAST = { forecastRatePpHour: null, forecastObservedAt: null, forecastObservedHours: 0,
    forecastSpanHours: 0, forecastCoverage: null, forecastDeltaPp: null };
  // A response from before JUN-225 carries neither new field. The legacy variant is where the
  // screen's compatibility branch gets exercised, so the fields must really be absent rather than
  // present and false — those are different facts and the screen says different things about them.
  const legacyShape = analytics => {
    if (!v.legacy) return analytics;
    const { providerWide, forecastDeltaPp, ...rest } = analytics;
    return rest;
  };
  const windowAnalytics = (overrides = {}) => legacyShape({ status: 'ok', recentRatePpHour: 0.8, averageRatePpHour: 0.6,
    exhaustsAt: at(9 * HOUR), forecastRatePpHour: 0.6, forecastObservedAt: at(-30000),
    forecastObservedHours: 30, forecastSpanHours: 40, forecastCoverage: 0.75, resetBeforeExhaustion: false,
    // The consumption the rate was divided from: 0.6%p/h over 30 watched hours. The fixture gate
    // checks the two against each other, so a variant cannot drift one without the other.
    forecastDeltaPp: 18, providerWide: true,
    projectedUsedAtReset: 70, capacityApiUsd: 120, remainingApiUsd: 48, matchedApiUsd: 30, matchedDeltaPp: 25,
    observedHours: 30, confidence: 'medium', capacityBasis: 'matched', capacityObservedAt: at(-30000),
    capacityObservedDeltaPp: 25, capacityMatchedQuotaCoverage: 0.9, capacitySourceLabel: '이 계정 25%p 관측',
    capacityReason: '같은 구간의 API 환산액과 쿼타 변화를 비교했습니다.',
    reason: '관측된 사용과 쿼타 변화의 비례 추정입니다.',
    history: Array.from({ length: 12 }, (unused, index) => ({ at: at(-(12 - index) * 600000),
      usedPercent: index * 5, resetAt: at(6 * HOUR) })),
    ...overrides });
  // What the number is based on, mirroring the server's quota measurement. Every window carries one
  // so the screen's basis rows have something to draw in every variant.
  const measurementOf = (usedPercent, overrides = {}) => ({
    source: 'synthetic/usage', method: 'used_limit', reportedPercent: usedPercent,
    used: usedPercent * 10, limit: 1000, unit: 'credits', limitState: 'present',
    scopeKey: 'all', cycleKey: null, windowSemantics: 'fixed_reset',
    observedAt: at(-30000), fetchedAt: at(-30000), sourceVersion: 'synthetic-1',
    resolutionPp: null, precisionEvidence: 'observed_fraction', usedAccumulation: 'unknown',
    calculatedPercent: usedPercent, reconciliation: 'matched', ...overrides });
  // measurement is composed after the spread on purpose: an override carries only the fields
  // it wants to change, so spreading it over a composed measurement would replace the whole
  // contract with a fragment and leave the rest undefined.
  const quotaWindow = (id: string, label: string, usedPercent: number, overrides: any = {}): any => ({ id, label, usedPercent,
    remainingPercent: 100 - usedPercent, resetAt: at(6 * HOUR), stale: false,
    ...overrides,
    measurement: measurementOf(usedPercent, overrides.measurement),
    // providerWide mirrors the server's window scope: the standard ids measure the
    // provider as a whole, a scoped or unrecognised custom window does not.
    analytics: windowAnalytics({
      providerWide: (overrides.usageScope ?? (id.startsWith('custom-') ? null : 'all')) === 'all',
      // The server returns before the forecast for a stale window, a missing reset and a
      // reset that has already passed. A fixture that keeps a forecast through any of those is a
      // world the server cannot produce, and an assertion passing against it proves nothing.
      // ?? would treat an explicit null reset as absent and hand it the default future instant,
      // which is the one case this rule exists for.
      ...(overrides.stale || !(Date.parse('resetAt' in overrides ? overrides.resetAt : at(6 * HOUR)) > now)
        ? NO_FORECAST : {}),
      ...overrides.analytics }) });
  const account = (id: string, label: string, periods: any, overrides: any = {}): any => ({ id, label, plan: 'pro', active: true,
    status: 'ok', updatedAt: at(-30000), quotaMode: 'observed',
    refresh: { status: 'ok', lastAttemptAt: at(-30000), nextAttemptAt: null }, ...overrides,
    // The server returns before the forecast for a reauth or paused account, so the windows
    // of one cannot carry a consumption figure either. Applied after the spread so an override
    // supplying its own windows goes through the same rule.
    windows: (overrides.windows ?? [quotaWindow('weekly', '주간', 40)]).map(w =>
      ['reauth', 'paused'].includes(overrides.status)
        ? { ...w, analytics: legacyShape({ ...w.analytics, ...NO_FORECAST }) } : w),
    analytics: { periods, pace: paceOf(periods),
      subscription: { label: 'Pro', monthlyUsd: SUBSCRIPTION_USD, basis: 'user-confirmed' },
      monthlyValueRatio: ratioOf(periods),
      monthlyValueBasis: periods.monthly && periods.monthly.apiUsd === null ? null
        : periods.monthly && periods.monthly.unknownPriceRequests > 0 ? 'partial' : 'matched',
      ...overrides.analytics } });
  const usable = w => w && !w.stale && Number.isFinite(w.analytics.capacityApiUsd) && w.analytics.capacityApiUsd > 0;
  const provider = (id: string, name: string, enabled: boolean, defaultModel: string | null, accounts: any[], unattributed: any, unlisted: any, extra: any = {}): any => {
    // An account waiting on a login or paused cannot take work, so it is not one of the
    // accounts the suggestion is counting against. Among those, only the ones whose
    // weekly limit was converted can supply a capacity figure.
    const configured = accounts.filter(a => !['reauth', 'paused', 'unavailable'].includes(a.status));
    const eligible = configured.filter(a => usable(a.windows.find(w => w.id === 'weekly' && (w.usageScope == null || w.usageScope === 'all'))));
    const fiveHourAccounts = eligible.filter(a =>
      usable(a.windows.find(w => w.id === 'five-hour' || w.id === 'short')));
    const periods = compose([...accounts.map(a => a.analytics.periods), unattributed, unlisted]);
    const unpriced = periods.monthly ? periods.monthly.unknownPriceRequests : 0;
    // The server marks an account ratio partial when the provider holds unattributed
    // monthly usage, because that usage is not in the account amount behind the ratio.
    for (const a of accounts) {
      const m = a.analytics.periods.monthly;
      a.analytics.monthlyValueBasis = !m || m.apiUsd === null ? null
        : m.unknownPriceRequests > 0 || (unattributed.monthly?.requests ?? 0) > 0 ? 'partial' : 'matched';
    }
    return { id, name, enabled, defaultModel, accounts,
      analytics: { periods, pace: paceOf(periods), subscriptionMonthlyUsd: accounts.length * SUBSCRIPTION_USD,
        unattributed: unattributed.weekly ?? unattributed.monthly,
        ...(unpriced > 0 ? { unpricedModels: [{ model: 'mystery-model', requests: Math.min(3, unpriced) }] } : {}),
        nextExhaustionAt: at(9 * HOUR), nextExhaustionAccount: accounts[0]?.label ?? null,
        recommendation: recommendationOf(periods, configured, eligible, fiveHourAccounts), ...extra } };
  };

  const a1 = account('a1', '계정 1', part(1), { windows: [
      // An integer-only reading and a fractional one side by side: 28 must not become 28.00,
      // and 12.34 must keep both places.
      quotaWindow('weekly', '주간', 28, { measurement: { precisionEvidence: 'integer_only',
        reportedPercent: 28, calculatedPercent: 28, used: 280, limit: 1000 },
        // Four measured weekly cycles, the last two after a supply cut. The estimate uses the
        // two cycles after the change and the note names both sides of it.
        analytics: { capacityApiUsd: 120,
          capacityCycles: [160, 170, 118, 122].map((apiUsd, i) => ({ from: at((i - 4) * 168 * HOUR), to: at((i - 3) * 168 * HOUR - HOUR),
            resetAt: at((i - 3) * 168 * HOUR), apiUsd, deltaPp: 40, matchedDeltaPp: 40, matchedApiUsd: apiUsd * 0.4, usable: true, selected: i >= 2 })),
          capacityShift: { at: at(-2 * 168 * HOUR), beforeApiUsd: 165, afterApiUsd: 120, changeRatio: 120 / 165 - 1 } } }),
      quotaWindow('five-hour', '5시간', 12.34, { resetAt: at(-60000),
        measurement: { reportedPercent: 12.34, calculatedPercent: 12.34, used: 123.4, limit: 1000 } }),
      // A second reading of the same account from a different endpoint and a different scope.
      // Its used quantity must never be added to the one above: they count different things.
      quotaWindow('custom-9', '모델별 주간', 5, { usageScope: 'fable',
        measurement: { source: 'synthetic/extra', scopeKey: 'model:fable',
          reportedPercent: 5, calculatedPercent: 5, used: 50, limit: 1000,
          // A provider instant we cannot read. Formatting it blindly throws and takes the
          // whole render down, so the screen has to say it cannot read it.
          observedAt: 'not-an-instant', cycleKey: null } })],
    refresh: { status: 'delayed', lastAttemptAt: at(-120000), nextAttemptAt: at(45000) },
    directQuota: { status: 'partial', lastAttemptAt: at(-30000), nextAttemptAt: at(90000),
      reason: null, expiresAt: null,
      endpoints: [{ id: 'usage', status: 'ok', lastAttemptAt: at(-30000), nextAttemptAt: at(90000), reason: null },
        { id: 'extra', status: 'rate_limited', lastAttemptAt: at(-60000), nextAttemptAt: at(120000), reason: null }],
      // A reading the contract accepted but could not rate: a spend against a zero limit.
      // It must never render a percentage, and 0.004 must not collapse into a measured zero.
      evidence: [{ id: 'monthly', label: '월간', endpointId: 'extra', resetAt: at(6 * HOUR),
        measuredAt: at(-30000), stale: false,
        measurement: measurementOf(0, { method: 'used_limit', reportedPercent: null,
          calculatedPercent: null, used: 4200, limit: null, limitState: 'zero',
          unit: 'usd-cents', reconciliation: 'unverified', precisionEvidence: 'unknown' }) }] } });
  const a2 = account('a2', '계정 2', part(1), { status: 'reauth',
    directQuota: { status: 'credential_expired', lastAttemptAt: at(-120000),
      nextAttemptAt: at(240000), reason: null, expiresAt: at(-60000),
      endpoints: [{ id: 'usage', status: 'credential_expired', lastAttemptAt: at(-120000),
        nextAttemptAt: at(240000), reason: null }],
      // Kept, but never promoted into account.windows: the account still says reauth.
      lastKnown: { accountStatus: 'reauth', windows: [{ id: 'weekly', label: '주간',
        usedPercent: 0.004, remainingPercent: 99.996, resetAt: at(6 * HOUR), stale: true,
        measuredAt: at(-120000), measurement: measurementOf(0.004, { reportedPercent: 0.004,
          calculatedPercent: 0.004, used: 0.04, limit: 1000 }) }] } },
    windows: [quotaWindow('weekly', '주간', 90, { stale: true,
      analytics: { status: 'stale', capacityApiUsd: null, remainingApiUsd: null, exhaustsAt: null,
        confidence: null, capacityBasis: null, reason: '로그인을 갱신해야 한도를 계산할 수 있습니다.', history: [] } })],
    refresh: { status: 'delayed', lastAttemptAt: at(-120000), nextAttemptAt: at(60000) } });
  // Zero-priced usage lives here: a real $0.00 must not read like an unknown price.
  const a3 = account('a3', '장기 보관용 조직 공용 워크스페이스 일시 중지 계정 (하반기 아카이브)',
    build((key, hours, index) => part(1, 'zero')[key]), { status: 'paused',
      windows: [quotaWindow('weekly', '주간', 10, { stale: true, analytics: { status: 'stale', history: [] } }),
        quotaWindow('monthly', '월간', 40, { stale: true, analytics: { status: 'stale', history: [] } })] });
  const b1 = account('b1', 'Anthropic 계정', part(1), { windows: [
    // Seven days holds more than thirty of these cycles, so its consumption runs past 100%p. The
    // detail says how many limits that is, and the summary must not pick this window at all.
    quotaWindow('five-hour', '5시간', 12, { analytics: { forecastRatePpHour: 11.5, forecastDeltaPp: 345 } }),
    // Fully watched for the whole week, and 88% used right now against 42%p consumed over it. The
    // two numbers disagree because the limit reset inside the window, which is the point.
    quotaWindow('weekly', '전체 주간', 88, { usageScope: 'all',
      analytics: { capacityBasis: 'lower-bound', confidence: 'low', unexplainedDeltaPp: 24,
        forecastRatePpHour: 0.25, forecastObservedHours: 168, forecastSpanHours: 168,
        forecastCoverage: 1, forecastDeltaPp: 42,
        capacityReason: '환산하지 못한 쿼타 변화까지 분모에 넣어 보수적으로 계산했습니다.' } }),
    quotaWindow('custom-0', 'Fable 주간', 95, { usageScope: 'fable',
      analytics: { capacityBasis: 'lower-bound', confidence: 'low', capacityMatchedQuotaCoverage: 0.4,
        unexplainedDeltaPp: 24,
        capacityReason: '환산하지 못한 쿼타 변화까지 분모에 넣어 보수적으로 계산했습니다.' } }),
  ] });
  // Partly priced and cache-estimated in one place: the row that used to read '일부 · 캐시 추정'.
  const c1 = account('c1', 'Cursor 계정', part(1, 'partial', true), { windows: [quotaWindow('monthly', '월간', 5)] });
  // Unconfirmed prices live here: calls exist but no amount was ever resolved.
  const d1 = account('key:d1', 'Ollama 키', part(1, 'unknown'), { plan: null,
      windows: [quotaWindow('weekly', '주간', 2, { resetAt: null,
        analytics: { status: 'unsupported', capacityApiUsd: null, remainingApiUsd: null, exhaustsAt: null,
          confidence: null, capacityBasis: null, reason: '리셋 시각이 없어 같은 한도 구간인지 확인할 수 없습니다.' } })],
      ollama: { status: 'collecting', windows: [{ id: 'weekly', label: '주간', models: [
        { model: 'qwen3-coder', intervals: 3, requests: 9, deltaPp: 1.5, inputTokens: 90000,
          outputTokens: 12000, apiUsd: 0.4, priced: true, inputTokensPerPp: 60000,
          outputTokensPerPp: 8000, apiUsdPerPp: 0.27 }] }] } });

  // --- JUN-47: 모델 가격 화면이 읽는 자료 ---
  // 단가 값은 internal/store/price_rules.json 의 실제 표에서 확인한 것이고, 모양은 서버 응답의
  // 계약 테스트가 진짜 collector 응답의 키와 맞대어 본다. 여기서 화면이 구분해야 하는 상태를
  // 모두 만든다: 확인된 단가, 값이 0인 무료 단가, 미확인, 일부 항목 누락, 별칭, 여러 과금 조건,
  // 그리고 목록에서 제거되었지만 과거 사용 기록이 남은 모델.
  const OAI_SOURCE = 'https://developers.openai.com/api/docs/pricing';
  const CLAUDE_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
  const XAI_SOURCE = 'https://docs.x.ai/developers/pricing';
  const OLLAMA_SOURCE = 'https://ollama.com/pricing';
  const COMPOSER_SOURCE = 'https://prod.cursor.com/docs/models/cursor-composer-2-5';
  const rates = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });
  const NO_RATES = rates(null, null, null, null);
  const condition = (id, overrides = {}) => ({ id, inputTokensFrom: null, serviceTier: null,
    claudeCacheTtl: null, peak: null, status: 'official', rates: NO_RATES, tierMultiplier: 1,
    sourceUrl: null, checkedAt: null, effectiveFrom: null, effectiveTo: null,
    conditions: [], unsupported: [], conflict: null, reason: null, ...overrides });
  const priceRow = (model, overrides = {}) => ({ model, sources: ['ocx-config'], requests: 0,
    unpricedRequests: 0, tokens: 0, cachedTokens: 0, providerBasis: 'attributed', status: 'unpriced',
    unit: 'usd-per-million-tokens', pricedModel: null, rates: NO_RATES,
    sourceUrl: null, checkedAt: null, effectiveFrom: null, effectiveTo: null,
    conditions: [], unsupported: [], conflict: null, priceConditions: [],
    priceConditionsComplete: true, reason: null, ...overrides });
  const rosterModel = (model, state, overrides = {}) => ({ model, state, sources: ['ocx-config'],
    firstSeenAt: at(-20 * 86400000), lastListedAt: state === 'removed' ? at(-9 * 86400000) : at(-5000),
    lastObservedAt: null, removedAt: state === 'removed' ? at(-8 * 86400000) : null, ...overrides });
  const roster = models => ({ status: 'ok', baselineAt: at(-20 * 86400000), listedAt: at(-5000),
    suspectSince: null, listedCount: models.filter(m => m.state === 'listed').length,
    knownCount: models.length, models, changes: [] });
  const openaiPrices = [
    // 같은 모델의 네 가지 과금 조건. 임계값·등급·배수가 각각 다르므로 한 줄로 합칠 수 없다.
    priceRow('gpt-6-astra', { sources: ['ocx-config', 'observed'], requests: 120, status: 'official',
      pricedModel: 'gpt-6-astra', rates: rates(10, 50, 1, 12.5), sourceUrl: OAI_SOURCE,
      checkedAt: '2026-09-10', conditions: ['long-context', 'service-tier-priority', 'service-tier-discount'],
      priceConditions: [
        condition('default', { rates: rates(10, 50, 1, 12.5), sourceUrl: OAI_SOURCE, checkedAt: '2026-09-10',
          conditions: ['long-context', 'service-tier-priority', 'service-tier-discount'] }),
        condition('long-context', { inputTokensFrom: 272001, rates: rates(20, 75, 2, 25),
          sourceUrl: OAI_SOURCE, checkedAt: '2026-09-10',
          conditions: ['long-context', 'service-tier-priority', 'service-tier-discount'] }),
        condition('service-tier-priority', { serviceTier: 'priority', tierMultiplier: 2,
          rates: rates(10, 50, 1, 12.5), sourceUrl: OAI_SOURCE, checkedAt: '2026-09-10',
          conditions: ['long-context', 'service-tier-priority', 'service-tier-discount'] }),
        condition('service-tier-discount', { serviceTier: 'flex', tierMultiplier: 0.5,
          rates: rates(10, 50, 1, 12.5), sourceUrl: OAI_SOURCE, checkedAt: '2026-09-10',
          conditions: ['long-context', 'service-tier-priority', 'service-tier-discount'] }),
      ] }),
    // 캐시 쓰기 단가가 없는 모델. 긴 입력 조건은 존재하지만 그 조건의 단가가 미확인이다.
    // 환산에서 빠진 호출도 함께 가진다: 현재 단가가 확인돼도 이미 제외된 호출은 설명되지 않는다.
    priceRow('gpt-5.4-mini', { requests: 40, unpricedRequests: 6, status: 'official', pricedModel: 'gpt-5.4-mini',
      rates: rates(0.75, 4.5, 0.075, null), sourceUrl: OAI_SOURCE, checkedAt: '2026-09-10',
      conditions: ['service-tier-discount'],
      priceConditions: [
        condition('default', { rates: rates(0.75, 4.5, 0.075, null), sourceUrl: OAI_SOURCE,
          checkedAt: '2026-09-10', conditions: ['service-tier-discount'] }),
        condition('long-context', { inputTokensFrom: 272001, status: 'unpriced', tierMultiplier: null,
          reason: '긴 입력 단가 미확인' }),
        condition('service-tier-discount', { serviceTier: 'flex', tierMultiplier: 0.5,
          rates: rates(0.75, 4.5, 0.075, null), sourceUrl: OAI_SOURCE, checkedAt: '2026-09-10',
          conditions: ['service-tier-discount'] }),
      ] }),
    // 호출은 있는데 금액을 끝내 못 구한 모델. 목록에서 사라지지도, 0원이 되지도 않는다.
    priceRow('mystery-model', { sources: ['observed'], requests: 12, unpricedRequests: 12,
      reason: '모델 단가 미확인',
      priceConditions: [condition('default', { status: 'unpriced', tierMultiplier: null,
        reason: '모델 단가 미확인' })] }),
    // 네 단가가 모두 있어서 기존 확인 상태로는 '확인됨' 인데, 출처도 확인일도 조건도 없다.
    // 부족 판정을 기존 partial/unpriced 필터로 대신할 수 없다는 사실이 이 행 하나에 들어 있다.
    priceRow('gpt-6-nova-preview', { sources: ['ocx-config', 'observed'], requests: 8,
      status: 'local-catalog', pricedModel: 'gpt-6-nova-preview', rates: rates(1.5, 6, 0.15, 1.875),
      priceConditions: [condition('default', { status: 'local-catalog',
        rates: rates(1.5, 6, 0.15, 1.875) })] }),
  ];
  const anthropicPrices = [
    priceRow('claude-opus-5', { sources: ['ocx-config', 'observed'], requests: 90, status: 'official',
      pricedModel: 'claude-opus-5', rates: rates(5, 25, 0.5, 6.25), sourceUrl: CLAUDE_SOURCE,
      checkedAt: '2026-09-15', conditions: ['cache-write-assumed'],
      priceConditions: [
        condition('default', { rates: rates(5, 25, 0.5, 6.25), sourceUrl: CLAUDE_SOURCE,
          checkedAt: '2026-09-15', conditions: ['cache-write-assumed'] }),
        condition('cache-write-1h-assumed', { claudeCacheTtl: '1h', rates: rates(5, 25, 0.5, 10),
          sourceUrl: CLAUDE_SOURCE, checkedAt: '2026-09-15', conditions: ['cache-write-1h-assumed'] }),
      ] }),
    // 목록에서 빠진 모델. 현재 단가는 없고 과거 호출에 적용된 단가만 남아 있다.
    priceRow('claude-legacy-3', { sources: ['observed'], requests: 24, unpricedRequests: 24,
      reason: '모델 단가 미확인',
      priceConditions: [condition('default', { status: 'unpriced', tierMultiplier: null,
        reason: '모델 단가 미확인' })] }),
  ];
  const cursorPrices = [
    // 캐시 쓰기 단가가 0인 모델. 측정된 무료이지 미확인이 아니다.
    priceRow('grok-4.6', { sources: ['ocx-config', 'observed'], requests: 60, status: 'official',
      pricedModel: 'grok-4.6', rates: rates(2, 6, 0.5, 0), sourceUrl: XAI_SOURCE, checkedAt: '2026-09-10',
      conditions: ['long-context', 'service-tier-priority'],
      priceConditions: [
        condition('default', { rates: rates(2, 6, 0.5, 0), sourceUrl: XAI_SOURCE, checkedAt: '2026-09-10',
          conditions: ['long-context', 'service-tier-priority'] }),
        condition('long-context', { inputTokensFrom: 200000, rates: rates(4, 12, 1, 0),
          sourceUrl: XAI_SOURCE, checkedAt: '2026-09-10', conditions: ['long-context'] }),
        condition('service-tier-priority', { serviceTier: 'priority', tierMultiplier: 2,
          rates: rates(2, 6, 0.5, 0), sourceUrl: XAI_SOURCE, checkedAt: '2026-09-10',
          conditions: ['long-context', 'service-tier-priority'] }),
        // 두 조건을 함께 요청하면 가격이 없다. 각각만 보여 주면 둘을 곱해도 되는 것처럼 읽힌다.
        condition('long-context+service-tier-priority', { inputTokensFrom: 200000,
          serviceTier: 'priority', status: 'unpriced', tierMultiplier: null,
          reason: '긴 입력과 우선 처리 결합 단가 미확인' }),
      ] }),
    priceRow('composer-2.5-fast', { requests: 18, status: 'official', pricedModel: 'composer-2.5-fast',
      rates: rates(3, 15, 0.5, null), sourceUrl: COMPOSER_SOURCE, checkedAt: '2026-09-10',
      // 같은 조건에서 두 자료의 단가가 다르다. 한 번 해결됐다가 다시 나타난 사유이기도 하다.
      conflict: { status: 'local-catalog', rates: rates(2.5, 12, 0.4, null),
        reason: '로컬 카탈로그가 다른 단가를 싣고 있습니다.' },
      priceConditions: [condition('default', { rates: rates(3, 15, 0.5, null),
        sourceUrl: COMPOSER_SOURCE, checkedAt: '2026-09-10' })] }),
  ];
  const ollamaPrices = [
    // 요청한 이름과 단가가 선택된 이름이 다른 별칭. 이 연결이 보이지 않으면 목록에서 끊긴다.
    priceRow('gpt-oss:120b-cloud', { sources: ['ocx-config', 'observed'], requests: 30, status: 'official',
      pricedModel: 'gpt-oss:120b', tokens: 86250, cachedTokens: 30000, rates: rates(0.15, 0.6, 0.014, null),
      sourceUrl: OLLAMA_SOURCE, checkedAt: '2026-09-10', unsupported: ['cache-write'],
      priceConditions: [condition('default', { rates: rates(0.15, 0.6, 0.014, null),
        sourceUrl: OLLAMA_SOURCE, checkedAt: '2026-09-10', unsupported: ['cache-write'] })] }),
    // 시각에 따라 단가가 달라지는 모델. 기본 조건과 피크 조건이 따로 읽혀야 한다.
    priceRow('deepseek-v4-flash', { requests: 15, status: 'official', pricedModel: 'deepseek-v4-flash',
      rates: rates(0.22, 0.66, 0.007, null), sourceUrl: OLLAMA_SOURCE, checkedAt: '2026-09-10',
      conditions: ['peak-hours'], unsupported: ['cache-write'],
      priceConditions: [
        condition('default', { peak: false, rates: rates(0.22, 0.66, 0.007, null),
          sourceUrl: OLLAMA_SOURCE, checkedAt: '2026-09-10', conditions: ['peak-hours'],
          unsupported: ['cache-write'] }),
        condition('peak-hours', { peak: true, rates: rates(0.44, 1.32, 0.014, null),
          sourceUrl: OLLAMA_SOURCE, checkedAt: '2026-09-10', conditions: ['peak-hours'],
          unsupported: ['cache-write'] }),
      ] }),
  ];
  // 두 시기의 단가가 보존되어 있고, 오래된 쪽은 우선 처리 배수까지 함께 청구되었다. 하나로
  // 접거나 배수를 빼면 화면이 실제로 청구된 것보다 적게 말한다.
  const legacyEvidence = [{ model: 'claude-legacy-3',
    evidence: { status: 'official', pricingProvider: 'anthropic', pricedModel: 'claude-legacy-3',
      rates: rates(3, 15, 0.3, 3.75), tierMultiplier: 1, sourceUrl: CLAUDE_SOURCE,
      checkedAt: '2026-05-02', effectiveFrom: null, effectiveTo: at(-8 * 86400000),
      conditions: ['cache-write-assumed'], unsupported: [], conflict: null, reason: null,
      firstRevision: 'fixture-revision' },
    requests: 24, storedApiUsd: 6.4, firstAt: at(-40 * 86400000), lastAt: at(-9 * 86400000),
    firstPricedAt: at(-40 * 86400000), lastPricedAt: at(-9 * 86400000) },
   { model: 'claude-legacy-3',
    evidence: { status: 'official', pricingProvider: 'anthropic', pricedModel: 'claude-legacy-3',
      rates: rates(2.5, 12, 0.25, 3.125), tierMultiplier: 2, sourceUrl: CLAUDE_SOURCE,
      checkedAt: '2026-02-11', effectiveFrom: null, effectiveTo: at(-41 * 86400000),
      conditions: ['cache-write-assumed', 'service-tier-priority'], unsupported: [], conflict: null,
      reason: null, firstRevision: 'fixture-revision-older' },
    requests: 8, storedApiUsd: 3.2, firstAt: at(-70 * 86400000), lastAt: at(-41 * 86400000),
    firstPricedAt: at(-70 * 86400000), lastPricedAt: at(-41 * 86400000) }];
  // --- JUN-50: 가격 확인 필요 판정 ---
  // 사유는 서버와 같은 함수로 뽑는다. 손으로 적으면 화면이 실제 판정과 다른 세계를 검사하게 된다.
  // 모델마다 다른 배수를 주어, 어느 모델의 어느 기간을 읽었는지 검사가 구별할 수 있게 한다.
  // 한 제공자의 부족 모델 호출 합이 그 제공자 전체 호출을 넘지 않아야 하므로 배수 합을 그 아래에
  // 둔다. 그리고 한 모델의 기간 값은 그 모델이 보관 중인 전체보다 클 수 없으므로, 아래에서 가격
  // 행의 requests·unpricedRequests 를 30일 값으로 맞춘다 -- 기간이 부분집합이라는 사실은 화면이
  // 아니라 자료가 지켜야 한다.
  const GAP_USAGE = { 'gpt-6-nova-preview': { scale: 1, unpriced: 0 },
    'gpt-5.4-mini': { scale: 2, unpriced: 0.25 }, 'mystery-model': { scale: 1, unpriced: 1 },
    'claude-legacy-3': { scale: 2, unpriced: 1 }, 'composer-2.5-fast': { scale: 1, unpriced: 0.25 } };
  const gapBucket = (model, index) => {
    const { scale, unpriced } = GAP_USAGE[model] ?? { scale: 1, unpriced: 0 };
    const requests = v.requests[index] * scale;
    return { requests, unpricedRequests: Math.floor(requests * unpriced) };
  };
  const gapPeriods = model => build((key, hours, index) => {
    const { requests, unpricedRequests } = gapBucket(model, index);
    return { requests, tokens: requests * 2875, unpricedRequests,
      unpricedTokens: unpricedRequests * 2875, unpricedUnsizedRequests: 0,
      startedAt: fromT(-hours * HOUR), endedAt: fromT(0), hours };
  });
  // 보관 전체는 가장 긴 기간의 값과 같게 둔다. 서버에서도 보관 기록 전부가 30일 안에 있으면
  // 그렇게 나오고, 부분집합이 전체보다 커지는 일은 어느 쪽으로도 생기지 않는다.
  const MONTHLY = PERIODS.length - 1;
  for (const prices of [openaiPrices, anthropicPrices, cursorPrices, ollamaPrices]) {
    for (const row of prices) {
      if (!GAP_USAGE[row.model]) continue;
      const { requests, unpricedRequests } = gapBucket(row.model, MONTHLY);
      row.requests = requests;
      row.unpricedRequests = unpricedRequests;
      row.tokens = requests * 2875;
    }
  }
  const EMPTY_BUCKET = { requests: 0, tokens: 0, unpricedRequests: 0, unpricedTokens: 0,
    unpricedUnsizedRequests: 0 };
  // The dashboard does not read price-gap findings; an empty ok block keeps the shape.
  const priceGapsFor = (..._ignored: unknown[]) => ({ status: 'ok', modelsNeedingPriceCheck: 0, models: [], carriedModels: [],
    resolved: [], changes: [], confirmedNewModels: [], retiredModels: [], periods: {} });
  const priceFacts = (id: string, models: any[], evidence: any[] = []) => {
    const rosterModels = models.map(row => rosterModel(row.model,
      row.model === 'claude-legacy-3' ? 'removed' : row.sources.includes('ocx-config') ? 'listed' : 'observed-only'));
    return { modelPrices: models, priceEvidence: evidence, modelRoster: roster(rosterModels),
      priceGaps: priceGapsFor(id, models, rosterModels) };
  };
  const providers = [
    provider('openai', 'OpenAI', true, 'gpt-5', [a1, a2, a3], part(1), part(1),
      priceFacts('openai', openaiPrices)),
    provider('anthropic', 'Anthropic', true, null, [b1], part(1), part(1),
      priceFacts('anthropic', anthropicPrices, legacyEvidence)),
    provider('cursor', 'Cursor', true, null, [c1], part(1), part(1, 'unknown'),
      { cacheAssumption: { appliedRate: 0.62, stale: false, updatedAt: now,
        from: now - 30 * 86400000, through: now, invalidLines: 0 }, ...priceFacts('cursor', cursorPrices) }),
    provider('ollama-cloud', 'Ollama Cloud', false, null, [d1], EMPTY, EMPTY,
      priceFacts('ollama-cloud', ollamaPrices)),
  ];

  if (!v.legacy) for (const p of providers) {
    for (const a of p.accounts) for (const w of a.windows) {
      const data = w.analytics;
      data.consumptionPeriods = Object.fromEntries(Object.entries(p.analytics.periods as Record<string, any>).map(([key, stats]) => {
        const span = Math.min(stats.hours, data.forecastSpanHours);
        const observed = span * (data.forecastCoverage ?? 0);
        return [key, {deltaPp:Number.isFinite(data.forecastDeltaPp) ? data.forecastRatePpHour * observed : null,
          spanHours:span, observedHours:observed, coverage:observed / stats.hours,
          observedAt:data.forecastObservedAt, periodEndedAt:new Date(now).toISOString(),
          recoveredDeltaPp:0, recoveredHours:0}];
      }));
    }
  }

  if (!v.legacy) for (const p of providers) p.analytics.quotaRecommendations = Object.fromEntries(
    Object.entries(p.analytics.periods as Record<string, any>).map(([key, stats]) => [key, quotaNeed(p, key, stats.hours)]));

  // Every variant emits the same top-level keys so an in-place swap cannot leave a
  // previous variant's value standing where the next one has nothing to say.
  return { schemaVersion: 1, observedAt: at(0), source: 'ui-check-fixture:' + variantName,
    refreshIntervalSeconds: 10,
    warnings: ['일부 프로바이더의 자동 조회에 실패했습니다. 마지막 측정값을 표시합니다.'],
    providers,
    analytics: { subscriptionMonthlyUsd: providers.reduce((total, p) => total + p.analytics.subscriptionMonthlyUsd, 0),
      status: v.error ? 'error' : 'ok',
      sampleIntervalSeconds: 10, lastCollectedAt: at(-5000), historyStartedAt: at(-20 * 86400000),
      usageSince: v.since === null ? null : fromT(v.since), usageThrough: fromT(0), invalidUsageLines: 0,
      usageObservedAt: fromT(0), usageStale: Boolean(v.stale), usageObservedSince: fromT(v.obsSince),
      usageObservedThrough: v.obsThrough === null ? null : fromT(v.obsThrough),
      pricingCatalog: { status: 'ok', modelCount: 6490, updatedAt: at(-1800000), basis: 'local-catalog' },
      modelRoster: { status: 'ok', lastAttemptAt: at(-5000), lastSuccessAt: at(-5000),
        failureSince: null, absentProviders: [] },
      // 정상 상태. 이 값이 ok 이고 건수가 0 인 제공자에는 화면에 아무 경고도 남지 않아야 한다.
      priceGaps: { status: 'ok', lastAttemptAt: at(-5000), lastSuccessAt: at(-5000),
        failureSince: null, catalogStatus: 'ok', modelListStatus: 'ok',
        resolutionBlocked: false, unreportedProviders: [] },
      sources: [{ label: 'OpenAI 가격', url: 'https://openai.com/api/pricing/', checkedAt: at(-86400000) }],
      notes: [
        ...(v.error ? ['수집에 실패했습니다. 기존 기록을 표시합니다. 다음 수집 때 재시도합니다.'] : []),
        ...(v.stale ? ['사용액과 사용 속도는 마지막으로 사용 기록을 읽은 시점 기준입니다. 수집 중단 시간을 유휴 사용으로 계산하지 않습니다.'] : []),
        'API 환산액은 청구액이 아닙니다.',
      ] } };
}
