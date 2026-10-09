import test from 'node:test';
import assert from 'node:assert/strict';

const { parseLogPage } = await import('../webembed/static/collection-data.js');

const page = (overrides = {}) => ({
  period: '24h', from: 1, to: 2, retentionDays: 30, nextBefore: null, providers: ['anthropic'],
  accounts: [{ provider: 'anthropic', account: 'a1' }],
  summary: [{ provider: 'anthropic', attempts: 4, successes: 3, rateLimited: 1, successRate: 75, rateLimitRate: 25, lastSuccessAt: 2 }],
  rows: [{ id: 9, startedAt: 1, provider: 'anthropic', account: 'a1', endpoint: 'oauth-usage', result: 'rate_limited', httpStatus: 429, durationMs: 300, retryAfterMs: 600000, nextAttemptAt: 3, failures: 1 }],
  ...overrides,
});

test('a filtered request page keeps the all-result summary denominator', () => {
  const parsed = parseLogPage(page());
  assert.equal(parsed.summary[0].attempts, 4);
  assert.equal(parsed.rows[0].retryAfterMs, 600000);
});

test('an unknown request result is rejected instead of rendered as success', () => {
  assert.throws(() => parseLogPage(page({ rows: [{ ...page().rows[0], result: 'made_up' }] })), /Invalid collection result/);
});

test('nullable response fields stay null rather than becoming zero', () => {
  const parsed = parseLogPage(page({ rows: [{ ...page().rows[0], httpStatus: null, retryAfterMs: null }], summary: [{ ...page().summary[0], lastSuccessAt: null, successRate: null }] }));
  assert.equal(parsed.rows[0].httpStatus, null);
  assert.equal(parsed.summary[0].lastSuccessAt, null);
});
