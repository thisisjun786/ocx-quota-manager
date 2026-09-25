import test from 'node:test';
import assert from 'node:assert/strict';
import { windowAnalytics } from '../src/analytics.mjs';

// Regression: a single downward blip in usedPercent (a provider-side correction,
// not a reset) must not split the contiguous observation run. The quota window
// reconciles on net change over the observed span; raw history keeps the dip.
//
// Fixture seam verified against src/analytics.mjs:
//   points -> store.points(provider.id, account.id, window.id, since)
//   store.get('usageReadAt') -> NOW, so usageThrough = NOW and no run is incomplete
//   store.stats -> $10/hour of priced API usage for any account-scoped interval,
//     zero requests for the unattributed (account === null) probe.

const NOW = 1800000000000;
const HOUR = 3600000;
const TEN_MIN = 600000;
const RESET = NOW + 10 * HOUR;

const provider = { id: 'openai' };
const account = { id: 'a', status: 'ok' };

const EPS = 1e-6;
const approx = (actual, expected, label) =>
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < EPS,
    label + ': expected ' + expected + ', got ' + actual);

function analyze(usedSeries) {
  const points = usedSeries.map((used, i) => ({
    at: NOW - (usedSeries.length - 1 - i) * TEN_MIN,
    reset: RESET,
    used,
  }));
  return analyzePoints(points, usedSeries.at(-1), 'openai');
}

function analyzePoints(points, lastRaw, providerId) {
  const window = {
    id: 'weekly', label: '주간',
    usedPercent: lastRaw, remainingPercent: 100 - lastRaw,
    resetAt: new Date(RESET).toISOString(), stale: false,
  };
  const store = {
    points: () => points,
    get: () => NOW,
    stats: (p, a, from, to) => a === null
      ? { requests: 0 }
      : { requests: 30, pricedRequests: 30, unknownPriceRequests: 0,
          localPriceRequests: 0, apiUsd: (to - from) / HOUR * 10 },
  };
  return windowAnalytics(store, { id: providerId }, account, window, NOW);
}

test('a mid-run dip reconciles to the same capacity and forecast as a flat run', () => {
  // 20 -> 22 -> 21 -> 22 over 30 min: net +2pp over 0.5h observed.
  // Capacity: $5 of priced usage / 2pp * 100 = $250 for the full limit.
  // Forecast: 2pp / 0.5h = 4 pp/h, identical to a run that never dipped.
  const dipped = analyze([20, 22, 21, 22]);
  approx(dipped.capacityApiUsd, 250, 'dipped capacityApiUsd');
  approx(dipped.forecastRatePpHour, 4, 'dipped forecastRatePpHour');
  approx(dipped.forecastObservedHours, 0.5, 'dipped forecastObservedHours');

  const flat = analyze([20, 22, 22, 22]);
  approx(flat.capacityApiUsd, 250, 'flat capacityApiUsd');
  approx(flat.forecastRatePpHour, 4, 'flat forecastRatePpHour');
  approx(flat.forecastObservedHours, 0.5, 'flat forecastObservedHours');

  approx(dipped.capacityApiUsd, flat.capacityApiUsd, 'dip must not change capacity');
  approx(dipped.forecastRatePpHour, flat.forecastRatePpHour, 'dip must not change forecast rate');
});

test('a dip with small net change keeps conservative outputs and raw history', () => {
  // 20 -> 21 -> 20 -> 21 over 30 min: net +1pp over 0.5h observed.
  // Capacity: $5 / 1pp * 100 = $500.
  // Recent rate: net 1pp / 0.5h = 2 pp/h.
  // Forecast: net delta 1pp < MIN_FORECAST_DELTA (2) -> still collecting, null rate.
  const result = analyze([20, 21, 20, 21]);
  approx(result.capacityApiUsd, 500, 'capacityApiUsd');
  approx(result.recentRatePpHour, 2, 'recentRatePpHour');
  assert.equal(result.forecastRatePpHour, null,
    'forecastRatePpHour should stay null under MIN_FORECAST_DELTA, got ' + result.forecastRatePpHour);

  // Raw history is not smoothed: the dip stays visible in transported points.
  assert.deepEqual(result.history.map(p => p.usedPercent), [20, 21, 20, 21]);
});

test('a trailing dip still counts as fresh and contributes to the current rate', () => {
  // 20 -> 22 -> 21 ending NOW: raw latest (21) equals the provider reading, so
  // the run is fresh; normalized to 20 -> 22 -> 22 the recent rate is
  // 2pp over the observed 20 minutes = 6 pp/h.
  const result = analyze([20, 22, 21]);
  assert.notEqual(result.status, 'stale');
  approx(result.recentRatePpHour, 6, 'recentRatePpHour');
  assert.equal(result.quotaAdjustment.adjustedSamples, 1);
  assert.equal(result.quotaAdjustment.tolerancePp, 1);
});

test('repeated alternation inside tolerance adjusts each dipped sample once', () => {
  // 20 -> 21 -> 20 -> 21 -> 20 -> 21: two below-high samples are lifted,
  // leaving net +1pp over the observed 50 minutes = 1.2 pp/h.
  const result = analyze([20, 21, 20, 21, 20, 21]);
  assert.equal(result.quotaAdjustment.adjustedSamples, 2);
  approx(result.recentRatePpHour, 1.2, 'recentRatePpHour');
});

test('a drop beyond tolerance starts a new segment without the old high', () => {
  // 30 -> 29 -> 28 -> 29: 29 is lifted to 30 (1pp), but 28 is a 2pp drop and
  // opens a new segment anchored at itself, so only 28 -> 29 (+1pp, 10 min,
  // $1.6667) calibrates: 1.6667 / 1 * 100 = 166.67.
  const result = analyze([30, 29, 28, 29]);
  assert.equal(result.quotaAdjustment.adjustedSamples, 1);
  approx(result.capacityApiUsd, 500 / 3, 'capacityApiUsd');
});

test('reset change, long gap, and missing reset each split the run', () => {
  const at = i => NOW - (3 - i) * TEN_MIN;
  const mk = (used, i, reset) => ({ at: at(i), reset, used });

  // Reset moved: both cycles stay valid runs and each calibrates its own +1pp
  // over 10 minutes -> (1.6667 + 1.6667) / 2pp * 100 = 166.67.
  const resetSplit = analyzePoints(
    [mk(20, 0, RESET - HOUR), mk(21, 1, RESET - HOUR), mk(21, 2, RESET), mk(22, 3, RESET)], 22, 'openai');
  approx(resetSplit.capacityApiUsd, 500 / 3, 'reset-split capacityApiUsd');
  assert.equal(resetSplit.quotaAdjustment.adjustedSamples, 0);

  // A 40-minute gap exceeds MAX_GAP (20m): the pre-gap rise and the post-gap
  // rise each calibrate separately -> (1.6667 + 1.6667) / 3pp * 100 = 111.11.
  const gapPoints = [
    { at: NOW - 60 * 60000, reset: RESET, used: 20 },
    { at: NOW - 50 * 60000, reset: RESET, used: 22 },
    { at: NOW - 10 * 60000, reset: RESET, used: 22 },
    { at: NOW, reset: RESET, used: 23 },
  ];
  const gapped = analyzePoints(gapPoints, 23, 'openai');
  approx(gapped.capacityApiUsd, 1000 / 9, 'gap-split capacityApiUsd');
  approx(gapped.recentRatePpHour, 6, 'gap-split recentRatePpHour');

  // Missing reset on every sample: each point is its own segment, no run forms.
  const noReset = analyzePoints(
    [mk(20, 0, NaN), mk(21, 1, NaN), mk(21, 2, NaN), mk(22, 3, NaN)], 22, 'openai');
  assert.equal(noReset.capacityApiUsd, null);
  assert.equal(noReset.forecastRatePpHour, null);
});

test('the same dip pattern reconciles identically across supported providers', () => {
  for (const providerId of ['openai', 'anthropic', 'xai', 'cursor', 'opencode-go']) {
    const points = [20, 22, 21, 22].map((used, i) => ({ at: NOW - (3 - i) * TEN_MIN, reset: RESET, used }));
    const result = analyzePoints(points, 22, providerId);
    approx(result.capacityApiUsd, 250, providerId + ' capacityApiUsd');
    approx(result.forecastRatePpHour, 4, providerId + ' forecastRatePpHour');
  }
});

test('reset drift inside a segment cannot re-bridge the boundary downstream', () => {
  // Samples 10 min apart, resets drifting -60s / 0 / +60s around RESET, and the
  // provider snapshot reports the +60s reset. Normalization must segment
  // [22,21]->[22,22] | [23]; the singleton tail is the only current-cycle run,
  // so no current rate may be measured across the boundary.
  const points = [
    { at: NOW - 2 * TEN_MIN, reset: RESET - 60000, used: 22 },
    { at: NOW - TEN_MIN, reset: RESET, used: 21 },
    { at: NOW, reset: RESET + 60000, used: 23 },
  ];
  const window = {
    id: 'weekly', label: '주간', usedPercent: 23, remainingPercent: 77,
    resetAt: new Date(RESET + 60000).toISOString(), stale: false,
  };
  const store = {
    points: () => points,
    get: () => NOW,
    stats: (p, a, from, to) => a === null
      ? { requests: 0 }
      : { requests: 30, pricedRequests: 30, unknownPriceRequests: 0,
          localPriceRequests: 0, apiUsd: (to - from) / HOUR * 10 },
  };
  const result = windowAnalytics(store, provider, account, window, NOW);
  assert.equal(result.recentRatePpHour, null,
    'singleton current segment must not produce a recent rate, got ' + result.recentRatePpHour);
  assert.equal(result.averageRatePpHour, null,
    'singleton current segment must not produce an average rate, got ' + result.averageRatePpHour);
  assert.equal(result.observedHours, 0);
  assert.equal(result.capacityApiUsd, null);
});

test('distinct reset anchors near the window reset cannot merge into one run', () => {
  // Segments: [20 @ R] | [22 @ R+120s, 21->22 and 23 @ R+60s]. Both anchors sit
  // within 60s of the snapshot reset (R+60s), so reset comparison alone would
  // bridge them into one 20->23 run at 6 pp/h. Segment identity must keep them
  // apart: the current run is only the second segment, +1pp over 20min = 3 pp/h.
  const points = [
    { at: NOW - 3 * TEN_MIN, reset: RESET, used: 20 },
    { at: NOW - 2 * TEN_MIN, reset: RESET + 120000, used: 22 },
    { at: NOW - TEN_MIN, reset: RESET + 60000, used: 21 },
    { at: NOW, reset: RESET + 60000, used: 23 },
  ];
  const window = {
    id: 'weekly', label: '주간', usedPercent: 23, remainingPercent: 77,
    resetAt: new Date(RESET + 60000).toISOString(), stale: false,
  };
  const store = {
    points: () => points,
    get: () => NOW,
    stats: (p, a, from, to) => a === null
      ? { requests: 0 }
      : { requests: 30, pricedRequests: 30, unknownPriceRequests: 0,
          localPriceRequests: 0, apiUsd: (to - from) / HOUR * 10 },
  };
  const result = windowAnalytics(store, provider, account, window, NOW);
  approx(result.recentRatePpHour, 3, 'recentRatePpHour');
  approx(result.averageRatePpHour, 3, 'averageRatePpHour');
  approx(result.observedHours, 1 / 3, 'observedHours');
  assert.equal(result.quotaAdjustment.adjustedSamples, 1);
});
