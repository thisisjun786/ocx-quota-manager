import test from 'node:test';
import assert from 'node:assert/strict';
import { observationOf, segmentObservations, observedChanges, consumptionOf, coverageOf,
  describePrecision, sameReading, shouldStore } from '../src/quota-observations.mjs';
import { projectMeasurement, publishedPercent } from '../src/quota-measurement.mjs';

const NOW = 1800000000000, MIN = 60000, HOUR = 3600000, MAX_GAP = 20 * MIN;
const RESET = NOW + 10 * HOUR;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9,
  label + ': expected ' + expected + ', got ' + actual);

// A reading as a provider adapter hands it over, projected the way direct collection projects it,
// so the rows below are the rows history actually stores.
const reading = (at, over = {}) => {
  const raw = { source: 'openai/wham-usage', sourceVersion: 'v1', scopeKey: 'all', cycleKey: 'c1',
    windowSemantics: 'fixed_reset', unit: 'credits', used: 123.4, limit: 1000,
    precisionEvidence: 'observed_fraction', ...over };
  const measurement = projectMeasurement(raw, { fetchedAt: at });
  const percent = publishedPercent(measurement);
  return observationOf({ usedPercent: Math.min(100, percent),
    resetAt: new Date(over.reset ?? RESET).toISOString(), measurement },
    { at, epoch: over.epoch ?? 1 });
};
const segmentsOf = rows => segmentObservations(rows, { maxGapMs: MAX_GAP });
const reasons = rows => segmentsOf(rows).map(s => s.reason);

test('a decimal movement survives storage and arithmetic without being rounded away', () => {
  const rows = [reading(NOW - MIN, { used: 123.4 }), reading(NOW, { used: 125.6 })];
  near(rows[0].observedPercent, 12.34, 'first');
  near(rows[1].observedPercent, 12.56, 'second');
  const moved = observedChanges(segmentsOf(rows));
  assert.equal(moved.observations, 2);
  near(moved.changes[0].deltaPp, 0.22, 'delta');
  near(moved.netChangePp, 0.22, 'net');
  assert.equal(moved.monotonic, true);
});

test('a run breaks where a difference between two readings would stop meaning anything', () => {
  const base = at => reading(at, { used: 100 });
  assert.deepEqual(reasons([base(NOW - 2 * MIN), base(NOW - MIN)]), ['first']);
  assert.deepEqual(reasons([base(NOW - 2 * MIN), reading(NOW - MIN, { used: 90, limit: 900 })]),
    ['first', 'basis'], 'denominator changed');
  assert.deepEqual(reasons([base(NOW - 2 * MIN), reading(NOW - MIN, { scopeKey: 'fable' })]),
    ['first', 'basis'], 'scope changed');
  assert.deepEqual(reasons([base(NOW - 2 * MIN), reading(NOW - MIN, { reset: RESET + HOUR })]),
    ['first', 'cycle'], 'cycle moved');
  assert.deepEqual(reasons([base(NOW), base(NOW - MIN)]), ['first', 'time_reversed']);
  assert.deepEqual(reasons([base(NOW - HOUR), base(NOW)]), ['first', 'gap']);
  assert.deepEqual(reasons([base(NOW - 2 * MIN), reading(NOW - MIN, { epoch: 2 })]),
    ['first', 'basis'], 'the account behind the id was replaced');
});

// Every shipped adapter derives its cycle key from the exact reset timestamp, so a provider
// nudging that timestamp inside the drift tolerance used to mint a new basis on every poll:
// the run split before the cycle comparison could apply, and idle dedup never fired.
const drifted = (at, reset, over = {}) => reading(at, { used: 100, reset,
  cycleKey: new Date(reset).toISOString(), ...over });

test('a tolerated reset wobble is one continuous run, not a new basis', () => {
  assert.deepEqual(reasons([drifted(NOW - 2 * MIN, RESET), drifted(NOW - MIN, RESET + 30 * 1000)]),
    ['first'], '30-second wobble stays in the run');
  assert.deepEqual(reasons([drifted(NOW - 2 * MIN, RESET), drifted(NOW - MIN, RESET + 90 * 1000)]),
    ['first', 'cycle'], 'past the tolerance the reset really moved');
  assert.deepEqual(reasons([drifted(NOW - 2 * MIN, RESET), drifted(NOW - MIN, RESET + HOUR)]),
    ['first', 'cycle'], 'a genuine new cycle still separates');
});

test('a cycle key that is not a restatement of the reset still breaks the basis', () => {
  assert.deepEqual(reasons([reading(NOW - 2 * MIN, { used: 100, cycleKey: 'c1' }),
    reading(NOW - MIN, { used: 100, cycleKey: 'c2' })]), ['first', 'basis'], 'opaque key changed');
  const disagrees = (at, key) => reading(at, { used: 100, cycleKey: key });
  assert.deepEqual(reasons([disagrees(NOW - 2 * MIN, new Date(RESET + 90 * 1000).toISOString()),
    disagrees(NOW - MIN, new Date(RESET + 120 * 1000).toISOString())]),
    ['first', 'basis'], 'a key that disagrees with its own reset stays literal evidence');
});

test('a tolerated wobble dedupes as one reading while a real increment still writes', () => {
  const first = drifted(NOW - 2 * MIN, RESET);
  const wobble = drifted(NOW - MIN, RESET + 30 * 1000);
  assert.equal(sameReading(first, wobble), true);
  assert.equal(shouldStore(first, wobble, { idleMs: 4 * MIN }), false,
    'the wobble repeat is idle and not stored');
  const moved = drifted(NOW - MIN, RESET + 30 * 1000, { used: 102.2 });
  assert.equal(sameReading(first, moved), false);
  assert.equal(shouldStore(first, moved, { idleMs: 4 * MIN }), true,
    'a precision increment is not idle dedup and is not the forecast dip correction');
});

test('a value that falls and comes back is not counted as new use', () => {
  const rows = [reading(NOW - 2 * MIN, { used: 123.4 }), reading(NOW - MIN, { used: 121.0 }),
    reading(NOW, { used: 123.4 })];
  const moved = observedChanges(segmentsOf(rows));
  near(moved.increasePp, 0.24, 'increase');
  near(moved.decreasePp, -0.24, 'decrease');
  near(moved.netChangePp, 0, 'net');
  assert.equal(moved.monotonic, false);
  assert.equal(moved.unresolvedDecreases, 1);
  assert.deepEqual(moved.changes.map(c => Number(c.deltaPp.toFixed(2))), [-0.24, 0.24]);
  const total = consumptionOf(segmentsOf(rows));
  assert.equal(total.totalUsedPp, null);
  assert.equal(total.usedDelta, null);
});

test('a fall hidden between two clean runs is still a fall', () => {
  const c = over => ({ usedAccumulation: 'cumulative', ...over });
  const rows = [
    reading(NOW - 5 * HOUR, c({ used: 123.4 })),
    reading(NOW - 5 * HOUR + MIN, c({ used: 125.6 })),
    reading(NOW - MIN, c({ used: 121.0 })),
    reading(NOW, c({ used: 125.6 })),
  ];
  const segments = segmentsOf(rows);
  assert.deepEqual(segments.map(s => s.reason), ['first', 'gap']);
  assert.equal(observedChanges(segments).monotonic, false,
    'run-local monotonicity alone would have published 0.22 + 0.46 = 0.68pp');
  assert.equal(consumptionOf(segments).totalUsedPp, null);
});

test('consumption is offered only where a subtraction actually means something', () => {
  const run = over => segmentsOf([reading(NOW - MIN, { used: 123.4, ...over }),
    reading(NOW, { used: 125.6, ...over })]);
  const undeclared = consumptionOf(run({}));
  assert.equal(undeclared.usedDelta, null);
  assert.equal(undeclared.totalUsedPp, null);
  const sliding = consumptionOf(run({ usedAccumulation: 'cumulative', windowSemantics: 'sliding' }));
  assert.equal(sliding.usedDelta, null);
  assert.equal(sliding.totalUsedPp, null);
  const unknown = consumptionOf(run({ usedAccumulation: 'cumulative', windowSemantics: 'unknown' }));
  assert.equal(unknown.totalUsedPp, null);
  const verified = consumptionOf(run({ usedAccumulation: 'cumulative' }));
  assert.equal(verified.basis, 'verified_cumulative');
  near(verified.usedDelta, 2.2, 'usedDelta');
  near(verified.totalUsedPp, 0.22, 'totalUsedPp');
  assert.equal(verified.unit, 'credits');
});

test('a quantity with no recorded unit is not published as a quantity', () => {
  const rows = [reading(NOW - MIN, { used: 123.4, usedAccumulation: 'cumulative', unit: undefined }),
    reading(NOW, { used: 125.6, usedAccumulation: 'cumulative', unit: undefined })];
  const total = consumptionOf(segmentsOf(rows));
  assert.equal(total.unit, null);
  assert.equal(total.usedDelta, null);
  near(total.totalUsedPp, 0.22, 'percentage points need no unit');
});

test('a percentage without a used quantity cannot become one', () => {
  const bare = (at, percent) => reading(at, { method: 'reported_percent', percent,
    used: undefined, limit: undefined, usedAccumulation: 'cumulative' });
  const rows = [bare(NOW - MIN, 12.34), bare(NOW, 12.56)];
  near(rows[1].observedPercent, 12.56, 'the percentage is still real');
  assert.equal(rows[1].used, null);
  assert.equal(consumptionOf(segmentsOf(rows)).usedDelta, null);
});

test('watched time counts a forward gap once, and never counts backwards', () => {
  const rows = [reading(NOW - 3 * MIN), reading(NOW - 2 * MIN), reading(NOW - MIN)];
  const forward = coverageOf(rows, { from: NOW - 4 * MIN, to: NOW, maxGapMs: MAX_GAP });
  near(forward.observedHours, 2 * MIN / HOUR, 'two one-minute gaps');
  near(forward.spanHours, 4 * MIN / HOUR, 'span');
  const doubled = coverageOf([reading(NOW - 3 * MIN), reading(NOW - MIN),
    reading(NOW - 3 * MIN), reading(NOW - MIN)],
    { from: NOW - 4 * MIN, to: NOW, maxGapMs: MAX_GAP });
  near(doubled.observedHours, 2 * MIN / HOUR, 'overlapping spans are merged, not added');
  assert.ok(doubled.ratio <= 1);
});

test('the raw record keeps what the provider said and never repairs a disagreement', () => {
  const project = over => projectMeasurement({ source: 's', sourceVersion: 'v', scopeKey: 'all',
    ...over }, { fetchedAt: NOW });
  const mismatch = project({ percent: 2.53, used: 19.6125, limit: 100 });
  assert.equal(mismatch.reconciliation, 'mismatch');
  near(publishedPercent(mismatch), 2.53, 'the provider figure stands');
  near(mismatch.calculatedPercent, 19.6125, 'the computed one stays visible beside it');
  assert.equal(project({ used: 5, limit: 0 }).limitState, 'zero');
  assert.equal(project({ used: 5, limit: 0 }).calculatedPercent, null);
  assert.equal(project({ used: 5 }).limitState, 'missing');
  assert.equal(project({ used: 5, limit: Number.NaN }).limitState, 'missing');
  assert.equal(project({ used: 5, limit: -1 }).limitState, 'missing');
  assert.equal(project({ used: 5, limit: 100, unlimited: true }).limitState, 'unlimited');
  assert.equal(project({ used: -1, limit: 100 }).used, null);
  const over = project({ used: 1375, limit: 1000 });
  near(over.calculatedPercent, 137.5, 'unclamped');
  const row = observationOf({ usedPercent: 100, resetAt: new Date(RESET).toISOString(),
    measurement: over }, { at: NOW, epoch: 1 });
  near(row.observedPercent, 137.5, 'the stored record is not the capped display value');
});

test('every period is computed from the readings inside it and says how much it watched', () => {
  const rows = [];
  for (let i = 12; i >= 0; i--) rows.push(reading(NOW - i * 5 * MIN, { used: 100 + i }));
  const described = describePrecision(rows, { now: NOW, from: NOW - 24 * HOUR,
    periods: [['oneHour', HOUR], ['twentyFourHour', 24 * HOUR]], maxGapMs: MAX_GAP });
  assert.equal(described.basis, 'observed');
  assert.equal(described.changes.observations, 13);
  assert.equal(described.periods.oneHour.observations, 12, 'the hour holds twelve readings');
  assert.equal(described.periods.twentyFourHour.observations, 13);
  near(described.periods.oneHour.coverage.ratio, 55 * MIN / HOUR, 'hour coverage');
  assert.ok(described.periods.twentyFourHour.coverage.ratio < 0.05,
    'a day that was almost entirely unobserved says so');
  assert.equal(described.coverage.horizonHours, 24);
});

test('the transported lists are capped while the counts they summarise are not', () => {
  const rows = [];
  for (let i = 60; i >= 0; i--) rows.push(reading(NOW - i * HOUR, { used: 100 + i }));
  const described = describePrecision(rows, { now: NOW, from: NOW - 61 * HOUR,
    periods: [], maxGapMs: MAX_GAP, limit: 20 });
  assert.equal(described.changes.observations, 61);
  assert.equal(described.breakCount, 60, 'every hour-long gap is a break');
  assert.equal(described.breaks.length, 20, 'and only the last twenty travel');
  assert.ok(described.changes.recent.length <= 20);
});

test('narrowing to a period cannot delete the discontinuity that separates two runs', () => {
  // Arrival order, not clock order: the middle reading came back with an earlier instant, and it
  // sits just outside the hour. Narrowing first would carry the break out of the period with it
  // and leave the two survivors reading as one clean rise.
  const rows = [reading(NOW - 55 * MIN, { used: 100 }), reading(NOW - 65 * MIN, { used: 120 }),
    reading(NOW - 50 * MIN, { used: 130 })];
  assert.deepEqual(segmentsOf(rows).map(s => s.reason), ['first', 'time_reversed']);
  const described = describePrecision(rows, { now: NOW, from: NOW - 24 * HOUR,
    periods: [['oneHour', HOUR]], maxGapMs: MAX_GAP });
  const hour = described.periods.oneHour;
  assert.equal(hour.observations, 2, 'the reading outside the hour is excluded');
  assert.equal(hour.segments, 2, 'but the break it caused is not');
  near(hour.netChangePp, 0, 'the two survivors are not one +3pp run');
});

test('a falling reported percentage withholds consumption even while the quantity rises', () => {
  // The provider says the share went down; its own used counter went up. One of them is wrong and
  // we cannot tell which, so no total is stated.
  const contradictory = (at, percent, used) => reading(at, { percent, used,
    usedAccumulation: 'cumulative' });
  const rows = [contradictory(NOW - MIN, 12.34, 123.4), contradictory(NOW, 12.10, 125.6)];
  assert.equal(rows[1].reconciliation, 'mismatch');
  near(rows[1].observedPercent, 12.10, 'the reported figure is the one published');
  const total = consumptionOf(segmentsOf(rows));
  assert.equal(total.totalUsedPp, null, 'a negative total must never carry a verified label');
  assert.equal(total.usedDelta, null);
  assert.equal(total.basis, null);
  // The signed movement is still kept.
  const moved = observedChanges(segmentsOf(rows));
  near(moved.decreasePp, -0.24, 'decrease');
  assert.equal(moved.monotonic, false);
});

test('a declared cumulative window still refuses a total after a rebound', () => {
  const c = (at, used) => reading(at, { used, usedAccumulation: 'cumulative' });
  const rows = [c(NOW - 2 * MIN, 123.4), c(NOW - MIN, 121.0), c(NOW, 123.4)];
  const total = consumptionOf(segmentsOf(rows));
  assert.equal(total.basis, null, 'the declaration is not enough once the numbers contradict it');
  assert.equal(total.totalUsedPp, null);
  assert.equal(total.usedDelta, null);
});
