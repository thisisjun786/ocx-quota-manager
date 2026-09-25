import test from 'node:test';
import assert from 'node:assert/strict';

// The summary figure reads the embedded UI module the Go binary serves.
const { weeklyQuotaUsage } = await import('../webembed/static/quota.js');

const windowOf = (current, past) => ({ id: 'weekly', label: '주간', remainingPercent: 50, resetAt: null, analytics: {
  providerWide: true,
  consumptionPeriods: { oneHour: current === null ? { deltaPp: null } : { deltaPp: current, spanHours: 1, coverage: 1, basis: 'observed-increase' } },
  historicalConsumptionPeriods: { oneHour: past === null ? null : { deltaPp: past, spanHours: 1, coverage: 1, periodEndedAt: 1790061259210 } },
} });

test('a paused account\'s past hour is not added to the current hour', () => {
  const provider = { id: 'openai', name: 'OpenAI', accounts: [
    { id: 'active', status: 'ok', windows: [windowOf(8, null)] },
    { id: 'paused-1', status: 'paused', windows: [windowOf(null, 2)] },
    { id: 'paused-2', status: 'paused', windows: [windowOf(null, 2)] },
  ] };
  assert.equal(weeklyQuotaUsage(provider, 'oneHour').value, '≈ 8%p');
});

test('with no current reading the last observed period is still shown', () => {
  const provider = { id: 'openai', name: 'OpenAI', accounts: [{ id: 'paused', status: 'paused', windows: [windowOf(null, 2)] }] };
  assert.equal(weeklyQuotaUsage(provider, 'oneHour').value, '≈ 2%p');
});

test('the summary renders the server total when it is published', () => {
  const provider = { id: 'openai', name: 'OpenAI', analytics: { quotaConsumption: { oneHour: {
    windowId: 'weekly', deltaPp: 9, accounts: 4, measuredAccounts: 1, unobservedAccounts: 3, coverage: 1, spanHours: 1, partial: false, observedIncrease: false } } },
    // A client-side sum of these windows would differ; the published total wins.
    accounts: [{ id: 'active', status: 'ok', windows: [windowOf(20, null)] }] };
  const got = weeklyQuotaUsage(provider, 'oneHour');
  assert.equal(got.value, '≈ 9%p');
  assert.equal(got.state, 'partial');
  assert.match(got.note, /1\/4계정/);
});

test('a published period with no reading is unobserved, not zero', () => {
  const provider = { id: 'openai', name: 'OpenAI', analytics: { quotaConsumption: { oneHour: {
    windowId: 'weekly', deltaPp: null, accounts: 3, measuredAccounts: 0, unobservedAccounts: 3 } } }, accounts: [] };
  assert.equal(weeklyQuotaUsage(provider, 'oneHour').value, '미관측');
});
