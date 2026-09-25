// Where the five usage periods, the price state and the quota-collection state meet.
// Each feature owns its own unit tests; this file only holds the cases that need two or
// more of them to be wrong together, and the contract the published response owes to the
// consumers that already read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, utimes, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createCollector } from '../src/collector.mjs';
import { readSnapshot, SOURCE_STATUS } from '../src/snapshot.mjs';
import { USAGE_PERIODS } from '../src/analytics.mjs';

const HOUR = 3600000;
const NOW = Date.parse('2026-09-14T14:00:00Z');
const iso = ms => new Date(ms).toISOString();
// The log label OpenCodex writes, per src/identity.mjs:23,34. Anthropic uses the bare id.
const anthropicAccount = id => 'anthropic-p' + createHash('sha256').update(id).digest('hex').slice(0, 6);
const otherAccount = (provider, id) =>
  `${provider}-o` + createHash('sha256').update(`${provider}\0${id}`).digest('hex').slice(0, 6);
const call = (requestId, { provider, model, at, input = 1000, output = 100 }) => JSON.stringify({
  requestId, timestamp: at, provider, model, usageStatus: 'reported',
  usage: { inputTokens: input, outputTokens: output } });

async function world(t, { config = {}, auth = {}, usage = [], terminated = true, catalog = null,
  quotaRows = null, codexAccounts = null, native = null, collector: extra = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'quota-integration-'));
  // One owner for the live collector. A reopen replaces it, and cleanup closes whatever is
  // current exactly once: src/history.mjs:358 closes SQLite directly, and a second close
  // throws ERR_INVALID_STATE. Removal is registered here, before anything can fail.
  let current = null;
  t.after(async () => {
    try { await current?.close(); } finally { current = null; await rm(home, { recursive: true, force: true }); }
  });
  const codexHome = join(home, 'native');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify(native ?? {}));
  const catalogPath = join(home, 'models.json');
  let clock = NOW, held = catalog, revision = 0;
  // Every catalog revision lands on a fresh inode. src/pricing-catalog.mjs:131 skips the
  // read when ino:size:mtimeMs:ctimeMs all match, which an in-place rewrite of the same
  // length at a pinned mtime can reproduce -- the new rates would then never be read.
  const publish = async value => {
    const staging = `${catalogPath}.${++revision}`;
    await writeFile(staging, JSON.stringify(value));
    await utimes(staging, new Date(clock), new Date(clock));
    await rename(staging, catalogPath);
  };
  const writeUsage = (rows, ends = true) =>
    writeFile(join(home, 'usage.jsonl'), rows.join('\n') + (ends ? '\n' : ''));
  const writeConfig = value => writeFile(join(home, 'config.json'), JSON.stringify(value));
  await writeConfig(config);
  await writeFile(join(home, 'auth.json'), JSON.stringify(auth));
  if (quotaRows) await writeFile(join(home, 'provider-account-quota-cache.json'),
    JSON.stringify({ version: 1, rows: quotaRows }));
  if (codexAccounts) await writeFile(join(home, 'codex-accounts.json'), JSON.stringify(codexAccounts));
  await writeUsage(usage, terminated);
  if (held) await publish(held);
  const dataDir = join(home, 'state');
  const open = async () => {
    current = await createCollector({ home, codexHome, dataDir, catalogPath, now: () => clock, ...extra });
    return current;
  };
  await open();
  return {
    home, codexHome, dataDir, catalogPath, writeUsage, writeConfig,
    get collector() { return current; },
    now: () => clock,
    // The catalog's freshness is measured against its own mtime (src/pricing-catalog.mjs:141),
    // so moving the clock without moving the file would quietly turn a fresh catalog stale
    // and block every gap resolution for a reason the test never asked for.
    async advance(ms) { clock += ms; if (held) await publish(held); },
    async setCatalog(value) { held = value; await publish(value); },
    async reopen() { await current.close(); current = null; return open(); },
    body: async () => JSON.parse(JSON.stringify(await current.snapshot())),
    sourceStatus: async () => (await readSnapshot(home, clock, codexHome))[SOURCE_STATUS],
  };
}

const providerOf = (body, id) => body.providers.find(p => p.id === id);
const findingsFor = (gaps, model) =>
  (gaps.models.find(row => row.model === model)?.findings ?? []).map(f => f.reason).sort();

test('an unpriced model, a removed one and a failed collection stay three separate facts in one response', async t => {
  const account = anthropicAccount('c1');
  const w = await world(t, {
    // A catalog has to be present and fresh, or every cycle reports a blocked lookup and
    // nothing is ever recorded to open, resolve or fail.
    catalog: {},
    config: { providers: { anthropic: { models: ['claude-opus-5', 'claude-sonnet-5', 'mystery-model'] } } },
    auth: { anthropic: { accounts: [{ id: 'c1', credential: { accountId: 'phys-c1' } }] } },
    usage: [call('priced', { provider: account, model: 'claude-opus-5', at: NOW - HOUR }),
      call('unpriced', { provider: account, model: 'mystery-model', at: NOW - HOUR })],
  });
  await w.collector.collect();
  await w.advance(6 * 60000);
  const settled = w.now();
  await w.writeConfig({ providers: { anthropic: { models: ['claude-opus-5', 'mystery-model'] } } });
  await w.collector.collect();
  await w.advance(6 * 60000);
  const failed = w.now();
  await rename(join(w.home, 'usage.jsonl'), join(w.home, 'usage.moved'));
  await w.collector.collect();

  const body = await w.body();
  const anthropic = providerOf(body, 'anthropic');
  assert.equal(body.analytics.status, 'error');
  assert.equal(body.analytics.usageStale, true);
  // The failure is not a removal. The list was read before the log failed, so the roster
  // keeps what it learned and names the departure once.
  const roster = anthropic.analytics.modelRoster;
  assert.equal(roster.models.find(m => m.model === 'claude-sonnet-5').state, 'removed');
  assert.equal(roster.models.find(m => m.model === 'claude-sonnet-5').removedAt, iso(settled));
  assert.equal(roster.changes.filter(c => c.change === 'removed').length, 1);
  assert.equal(roster.models.find(m => m.model === 'mystery-model').state, 'listed');
  // The failure is not a price confirmation either. It blocks resolution and says so.
  const gaps = anthropic.analytics.priceGaps;
  assert.equal(body.analytics.priceGaps.status, 'lookup-failed');
  assert.equal(body.analytics.priceGaps.failureSince, iso(failed));
  assert.equal(body.analytics.priceGaps.resolutionBlocked, true);
  assert.deepEqual(findingsFor(gaps, 'mystery-model'), ['price-missing']);
  assert.equal(gaps.models.find(r => r.model === 'mystery-model').findings[0].state, 'open');
  assert.deepEqual(gaps.resolved, []);
  // A model that left the list cleanly is not a shortage warning, and it carries no price
  // row at all once it is neither configured nor recorded.
  assert.deepEqual(gaps.retiredModels, [{ model: 'claude-sonnet-5', removedAt: iso(settled), priceStatus: null }]);
  // Every period ends at the last successful read, never at the failed cycle's clock.
  assert.equal(body.analytics.usageObservedAt, iso(settled));
  for (const [key] of USAGE_PERIODS) {
    assert.equal(anthropic.analytics.periods[key].endedAt, iso(settled), key);
    assert.notEqual(anthropic.analytics.periods[key].endedAt, iso(failed), key);
  }

  // The other direction, so the assertions above cannot be passing on inertia: restore the
  // log, give the unpriced model a rate, and the same surfaces must move.
  await w.advance(6 * 60000);
  const repaired = w.now();
  await rename(join(w.home, 'usage.moved'), join(w.home, 'usage.jsonl'));
  await w.setCatalog({ anthropic: { models: { 'mystery-model': { cost: { input: 3, output: 4 } } } } });
  await w.collector.collect();
  const after = await w.body();
  const healed = providerOf(after, 'anthropic').analytics.priceGaps;
  assert.equal(after.analytics.status, 'ok');
  assert.equal(after.analytics.usageObservedAt, iso(repaired));
  assert.ok(healed.resolved.some(r => r.model === 'mystery-model' && r.reason === 'price-missing'));
  // A local catalog row states four numbers and nothing about what qualifies them, so the
  // model keeps reporting the gaps that quote genuinely has. That is not a regression.
  assert.deepEqual(findingsFor(healed, 'mystery-model'),
    ['checked-at-missing', 'condition-missing', 'source-missing']);
  // And the departure is still named exactly once across all four cycles.
  assert.equal(providerOf(after, 'anthropic').analytics.modelRoster.changes
    .filter(c => c.change === 'removed').length, 1);
});

// The five spans, hardcoded rather than derived from USAGE_PERIODS. Reading the table the
// code under test also reads would make the assertion move with the drift it exists to catch.
const SPAN_HOURS = [1, 5, 24, 168, 720];
const KEYS = ['oneHour', 'fiveHour', 'twentyFourHour', 'weekly', 'monthly'];

test('the five periods carry one anchor and one set of totals across the account, the provider and the price-gap surfaces', async t => {
  const account = otherAccount('opencode-go', 'g1');
  const w = await world(t, {
    catalog: { 'opencode-go': { models: { 'future-model': { cost: { input: 2, output: 4 } } } } },
    config: { providers: { 'opencode-go': { models: ['future-model'] } } },
    auth: { 'opencode-go': { accounts: [{ id: 'g1', credential: { accountId: 'phys-g1' } }] } },
    // Three attributed calls that each land in a different span, plus one call carrying only
    // a provider name, so the provider total is genuinely larger than the account's.
    usage: [call('halfhour', { provider: account, model: 'future-model', at: NOW - 30 * 60000 }),
      call('threehours', { provider: account, model: 'future-model', at: NOW - 3 * HOUR }),
      call('fortyhours', { provider: account, model: 'future-model', at: NOW - 40 * HOUR }),
      call('nobody', { provider: 'opencode-go', model: 'future-model', at: NOW - 30 * 60000 })],
  });
  await w.collector.collect();
  const body = await w.body();
  const provider = providerOf(body, 'opencode-go');
  const periods = provider.analytics.periods;
  const accountPeriods = provider.accounts[0].analytics.periods;
  const impact = provider.analytics.priceGaps.periods;

  assert.deepEqual(Object.keys(periods), KEYS);
  // One anchor. Three surfaces compute their own boundaries; none of them may drift.
  for (const [index, key] of KEYS.entries()) {
    const ends = body.analytics.usageObservedAt;
    assert.equal(periods[key].endedAt, ends, key);
    assert.equal(accountPeriods[key].endedAt, ends, key);
    assert.equal(impact[key].endedAt, ends, key);
    assert.equal(Date.parse(ends) - Date.parse(periods[key].startedAt), SPAN_HOURS[index] * HOUR, key);
    assert.equal(periods[key].hours, SPAN_HOURS[index], key);
    assert.equal(impact[key].hours, SPAN_HOURS[index], key);
  }
  // One set of totals. Timestamps agreeing while amounts disagree is the failure this
  // exists to catch, so the amounts are literal.
  assert.deepEqual(KEYS.map(k => periods[k].requests), [2, 3, 3, 4, 4]);
  assert.deepEqual(KEYS.map(k => periods[k].tokens), [2200, 3300, 3300, 4400, 4400]);
  assert.deepEqual(KEYS.map(k => periods[k].apiUsd), [0.0048, 0.0072, 0.0072, 0.0096, 0.0096]);
  assert.deepEqual(KEYS.map(k => accountPeriods[k].requests), [1, 2, 2, 3, 3]);
  assert.deepEqual(KEYS.map(k => accountPeriods[k].apiUsd), [0.0024, 0.0048, 0.0048, 0.0072, 0.0072]);
  // A provider total is the three parts it is queried as, never a sum of account rows.
  for (const key of KEYS) {
    assert.equal(periods[key].requests,
      periods[key].listedAccountRequests + periods[key].unlistedAccountRequests
      + periods[key].unattributedRequests, key);
    assert.equal(periods[key].unattributedRequests, 1, key);
    assert.equal(periods[key].unlistedAccountRequests, 0, key);
    // No row at all is a null amount, not a zero one. The distinction is the whole point of
    // telling an unrecorded call apart from a free one.
    assert.equal(periods[key].unlistedAccountApiUsd, null, key);
    assert.equal(periods[key].listedAccountApiUsd + periods[key].unattributedApiUsd,
      periods[key].apiUsd, key);
  }

  // A failed collection freezes the periods; it must not restate them. Same anchor, same
  // totals, on all three surfaces.
  await w.advance(6 * 60000);
  const failed = w.now();
  await rename(join(w.home, 'usage.jsonl'), join(w.home, 'usage.moved'));
  await w.collector.collect();
  const after = await w.body();
  const frozen = providerOf(after, 'opencode-go');
  assert.equal(after.analytics.status, 'error');
  assert.notEqual(after.analytics.usageObservedAt, iso(failed));
  assert.equal(after.analytics.usageObservedAt, body.analytics.usageObservedAt);
  assert.deepEqual(KEYS.map(k => frozen.analytics.periods[k].requests), [2, 3, 3, 4, 4]);
  assert.deepEqual(KEYS.map(k => frozen.analytics.periods[k].apiUsd), [0.0048, 0.0072, 0.0072, 0.0096, 0.0096]);
  assert.deepEqual(KEYS.map(k => frozen.accounts[0].analytics.periods[k].apiUsd),
    [0.0024, 0.0048, 0.0048, 0.0072, 0.0072]);
  for (const key of KEYS) {
    assert.equal(frozen.analytics.priceGaps.periods[key].endedAt, body.analytics.usageObservedAt, key);
  }
});

test('the source status, the retained price record and the price-gap report do not contradict each other', async t => {
  const account = otherAccount('opencode-go', 'g1');
  const w = await world(t, {
    // settled-model is priced now; latecomer-model is not priced by anything yet.
    catalog: { 'opencode-go': { models: { 'settled-model': { cost: { input: 2, output: 4 } } } } },
    config: { providers: { 'opencode-go': { models: ['settled-model', 'latecomer-model'] } } },
    auth: { 'opencode-go': { accounts: [{ id: 'g1', credential: { accountId: 'phys-g1' } }] } },
    usage: [call('settled', { provider: account, model: 'settled-model', at: NOW - HOUR }),
      call('late', { provider: account, model: 'latecomer-model', at: NOW - HOUR })],
  });
  await w.collector.collect();
  const body = await w.body();
  const provider = providerOf(body, 'opencode-go');
  const gaps = body.analytics.priceGaps;

  // What the snapshot read and what the gap report believes it read are the same statement.
  const sources = await w.sourceStatus();
  assert.equal(gaps.modelListStatus, sources.files.ocxConfig.status);
  assert.equal(gaps.catalogStatus, body.analytics.pricingCatalog.status);
  assert.equal(gaps.resolutionBlocked, !(body.analytics.status !== 'error'
    && gaps.catalogStatus === 'ok' && gaps.modelListStatus === 'ok'));
  assert.equal(gaps.resolutionBlocked, false);
  // A model whose amount was explained has both a record of what explained it and a current
  // price row. Neither list may name something the other has never heard of.
  const priced = new Set(provider.analytics.modelPrices.map(row => row.model));
  for (const row of provider.analytics.priceEvidence) {
    if (row.evidence === null) continue;
    assert.ok(priced.has(row.model), row.model);
  }
  // The excluded calls each surface counts are the same calls.
  for (const key of KEYS) {
    assert.equal(provider.analytics.priceGaps.periods[key].unpricedRequests,
      provider.analytics.periods[key].unknownPriceRequests, key);
  }
  assert.deepEqual(KEYS.map(k => provider.analytics.periods[k].unknownPriceRequests), [0, 1, 1, 1, 1]);
});

test('a catalog that drops a model leaves three surfaces telling one consistent story', async t => {
  const account = otherAccount('opencode-go', 'g1');
  const w = await world(t, {
    catalog: { 'opencode-go': { models: { 'settled-model': { cost: { input: 2, output: 4 } } } } },
    config: { providers: { 'opencode-go': { models: ['settled-model'] } } },
    auth: { 'opencode-go': { accounts: [{ id: 'g1', credential: { accountId: 'phys-g1' } }] } },
    usage: [call('settled', { provider: account, model: 'settled-model', at: NOW - HOUR })],
  });
  await w.collector.collect();
  const before = providerOf(await w.body(), 'opencode-go');
  assert.equal(before.analytics.periods.monthly.apiUsd, 0.0024);
  // The catalog forgets the model. The call it already valued does not become unexplained.
  await w.advance(6 * 60000);
  await w.setCatalog({ 'opencode-go': { models: {} } });
  await w.collector.collect();
  const after = providerOf(await w.body(), 'opencode-go');
  const quote = after.analytics.modelPrices.find(row => row.model === 'settled-model');
  const record = after.analytics.priceEvidence.find(row => row.model === 'settled-model');
  assert.equal(quote.status, 'unpriced');
  assert.equal(quote.rates.input, null);
  assert.deepEqual(findingsFor(after.analytics.priceGaps, 'settled-model'), ['price-missing']);
  // The retained record still carries the rate that produced the stored amount, so the
  // response says "no current price" and "this is what it cost" without contradicting itself.
  assert.equal(record.evidence.rates.input, 2);
  assert.equal(record.storedApiUsd, 0.0024);
  assert.equal(after.analytics.periods.monthly.apiUsd, 0.0024);
  assert.equal(after.analytics.periods.monthly.unknownPriceRequests, 0);
});

test('a per-limit model mapping reaches the published window without touching a sibling limit', async t => {
  const w = await world(t, {
    catalog: {},
    config: { providers: { anthropic: { models: ['claude-opus-5'] }, cursor: { models: ['grok-4.6'] } } },
    auth: { anthropic: { accounts: [{ id: 'c1', credential: { accountId: 'phys-c1' } }] },
      cursor: { accounts: [{ id: 'u1', credential: { accountId: 'phys-u1' } }] } },
    quotaRows: {
      ['anthropic\u0000c1']: { updatedAt: NOW - 60000, weeklyPercent: 40,
        weeklyResetAt: Math.floor((NOW + 10 * HOUR) / 1000),
        customWindows: [{ label: 'Fable', percent: 55, resetAt: Math.floor((NOW + 9 * HOUR) / 1000) }] },
      ['cursor\u0000u1']: { updatedAt: NOW - 60000,
        customWindows: [{ label: 'API usage', percent: 12, resetAt: Math.floor((NOW + 8 * HOUR) / 1000) }] },
    },
  });
  await w.collector.collect();
  const body = await w.body();
  const windows = providerOf(body, 'anthropic').accounts[0].windows;
  const weekly = windows.find(win => win.id === 'weekly');
  // Named after the limit rather than its position in the response: history separates samples
  // by window.id, so a window that is renamed when a sibling appears splits one limit in two.
  const fable = windows.find(win => win.id === 'custom-fable');
  // A confirmed narrower scope renames its own window and declares the set it counts.
  assert.equal(weekly.label, '전체 주간');
  assert.equal(weekly.usageScope, 'all');
  assert.equal(fable.label, 'Fable 주간');
  assert.equal(fable.usageScope, 'fable');
  // A scope that does not publish its identity must stay absent rather than arrive as null:
  // src/window-scope.mjs:9-11 makes emission part of the window's published identity, and a
  // saved menu-bar selection is built from it.
  const cursorWindow = providerOf(body, 'cursor').accounts[0].windows.find(win => win.id === 'custom-api-usage');
  assert.equal(cursorWindow.label, 'API usage');
  assert.equal('usageScope' in cursorWindow, false);
});

test('a catalog revision fills an unpriced amount through the collector without restating a settled one', async t => {
  const account = otherAccount('opencode-go', 'g1');
  const w = await world(t, {
    catalog: { 'opencode-go': { models: { 'settled-model': { cost: { input: 2, output: 4 } } } } },
    config: { providers: { 'opencode-go': { models: ['settled-model', 'latecomer-model'] } } },
    auth: { 'opencode-go': { accounts: [{ id: 'g1', credential: { accountId: 'phys-g1' } }] } },
    usage: [call('settled', { provider: account, model: 'settled-model', at: NOW - HOUR }),
      call('late', { provider: account, model: 'latecomer-model', at: NOW - HOUR })],
  });
  await w.collector.collect();
  const first = await w.body();
  const started = first.analytics.usageObservedSince;
  assert.equal(providerOf(first, 'opencode-go').analytics.periods.monthly.apiUsd, 0.0024);
  assert.equal(providerOf(first, 'opencode-go').analytics.periods.monthly.unknownPriceRequests, 1);
  assert.equal(first.analytics.usageObservedThrough, iso(NOW));

  // A real revision: the settled model's rate changes and the unpriced one acquires a rate.
  await w.advance(60000);
  await w.setCatalog({ 'opencode-go': { models: {
    'settled-model': { cost: { input: 10, output: 4 } },
    'latecomer-model': { cost: { input: 3, output: 4 } } } } });
  await w.collector.collect();
  const second = await w.body();
  const provider = providerOf(second, 'opencode-go');
  // The replay ran: the call nothing could value is now valued, at the new model's rate.
  assert.equal(provider.analytics.periods.monthly.apiUsd, 0.0058);
  assert.equal(provider.analytics.periods.monthly.unknownPriceRequests, 0);
  assert.equal(provider.analytics.modelPrices.find(r => r.model === 'latecomer-model').status, 'local-catalog');
  // And it stopped there. A settled amount is not re-explained by a later tariff: 0.0058 is
  // 0.0024 + 0.0034, not 0.0104 + 0.0034.
  const record = provider.analytics.priceEvidence.find(row => row.model === 'settled-model');
  assert.equal(record.evidence.rates.input, 2);
  assert.equal(record.storedApiUsd, 0.0024);
  // The rows were refilled, not re-imported.
  assert.equal(provider.analytics.periods.monthly.requests, 2);
  // The observation run is continuous across the replay, and its far end moved with the read.
  assert.equal(second.analytics.usageObservedSince, started);
  assert.equal(second.analytics.usageObservedThrough, iso(NOW + 60000));

  // The run has to survive the process, not only the open handle.
  await w.reopen();
  await w.collector.collect();
  const third = await w.body();
  assert.equal(third.analytics.usageObservedSince, started);
  assert.equal(providerOf(third, 'opencode-go').analytics.periods.monthly.apiUsd, 0.0058);
});

test('a reauth login, a passed reset, a failed refresh and an unterminated log are four states, not one', async t => {
  // The management API answers 500. src/provider-refresh.mjs:63-66 throws on a failed status
  // without reading the body, so the response is ended empty and the connection closed.
  const management = createServer((request, response) => {
    response.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end();
  });
  await new Promise(resolve => management.listen(0, '127.0.0.1', resolve));
  // Its own cleanup: closing the collector drains collection and storage, nothing else.
  t.after(() => new Promise(resolve => management.close(resolve)));
  const account = anthropicAccount('c1');
  const w = await world(t, {
    catalog: {},
    config: { providers: { anthropic: { models: ['claude-opus-5'] } } },
    auth: { anthropic: { accounts: [
      { id: 'c1', credential: { accountId: 'phys-c1' } },
      { id: 'c2', credential: { accountId: 'phys-c2' }, needsReauth: true }] } },
    quotaRows: {
      // A reset already in the past: the reading is stale however recent it is.
      ['anthropic\u0000c1']: { updatedAt: NOW - 60000, weeklyPercent: 40,
        weeklyResetAt: Math.floor((NOW - HOUR) / 1000) },
      ['anthropic\u0000c2']: { updatedAt: NOW - 60000, weeklyPercent: 70,
        weeklyResetAt: Math.floor((NOW + 9 * HOUR) / 1000) },
    },
    // No trailing newline: the last record is still being written, so the read never reaches
    // the end of the file (src/history.mjs:447).
    terminated: false,
    usage: [call('one', { provider: account, model: 'claude-opus-5', at: NOW - HOUR }),
      call('two', { provider: account, model: 'claude-opus-5', at: NOW - 30 * 60000 })],
    collector: { managementOrigin: `http://127.0.0.1:${management.address().port}` },
  });
  await writeFile(join(w.home, 'admin-api-token'), 'ocx_admin_' + 'a'.repeat(43));
  await w.collector.collect();
  const body = await w.body();
  const anthropic = providerOf(body, 'anthropic');
  const [first, second] = anthropic.accounts;

  // A reset that has passed makes the window stale and the account with it, and the window
  // says it is waiting for a measurement rather than blaming the login.
  assert.equal(first.status, 'stale');
  assert.equal(first.windows[0].stale, true);
  assert.equal(first.windows[0].analytics.status, 'stale');
  assert.match(first.windows[0].analytics.reason, /측정값/);
  // A login needing attention is a different state with a different reason, and its window
  // is not stale on its own terms.
  assert.equal(second.status, 'reauth');
  assert.equal(second.windows[0].stale, false);
  assert.equal(second.windows[0].analytics.status, 'stale');
  assert.match(second.windows[0].analytics.reason, /로그인/);
  // A refresh that failed is reported as a delayed refresh and a warning, not as missing data.
  assert.equal(first.refresh.status, 'delayed');
  assert.ok(body.warnings.some(warning => warning.includes('자동 조회에 실패')));
  // A read that never reached the end of the log has no far end, so no span is claimed as
  // observed even though the read itself succeeded.
  assert.equal(body.analytics.usageObservedThrough, null);
  assert.equal(body.analytics.status, 'ok');
  assert.equal(body.analytics.usageObservedAt, iso(NOW));
  for (const key of KEYS) {
    assert.equal(anthropic.analytics.periods[key].observedCoverageHours, 0, key);
    assert.equal(anthropic.analytics.periods[key].endedAt, iso(NOW), key);
  }
  // The record that was complete still counted; only the unfinished one is held back.
  assert.equal(anthropic.analytics.periods.monthly.requests, 1);

  // Finish the line and the observation run acquires a far end. Same log, same rows.
  await w.advance(60000);
  await w.writeUsage([call('one', { provider: account, model: 'claude-opus-5', at: NOW - HOUR }),
    call('two', { provider: account, model: 'claude-opus-5', at: NOW - 30 * 60000 })], true);
  await w.collector.collect();
  const after = await w.body();
  assert.equal(after.analytics.usageObservedThrough, iso(NOW + 60000));
  assert.equal(providerOf(after, 'anthropic').analytics.periods.monthly.requests, 2);
});

// A synthetic provider endpoint and adapter, kept separate from the shipped table so this
// contract test never depends on a real provider's response shape. A fetcher alone still
// reaches nothing: src/collector.mjs:147 defaults the adapter list to empty, so an install
// that registers none makes no request at all.
const DIRECT_ENDPOINTS = { openai: { 'synthetic-usage': { host: 'quota.invalid', path: '/usage',
  configuredOrigins: ['https://quota.invalid'], acceptsDefaultBase: true,
  authorize: credential => ({ Authorization: `Bearer ${credential.value}` }) } } };
const directAdapter = {
  provider: 'openai', endpointId: 'synthetic-usage', sourceVersion: 'synthetic-1',
  appliesTo: binding => binding.accountId === 'pool1',
  parse: json => (json.windows ?? []).map(window => ({ windowId: window.id, label: window.id,
    resetAt: window.resetAt ?? null, raw: { scopeKey: `account:${window.id}`, ...window } })),
};

async function expiryWorld(t, { expiresAt }) {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, authorization: init.headers.Authorization });
    return { status: 401, headers: { get: () => null }, text: async () => '{}' };
  };
  const w = await world(t, {
    catalog: {},
    config: { providers: { openai: { models: ['gpt-5.6-luna'] } }, codexAccounts: [{ id: 'pool1' }] },
    codexAccounts: { pool1: { credential: { accessToken: 'SYNTHETIC_POOL_TOKEN',
      chatgptAccountId: 'phys-pool1', expiresAt } } },
    native: { tokens: { account_id: 'native-main', access_token: 'SYNTHETIC_MAIN_TOKEN' } },
    collector: { directAdapters: [directAdapter], directEndpoints: DIRECT_ENDPOINTS, directFetcher: fetcher },
  });
  return { ...w, requests };
}

test('an expired direct credential is reported as expired, and a live one with the same refusal is not', async t => {
  const expired = await expiryWorld(t, { expiresAt: NOW - 1 });
  await expired.collector.collect();
  // The refusal has to have actually happened, or "no expiry was reported" would pass for a
  // lookup that never left the process.
  assert.ok(expired.requests.length > 0, 'the adapter must have issued a request');
  const pool = providerOf(await expired.body(), 'openai').accounts.find(a => a.id === 'pool1');
  assert.equal(pool.directQuota.status, 'credential_expired');
  assert.equal(pool.directQuota.reason, 'expired_at');
  // A refused lookup never invents a reading.
  assert.deepEqual(pool.windows, []);
  assert.equal(pool.status, 'unavailable');

  // Same 401, same absent rotation, but the credential has not expired: the product must not
  // blame the clock for it. A separate world, because the retry backoff is jittered.
  const live = await expiryWorld(t, { expiresAt: NOW + HOUR });
  await live.collector.collect();
  assert.ok(live.requests.length > 0);
  const fresh = providerOf(await live.body(), 'openai').accounts.find(a => a.id === 'pool1');
  assert.equal(fresh.directQuota.status, 'credential_expired');
  assert.equal(fresh.directQuota.reason, null);
});

// ---------------------------------------------------------------------------
// What the macOS client decodes, transcribed by hand from macos/Sources/QuotaModel.swift.
// This is a transcription, not an execution: no JSONDecoder runs here and no Mac is
// involved. The test below compares this table against the Swift source so that a field
// added, removed or made optional over there fails here first.
const SWIFT_MODEL = {
  QuotaSnapshot: { schemaVersion: ['Int', false], observedAt: ['String', false],
    providers: ['[QuotaProvider]', false] },
  QuotaProvider: { id: ['String', false], name: ['String', false], enabled: ['Bool', false],
    accounts: ['[QuotaAccount]', false] },
  QuotaAccount: { id: ['String', false], label: ['String', false], plan: ['String', true],
    status: ['String', false], updatedAt: ['String', true], windows: ['[QuotaWindow]', false] },
  QuotaWindow: { id: ['String', false], label: ['String', false], remainingPercent: ['Double', true],
    stale: ['Bool', true], resetAt: ['String', true], usageScope: ['String', true] },
};
// Swift's Int does not accept 1.5, and a plain typeof check would.
const SCALAR = {
  Int: value => Number.isInteger(value),
  Double: value => typeof value === 'number' && Number.isFinite(value),
  String: value => typeof value === 'string',
  Bool: value => typeof value === 'boolean',
};
// The rules a synthesized Decodable conformance follows: a declared non-optional key must be
// present and well typed, an optional one may be absent or null, and an undeclared key is
// ignored. That last rule is what lets analytics ride along.
function decodeSwift(typeName, value, path = typeName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
  const decoded = {};
  for (const [field, [type, optional]] of Object.entries(SWIFT_MODEL[typeName])) {
    const present = Object.hasOwn(value, field) && value[field] !== null;
    if (!present) {
      if (!optional) throw new Error(`${path}.${field}: missing required ${type}`);
      decoded[field] = null;
      continue;
    }
    const element = /^\[(.+)\]$/.exec(type);
    if (element) {
      if (!Array.isArray(value[field])) throw new Error(`${path}.${field}: expected an array`);
      decoded[field] = value[field].map((row, index) =>
        decodeSwift(element[1], row, `${path}.${field}[${index}]`));
      continue;
    }
    if (!SCALAR[type](value[field])) throw new Error(`${path}.${field}: expected ${type}`);
    decoded[field] = value[field];
  }
  return decoded;
}
// QuotaStore.swift:69 throws on anything else, so a decodable body is still not an accepted one.
const acceptSnapshot = body => {
  const decoded = decodeSwift('QuotaSnapshot', body);
  if (decoded.schemaVersion !== 1) throw new Error('schemaVersion: only 1 is accepted');
  return decoded;
};
// QuotaModel.swift:46-48 joined with QuotaStore.swift:35,74.
const pinKey = (providerId, window) => providerId + '/' +
  [window.id.startsWith('custom-') ? 'custom' : window.id, window.usageScope ?? '', window.label].join(':');
// The two product expressions that build that key, whitespace removed. Comparing the whole
// expression is what catches a renamed normalisation value or a changed separator; asking
// whether the parts are present does not.
const squash = text => text.replace(/\s+/g, '');
const WEB_KEY_EXPRESSION = "constkey=`${w.id.startsWith('custom-')?'custom':w.id}:${w.usageScope||''}:${w.label}`;";
const SWIFT_KEY_EXPRESSION = 'return[normalizedID,window.usageScope??"",window.label].joined(separator:":")';
const sourceOf = path => readFile(new URL(path, import.meta.url), 'utf8');

test('the macOS decode surface survives a response carrying a failure, a reauth login and every analytics field', async t => {
  const account = anthropicAccount('c1');
  const w = await world(t, {
    catalog: {},
    config: { providers: { anthropic: { models: ['claude-opus-5', 'mystery-model'] } } },
    auth: { anthropic: { accounts: [
      { id: 'c1', credential: { accountId: 'phys-c1' } },
      { id: 'c2', credential: { accountId: 'phys-c2' }, needsReauth: true }] } },
    quotaRows: {
      ['anthropic\u0000c1']: { updatedAt: NOW - 60000, weeklyPercent: 40,
        weeklyResetAt: Math.floor((NOW + 10 * HOUR) / 1000),
        customWindows: [{ label: 'Fable', percent: 55, resetAt: Math.floor((NOW + 9 * HOUR) / 1000) }] },
      ['anthropic\u0000c2']: { updatedAt: NOW - 60000, weeklyPercent: 70,
        weeklyResetAt: Math.floor((NOW + 9 * HOUR) / 1000) },
    },
    usage: [call('unpriced', { provider: account, model: 'mystery-model', at: NOW - HOUR })],
  });
  await w.collector.collect();
  await w.advance(6 * 60000);
  await rename(join(w.home, 'usage.jsonl'), join(w.home, 'usage.moved'));
  await w.collector.collect();
  const body = await w.body();
  assert.equal(body.analytics.status, 'error');

  const decoded = acceptSnapshot(body);
  assert.equal(decoded.providers[0].accounts.length, 2);
  // The reauth account and its window both decode; the client decides what to do with them.
  assert.equal(decoded.providers[0].accounts[1].status, 'reauth');
  assert.equal(decoded.providers[0].accounts[0].windows[1].usageScope, 'fable');

  // A new analytics field cannot change what an old client reads: strip analytics entirely
  // and the same bytes still decode to the same account and window shape.
  const stripped = JSON.parse(JSON.stringify(body));
  delete stripped.analytics;
  for (const provider of stripped.providers) {
    delete provider.analytics;
    for (const item of provider.accounts) {
      delete item.analytics;
      for (const window of item.windows) delete window.analytics;
    }
  }
  assert.deepEqual(acceptSnapshot(stripped), decoded);

  // The negatives. A missing required field is a decode failure, an absent or null optional
  // is not, and a version this client does not speak is refused rather than rendered.
  const without = path => {
    const copy = JSON.parse(JSON.stringify(body));
    path(copy);
    return copy;
  };
  assert.throws(() => acceptSnapshot(without(c => { delete c.providers[0].accounts[0].status; })), /status/);
  assert.throws(() => acceptSnapshot(without(c => { delete c.providers[0].enabled; })), /enabled/);
  assert.throws(() => acceptSnapshot(without(c => { c.providers[0].accounts[0].windows = null; })), /windows/);
  assert.throws(() => acceptSnapshot(without(c => { c.schemaVersion = 2; })), /schemaVersion/);
  assert.throws(() => acceptSnapshot(without(c => { c.schemaVersion = 1.5; })), /schemaVersion/);
  assert.doesNotThrow(() => acceptSnapshot(without(c => {
    c.providers[0].accounts[0].plan = null;
    c.providers[0].accounts[0].windows[0].stale = null;
    delete c.providers[0].accounts[0].windows[0].resetAt;
  })));
});

test('the transcribed Swift model is checked against the Swift source, so a drifting field fails here first', async () => {
  const source = await sourceOf('../macos/Sources/QuotaModel.swift');
  const extract = text => {
    const found = {};
    for (const [, name, body] of text.matchAll(/struct\s+(\w+)\s*:\s*Decodable[^{]*\{([\s\S]*?)\n\}/g)) {
      const fields = {};
      for (const [, field, type] of body.matchAll(/^\s{4}let\s+(\w+):\s*([^\n=]+?)\s*$/gm)) {
        fields[field] = [type.replace(/\?$/, ''), type.endsWith('?')];
      }
      found[name] = fields;
    }
    return found;
  };
  const extracted = extract(source);
  // Guard the guard: an extraction that silently found nothing would make the comparison
  // below vacuous, and a reformatted Swift file can do exactly that.
  assert.deepEqual(Object.keys(extracted).sort(),
    ['QuotaAccount', 'QuotaProvider', 'QuotaSnapshot', 'QuotaWindow']);
  for (const [name, fields] of Object.entries(extracted)) {
    assert.ok(Object.keys(fields).length > 0, name);
  }
  // The hand-written table above is the other side. Deriving both from the same extraction
  // would compare the source with itself.
  assert.deepEqual(extracted, SWIFT_MODEL);
  // And the comparison bites: drop one field from the extracted copy and it must disagree.
  const drifted = JSON.parse(JSON.stringify(extracted));
  delete drifted.QuotaWindow.usageScope;
  assert.notDeepEqual(drifted, SWIFT_MODEL);
});

test('the saved menu-bar selection key is the one both the web view and the Swift panel build', async () => {
  const views = await sourceOf('../public/views.js');
  const model = await sourceOf('../macos/Sources/QuotaModel.swift');
  const store = await sourceOf('../macos/Sources/QuotaStore.swift');
  // Checking that the three parts are present is not enough: swapping two of them keeps
  // every part and still changes every saved key. Order is the contract.
  const ordered = (line, parts) => {
    const at = parts.map(part => line.indexOf(part));
    return at.every(index => index !== -1) && at.every((index, i) => i === 0 || at[i - 1] < index);
  };
  const keyLine = views.split('\n').find(line => line.includes('startsWith(') && line.includes('usageScope'));
  assert.ok(keyLine, 'public/views.js must still build the group key');
  assert.ok(ordered(keyLine, ['custom-', 'usageScope', '.label']), keyLine);
  // Two colons between the three parts, so the separator cannot quietly change either.
  assert.equal(keyLine.split('}:$' + '{').length - 1, 2, keyLine);
  // The counterexample, kept resident: reorder only, and the same check must refuse it.
  const swapped = keyLine.replace('usageScope', 'ZZLABEL').replace('.label', 'usageScope').replace('ZZLABEL', '.label');
  assert.equal(ordered(swapped, ['custom-', 'usageScope', '.label']), false);
  // Order is necessary but not sufficient: renaming the normalised value keeps every part
  // in place and still changes every saved key, so the whole expression is compared.
  assert.equal(squash(keyLine), WEB_KEY_EXPRESSION);
  assert.notEqual(squash(keyLine.replace("'custom'", "'custom-x'")), WEB_KEY_EXPRESSION);

  const swiftLine = model.split('\n').find(line => line.includes('joined(separator:'));
  assert.ok(ordered(swiftLine, ['normalizedID', 'usageScope', 'window.label']), swiftLine);
  assert.ok(swiftLine.includes('joined(separator: ":")'), swiftLine);
  assert.ok(model.includes('hasPrefix("custom-") ? "custom"'));
  assert.equal(squash(swiftLine), SWIFT_KEY_EXPRESSION);
  // The provider is joined to the group with a slash at BOTH sites: the one that matches a
  // saved pin and the one that writes the default. Asking whether the text appears anywhere
  // lets one of them drift while the other keeps this assertion green.
  const composition = '\\(provider.id)/\\(group.id)';
  assert.equal(store.split(composition).length - 1, 2, store);
  assert.notEqual(store.replace(composition, '\\(provider.id):\\(group.id)')
    .split(composition).length - 1, 2);
  assert.equal(store.split('forKey: "pinnedQuota"').length - 1, 2, store);

  // The keys a real response actually produces.
  assert.equal(pinKey('anthropic', { id: 'weekly', label: '전체 주간', usageScope: 'all' }),
    'anthropic/weekly:all:전체 주간');
  assert.equal(pinKey('anthropic', { id: 'custom-0', label: 'Fable 주간', usageScope: 'fable' }),
    'anthropic/custom:fable:Fable 주간');
  // A custom window keeps its key wherever it lands in the list: that is what normalising
  // the index is for.
  assert.equal(pinKey('cursor', { id: 'custom-0', label: 'API usage' }),
    pinKey('cursor', { id: 'custom-3', label: 'API usage' }));
  // Scope is part of the identity, so changing it is a different limit.
  assert.notEqual(pinKey('anthropic', { id: 'weekly', label: '주간', usageScope: 'all' }),
    pinKey('anthropic', { id: 'weekly', label: '주간', usageScope: 'fable' }));
});

test('every dashboard fixture variant is also a response the macOS client would decode', async () => {
  const { buildFixture, FIXTURE_VARIANTS } = await import('../scripts/ui-fixture.mjs');
  assert.ok(FIXTURE_VARIANTS.length >= 6);
  for (const variant of FIXTURE_VARIANTS) {
    const body = JSON.parse(JSON.stringify(buildFixture(variant)));
    assert.doesNotThrow(() => acceptSnapshot(body), variant);
    // Every saved key the fixture can produce is well formed, so the screen check and the
    // panel are describing one set of limits rather than two.
    for (const provider of body.providers) {
      for (const account of provider.accounts) {
        for (const window of account.windows) {
          assert.match(pinKey(provider.id, window), /^[^/]+\/[^:]*:[^:]*:.+$/, `${variant} ${window.id}`);
        }
      }
    }
  }
  // Both clients hide the same windows. Compared as source text, because public/app.js runs
  // matchMedia at module scope and cannot be imported here.
  const app = await sourceOf('../public/app.js');
  const model = await sourceOf('../macos/Sources/QuotaModel.swift');
  assert.ok(app.includes('/\\bspark\\b/i'), 'the web dashboard must still hide spark windows');
  assert.ok(model.includes('"\\\\bspark\\\\b"'), 'the panel must still hide spark windows');
  assert.ok(model.includes('caseInsensitive'));
});

test('a response mixing priced, unpriced and empty periods crosses HTTP into the browser helpers it already had', async t => {
  const { createApp } = await import('../src/server.mjs');
  const { usageAmount, usageNote, periodState } = await import('../public/quota.js');
  const account = anthropicAccount('c1');
  const w = await world(t, {
    catalog: { anthropic: { models: { 'claude-opus-5': { cost: { input: 2, output: 4 } } } } },
    config: { providers: { anthropic: { models: ['claude-opus-5', 'mystery-model'] } } },
    auth: { anthropic: { accounts: [{ id: 'c1', credential: { accountId: 'phys-c1' } }] } },
    // One period holds nothing, one holds only an unconfirmed price, one holds both.
    usage: [call('unpriced', { provider: account, model: 'mystery-model', at: NOW - 3 * HOUR }),
      call('priced', { provider: account, model: 'claude-opus-5', at: NOW - 40 * HOUR })],
  });
  await w.collector.collect();
  const served = await w.body();
  const app = createApp({ port: 0, snapshot: async () => served });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/v1/snapshot`);
  assert.equal(response.status, 200);
  const body = await response.json();

  // The bytes a client actually receives decode under the transcribed Swift rules.
  assert.equal(acceptSnapshot(body).schemaVersion, 1);
  // And the browser code this product already ships reads the same bytes. This is the real
  // consumer, imported and executed -- though in Node, not in a browser.
  const periods = body.providers[0].accounts[0].analytics.periods;
  assert.equal(usageNote(periods.oneHour), '호출 없음');
  assert.equal(usageAmount(periods.oneHour), '—');
  assert.equal(usageNote(periods.fiveHour), '단가 미확인');
  assert.equal(usageAmount(periods.fiveHour), '—');
  assert.equal(usageNote(periods.weekly), '일부');
  // claude-opus-5 is priced by the built-in table, which outranks the local catalog:
  // 1000 input at $5/M plus 100 output at $25/M.
  assert.equal(usageAmount(periods.weekly), '$0.0075');
  // All five keys are supported by the browser projection, and it reads the same amounts.
  for (const key of KEYS) {
    const state = periodState(periods, key);
    assert.notEqual(state.state, 'unsupported', key);
    assert.equal(state.amount, usageAmount(periods[key]), key);
  }
  assert.equal(periodState(periods, 'unknownPeriod').state, 'unsupported');
  // freshWindow is deliberately not exercised here: tests/server.test.mjs:61 already owns it,
  // and it reads the real clock, which would put a wall-clock dependency in a pinned world.
});

// --- JUN-225: 요약의 최근 7일 쿼타 소모 ---
// 판정 규칙만 겨냥한다. 화면 검사는 fixture 가 만들어 낼 수 있는 상태만 볼 수 있는데, 이 규칙에는
// fixture 에 없는 갈래가 있고 하필 그것들이 완료 기준을 지키는 자리다.
test('the summary quota figure picks one provider-wide limit, sums only what was measured, and never turns silence into zero', async () => {
  const { weeklyQuotaUsage } = await import('../public/quota.js');
  const win = (id, label, analytics) => ({ id, label, usedPercent: 50, remainingPercent: 50, analytics });
  const forecast = (deltaPp, extra = {}) => ({ providerWide: true, forecastDeltaPp: deltaPp,
    forecastObservedHours: 168, forecastSpanHours: 168, forecastCoverage: 1, ...extra });
  const provider = (...accounts) => ({ accounts: accounts.map((windows, i) => ({ id: 'a' + i, windows })) });
  const unwatched = { forecastObservedHours: 0, forecastSpanHours: 0, forecastCoverage: null };

  // 제공자 전체를 재는 주간·월간 창이 하나도 없으면 미지원이다. 모델별 창을 대신 쓰지 않는다.
  const scoped = weeklyQuotaUsage(provider([win('custom-0', 'Fable 주간', forecast(40, { providerWide: false }))]));
  assert.equal(scoped.state, 'unsupported');
  assert.equal(scoped.windowId, null);
  assert.match(scoped.title, /주간·월간 한도 창이 없어/);
  // 5시간 창도 대표값이 되지 않는다. 7일 안에 서른 번 넘게 리셋되어 단위가 달라진다.
  assert.equal(weeklyQuotaUsage(provider([win('five-hour', '5시간', forecast(345))])).state, 'unsupported');

  // 주간이 있으면 주간, 없으면 월간. 고른 창의 이름이 문구에 남아 분모가 드러난다.
  const both = weeklyQuotaUsage(provider([win('monthly', '월간', forecast(3)), win('weekly', '전체 주간', forecast(42))]));
  assert.equal(both.windowId, 'weekly');
  assert.equal(both.value, '≈ 42%p');
  assert.match(both.note, /전체 주간/);
  assert.equal(weeklyQuotaUsage(provider([win('monthly', '월간', forecast(3))])).windowId, 'monthly');

  // 같은 종류의 한도에서 관측한 계정 소모를 합산한다.
  const two = weeklyQuotaUsage(provider([win('weekly', '주간', forecast(10))], [win('weekly', '주간', forecast(30))]));
  assert.equal(two.value, '≈ 40%p');
  assert.equal(two.state, 'measured');
  assert.match(two.note, /2\/2계정/);

  // 한 계정의 측정된 0 과 다른 계정의 미관측이 만나도 결과는 확정 0 이 아니다. 값 없는 계정을
  // 분모에서 빼고, 뺐다는 사실을 n/m 이 적는다.
  const mixed = weeklyQuotaUsage(provider([win('weekly', '주간', forecast(0))],
    [win('weekly', '주간', forecast(null, unwatched))]));
  assert.equal(mixed.state, 'partial');
  assert.equal(mixed.value, '≈ 0%p');
  assert.match(mixed.note, /1\/2계정/);

  // 아무 계정도 값이 없으면 미관측이고, 0 이 아니라는 문장을 들고 있다.
  const silent = weeklyQuotaUsage(provider([win('weekly', '주간', forecast(null, unwatched))]));
  assert.equal(silent.state, 'unobserved');
  assert.equal(silent.value, '미관측');
  assert.match(silent.note, /0\/1계정/);
  assert.match(silent.title, /사용량이 0이라는 뜻이 아닙니다/);

  // measured 는 전부 관측됐고 7일을 덮었을 때뿐이다. 모자란 이유는 문구에 남는다.
  const short = weeklyQuotaUsage(provider([win('weekly', '주간', forecast(12, { forecastSpanHours: 72 }))]));
  assert.equal(short.state, 'partial');
  assert.match(short.note, /기록 3\/7일/);
  const thin = weeklyQuotaUsage(provider([win('weekly', '주간', forecast(12, { forecastCoverage: 0.5 }))]));
  assert.equal(thin.state, 'partial');
  assert.match(thin.note, /관측 50%/);
  // 이 한도를 아예 갖지 않은 계정이 있는 것도 전부를 말하지 못하는 이유다.
  const missing = weeklyQuotaUsage(provider([win('weekly', '주간', forecast(12))], []));
  assert.equal(missing.state, 'partial');
  assert.match(missing.title, /제공자 계정 2개 중/);

  // 측정된 0 도 추정이다. 20 → 19.5 → 20 이 0 을 내므로 0 에도 ≈ 가 붙는다.
  assert.equal(weeklyQuotaUsage(provider([win('weekly', '주간', forecast(0))])).value, '≈ 0%p');
});

test('the quota figure holds its week boundary and tells an undeclared scope apart from a missing limit', async () => {
  const { weeklyQuotaUsage } = await import('../public/quota.js');
  const win = (id, label, analytics) => ({ id, label, usedPercent: 50, remainingPercent: 50, analytics });
  const forecast = (deltaPp, extra = {}) => ({ providerWide: true, forecastDeltaPp: deltaPp,
    forecastObservedHours: 168, forecastSpanHours: 168, forecastCoverage: 1, ...extra });
  const one = (analytics, extra = []) => ({ accounts: [{ id: 'a0', windows: [win('weekly', '주간', analytics)] }, ...extra] });

  // 167시간은 7일이 아니다. 한 시간을 봐주면 딱 그만큼이 확정으로 올라간다.
  for (const forecastSpanHours of [166.9, 167, 167.9]) {
    const nearly = weeklyQuotaUsage(one(forecast(12, { forecastSpanHours })));
    assert.equal(nearly.state, "partial", forecastSpanHours + " hours is not a week");
    assert.doesNotMatch(nearly.note, /기록 7\/7일/, forecastSpanHours + " hours must not print as a full week");
  }
  assert.equal(weeklyQuotaUsage(one(forecast(12))).state, 'measured');
  // 내림으로 적는다. 166.99시간이 반올림으로 7일이 되면 모자란 기록이 꽉 찬 것처럼 보인다.
  assert.match(weeklyQuotaUsage(one(forecast(12, { forecastSpanHours: 166.99 }))).note, /기록 6\.9\/7일/);

  // 범위를 말해 주지 않은 응답은 한도가 없는 것과 다른 사실이다. 새 필드를 아직 내보내지 않는
  // 서버에 대고 화면이 한도 창이 없다고 말하면 그것은 거짓이다.
  const old = weeklyQuotaUsage(one({ forecastDeltaPp: 12, forecastObservedHours: 168,
    forecastSpanHours: 168, forecastCoverage: 1 }));
  assert.equal(old.state, 'unknown-scope');
  assert.equal(old.value, '범위 확인 불가');
  assert.match(old.title, /사용량이 0이라는 뜻이 아닙니다/);
  assert.equal(weeklyQuotaUsage({ accounts: [{ windows: [{ id: "weekly", label: "주간" }] }] }).state, "unknown-scope");
  // 창을 보고했는데 그중에 주간·월간이 없을 때만 미지원이다.
  assert.equal(weeklyQuotaUsage({ accounts: [{ id: "a0",
    windows: [win("five-hour", "5시간", forecast(9))] }] }).state, "unsupported");
  // 창 목록 자체를 못 읽었으면 한도가 없다는 근거가 없다. src/snapshot.mjs:205 가 그런 계정에
  // status 'unavailable' 과 빈 목록을 준다. 그것을 미지원이라고 적으면 조회 실패가 구성 사실이 된다.
  const blind = weeklyQuotaUsage({ accounts: [{ id: "a0", status: "unavailable", windows: [] }] });
  assert.equal(blind.state, "unobserved");
  assert.equal(blind.value, "미관측");
  assert.match(blind.title, /한도가 있는지도 확인할 수 없습니다/);
  assert.equal(weeklyQuotaUsage({ accounts: [] }).state, 'unsupported');
  assert.equal(weeklyQuotaUsage(undefined).state, 'unsupported');

  // 이 한도를 들지 않은 계정이 있다는 사실은 보이는 문구가 말한다. title 에만 두면 1/1계정 이
  // 제공자 전부를 관측한 것처럼 읽힌다. 그리고 그 계정이 두 부류라는 것도 글자가 갈라 적는다.
  const absent = weeklyQuotaUsage(one(forecast(12),
    [{ id: "a1", windows: [win("five-hour", "5시간", forecast(9))] }]));
  assert.equal(absent.state, "partial");
  assert.match(absent.note, /1\/1계정 · 한도 없음 1/);
  assert.match(absent.title, /이 한도가 없는 계정 1개/);
  const unreadable = weeklyQuotaUsage(one(forecast(12), [{ id: "a1", status: "unavailable", windows: [] }]));
  assert.equal(unreadable.state, "partial");
  assert.match(unreadable.note, /1\/1계정 · 조회 불가 1/);
  assert.match(unreadable.title, /쿼타를 읽지 못한 계정 1개/);
  assert.doesNotMatch(unreadable.note, /한도 없음/);

  // 이레를 4분 간격으로 빠짐없이 관측해도 구간을 더한 비율은 1 에 닿지 못할 수 있다. 그 잔차를
  // 관측 부족이라고 부르면 화면이 `관측 100%` 를 적으면서 상태는 partial 이라고 말하게 된다.
  const residue = weeklyQuotaUsage(one(forecast(12, { forecastCoverage: 1 - 3e-14 })));
  assert.equal(residue.state, 'measured');
  assert.doesNotMatch(residue.note, /관측/);
  // 실제로 빠진 시간은 그대로 잡힌다.
  assert.equal(weeklyQuotaUsage(one(forecast(12, { forecastCoverage: 0.999 }))).state, 'partial');
  // 그리고 그 사실이 문구에서도 살아남아야 한다. 이레 중 4분이 빠지면 커버리지는 0.9996 인데
  // 한 자리로 반올림하면 '관측 100%' 가 되어 partial 상태와 정면으로 어긋난다.
  const nearFull = weeklyQuotaUsage(one(forecast(12, { forecastCoverage: 0.9996 })));
  assert.equal(nearFull.state, "partial");
  assert.doesNotMatch(nearFull.note, /관측 100%/);
  assert.match(nearFull.note, /관측 99\.96%/);
  // 두 자리로도 100 이 되는 값은 100 이라고 적지 않는다.
  assert.match(weeklyQuotaUsage(one(forecast(12, { forecastCoverage: 0.99999 }))).note, /관측 <100%/);
});

test('selected quota periods never substitute weekly consumption for unknown short history',async()=>{
 const {weeklyQuotaUsage}=await import('../public/quota.js');
 const analytics={providerWide:true,forecastDeltaPp:80,forecastSpanHours:168,forecastCoverage:1};
 const p={accounts:[{windows:[{id:'weekly',label:'주간',analytics}]}]};
 assert.equal(weeklyQuotaUsage(p,'oneHour').state,'unobserved');
 assert.equal(weeklyQuotaUsage(p,'weekly').value,'≈ 80%p');
 analytics.consumptionPeriods={oneHour:{deltaPp:0,spanHours:1,coverage:1},weekly:{deltaPp:null}};
 assert.equal(weeklyQuotaUsage(p,'oneHour').value,'≈ 0%p');
 assert.equal(weeklyQuotaUsage(p,'weekly').state,'unobserved');
 assert.match(weeklyQuotaUsage(p,'oneHour').title,/최근 1시간/);
});

test('retained consumption tooltip identifies recovery without claiming continuous observation', async () => {
 const {weeklyQuotaUsage}=await import('../public/quota.js');
 const sample={deltaPp:15,observedHours:0,spanHours:2,coverage:0,recoveredDeltaPp:15,recoveredHours:2};
 const p={accounts:[{status:'stale',windows:[{id:'weekly',label:'주간',stale:true,
  analytics:{providerWide:true,consumptionPeriods:{twentyFourHour:sample}}}]}]};
 const r=weeklyQuotaUsage(p,'twentyFourHour');
 assert.equal(r.value,'≈ 15%p'); assert.equal(r.state,'partial');
 assert.match(r.title,/공백 복원 15%p 포함/);assert.match(r.title,/스냅샷 시각 기준 최근 24시간/);
 assert.match(r.title,/복원 시간은 제외/);assert.doesNotMatch(r.title,/마지막 관측에서 거꾸로/);
 sample.deltaPp=0;sample.recoveredDeltaPp=0;
 assert.match(weeklyQuotaUsage(p,'twentyFourHour').title,/공백 복원 0%p 포함/);
});
