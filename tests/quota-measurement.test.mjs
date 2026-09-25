import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMeasurement, publishedPercent, MISMATCH_TOLERANCE_PP } from '../src/quota-measurement.mjs';

const NOW = 1800000000000;
const base = { source: 'synthetic/usage', sourceVersion: 'synthetic-1', scopeKey: 'account:all' };
const project = raw => projectMeasurement({ ...base, ...raw }, { fetchedAt: NOW });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ~ ${expected}`);

test('a reported percentage and a computed one are both preserved with their own evidence', () => {
 // The same published figure, reached two different ways. Collapsing them would lose the
 // distinction between what the provider said and what we worked out.
 const reported = project({ percent: 12.34 });
 assert.equal(reported.method, 'reported_percent');
 assert.equal(reported.reportedPercent, 12.34);
 assert.equal(reported.calculatedPercent, null);
 assert.equal(reported.reconciliation, 'unverified');
 const computed = project({ used: 123.4, limit: 1000 });
 assert.equal(computed.method, 'used_limit');
 assert.equal(computed.reportedPercent, null);
 assert.equal(computed.calculatedPercent, 12.34);
 assert.equal(computed.reconciliation, 'unverified');
 // One observation apart: 12.34 to 12.56 is a 0.22 point move, not a token count.
 const later = project({ used: 125.6, limit: 1000 });
 near(later.calculatedPercent - computed.calculatedPercent, 0.22);
});

test('a matching pair reconciles and a disagreeing pair is preserved as a disagreement', () => {
 const matched = project({ percent: 12.34, used: 123.4, limit: 1000 });
 assert.equal(matched.reconciliation, 'matched');
 assert.equal(matched.method, 'used_limit');
 // The Cursor sample: 7845 of 40000 computes to 19.6125 while the provider reports 2.53,
 // because the pools are separate. The reported figure stays authoritative and the
 // mismatch is kept rather than smoothed away.
 const cursor = project({ percent: 2.53, used: 7845, limit: 40000 });
 assert.equal(cursor.reconciliation, 'mismatch');
 assert.equal(cursor.reportedPercent, 2.53);
 assert.equal(cursor.calculatedPercent, 19.6125);
 assert.equal(publishedPercent(cursor), 2.53);
 // A provider rounding its own number is not a disagreement: 12.3 against a computed 12.34
 // is 0.04 points apart, inside the tolerance.
 const rounded = project({ percent: 12.3, used: 123.4, limit: 1000 });
 assert.equal(rounded.reconciliation, 'matched');
 assert.ok(Math.abs(12.3 - rounded.calculatedPercent) <= MISMATCH_TOLERANCE_PP);
 // Just outside it is a disagreement, so the tolerance is doing real work rather than
 // absorbing everything.
 const outside = project({ percent: 12.2, used: 123.4, limit: 1000 });
 assert.equal(outside.reconciliation, 'mismatch');
 assert.ok(Math.abs(12.2 - outside.calculatedPercent) > MISMATCH_TOLERANCE_PP);
});

test('a denominator that cannot be divided is a named state, not a zero', () => {
 for (const [raw, state] of [[{ used: 10, limit: 0 }, 'zero'], [{ used: 10 }, 'missing'],
   [{ used: 10, limit: -5 }, 'missing'], [{ used: 10, unlimited: true, limit: 100 }, 'unlimited']]) {
  const value = project(raw);
  assert.equal(value.limitState, state, state);
  assert.equal(value.calculatedPercent, null, state);
  assert.equal(value.limit, null, state);
 }
 for (const used of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.equal(project({ used, limit: 1000 }).calculatedPercent, null, String(used));
 }
});

test('usage beyond the limit keeps its overage instead of being clamped here', () => {
 const over = project({ percent: 137.5, used: 1375, limit: 1000 });
 // The clamp belongs to the published bar, not to the evidence. Losing the overage here
 // would hide exactly the situation worth showing.
 assert.equal(over.reportedPercent, 137.5);
 assert.equal(over.calculatedPercent, 137.5);
 assert.equal(over.reconciliation, 'matched');
 assert.equal(publishedPercent(over), 137.5);
});

test('a fraction becomes a percentage only when it really is a fraction', () => {
 near(project({ fraction: 0.1234 }).reportedPercent, 12.34);
 assert.equal(project({ fraction: 0.1234 }).method, 'reported_fraction');
 for (const fraction of [1.5, -0.1, Number.NaN]) {
  assert.equal(project({ fraction }).reportedPercent, null, String(fraction));
 }
});

test('nothing outside the contract is carried across, and a bad method is refused', () => {
 const value = project({ percent: 12.34, accessToken: 'SENTINEL_MEASURE_TOKEN',
   rawBody: '{"accessToken":"SENTINEL_MEASURE_TOKEN"}', headers: { Authorization: 'Bearer x' } });
 assert.equal(JSON.stringify(value).includes('SENTINEL_MEASURE_TOKEN'), false);
assert.deepEqual(Object.keys(value).sort(), ['calculatedPercent', 'cycleKey', 'fetchedAt',
  'limit', 'limitState', 'method', 'observedAt', 'precisionEvidence', 'reconciliation',
  'reportedPercent', 'resolutionPp', 'scopeKey', 'source', 'sourceVersion', 'unit',
  'used', 'usedAccumulation', 'windowSemantics'].sort());
 // An unrecognised basis is refused rather than downgraded to a plausible one.
 assert.equal(projectMeasurement({ ...base, method: 'vibes', percent: 1 }, { fetchedAt: NOW }), null);
 for (const missing of ['source', 'sourceVersion', 'scopeKey']) {
  const raw = { ...base, percent: 1 }; delete raw[missing];
  assert.equal(projectMeasurement(raw, { fetchedAt: NOW }), null, missing);
 }
});

test('the provider observation time is never substituted by the time we asked', () => {
 const absent = project({ percent: 12.34 });
 assert.equal(absent.observedAt, null);
 assert.equal(absent.fetchedAt, new Date(NOW).toISOString());
 // Copying fetchedAt across would claim the provider recomputed usage when we called.
 assert.notEqual(absent.observedAt, absent.fetchedAt);
 const given = project({ percent: 12.34, observedAt: NOW - 60000 });
 assert.equal(given.observedAt, new Date(NOW - 60000).toISOString());
 assert.equal(project({ percent: 1, observedAt: 'not-a-time' }).observedAt, null);
});

test('a guaranteed resolution is recorded and an observed decimal is not mistaken for one', () => {
 // Seeing 12.34 once does not prove the provider reports hundredths.
 assert.equal(project({ percent: 12.34 }).resolutionPp, null);
 assert.equal(project({ percent: 12.34 }).precisionEvidence, 'unknown');
 assert.equal(project({ percent: 12.34, resolutionPp: 0.01 }).resolutionPp, 0.01);
 assert.equal(project({ percent: 12.34, resolutionPp: 0 }).resolutionPp, null);
 assert.equal(project({ percent: 28, precisionEvidence: 'integer_only' }).precisionEvidence, 'integer_only');
 assert.equal(project({ percent: 28, precisionEvidence: 'made-up' }).precisionEvidence, 'unknown');
 assert.equal(project({ percent: 1, windowSemantics: 'made-up' }).windowSemantics, 'unknown');
 assert.equal(project({ percent: 1, windowSemantics: 'sliding' }).windowSemantics, 'sliding');
});

test('a reading with no usable number publishes nothing rather than zero', () => {
 const empty = project({ used: 10, limit: 0 });
 assert.equal(publishedPercent(empty), null);
 // The trap this guards: Math.min coerces null to 0, which would announce a 0% reading
 // nobody observed. Callers must drop the window instead.
 assert.equal(Math.min(100, publishedPercent(empty)), 0);
 assert.equal(publishedPercent(null), null);
});

test('a very large finite pair does not overflow into Infinity', () => {
 // used * 100 overflows for inputs this size, so the product cannot be the only route.
 assert.equal(Number.isFinite(1e308 * 100), false);
 const huge = project({ used: 1e308, limit: 1e308 });
 assert.equal(huge.calculatedPercent, 100);
 assert.equal(publishedPercent(huge), 100);
 assert.equal(Number.isFinite(huge.calculatedPercent), true);
 // A limit small enough that even dividing first overflows publishes nothing.
 const impossible = project({ used: 1e308, limit: 1e-308 });
 assert.equal(impossible.calculatedPercent, null);
 assert.equal(publishedPercent(impossible), null);
});

test('the reconciliation boundary is decided on the computed difference, not on intent', () => {
 // 1 against 1.05 is nominally exactly the tolerance, but the subtraction lands just
 // outside it in binary floating point. The rule is the computed comparison, stated here
 // so the behaviour at the boundary is recorded rather than assumed either way.
 const edge = project({ percent: 1, used: 1.05, limit: 100 });
 assert.equal(Math.abs(edge.reportedPercent - edge.calculatedPercent) > MISMATCH_TOLERANCE_PP, true);
 assert.equal(edge.reconciliation, 'mismatch');
 // Comfortably inside and comfortably outside behave as expected.
 assert.equal(project({ percent: 1.02, used: 1, limit: 100 }).reconciliation, 'matched');
 assert.equal(project({ percent: 1.2, used: 1, limit: 100 }).reconciliation, 'mismatch');
});
