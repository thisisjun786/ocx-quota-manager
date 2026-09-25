import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHistory } from '../src/history.mjs';

const NOW = Date.parse('2026-09-15T00:00:00Z');
const FROM = Date.parse('2026-09-10T00:00:00Z');
const IDENTITIES = { labels: new Map() };
const DAY = 86400000;

const entry = (requestId, timestamp, row = {}) => JSON.stringify({
  timestamp, requestId,
  attempts: [{ provider: 'anthropic', model: 'claude-x',
    usage: { inputTokens: 1e6, outputTokens: 0, cacheCreationInputTokens: 1e6, totalTokens: 1e6 }, ...row }],
});

// Base USD stays the 5m amount; the sidecar carries the 1h alternative.
const priced = (usd, claudeCache, revision) => Object.assign(
  () => ({ usd, basis: 'official', ...(claudeCache ? { claudeCache } : {}) }),
  { revision });

const COEFF = { fiveMinuteUsd: 6.25, oneHourUsd: 10, cacheWriteTokens: 1_000_000 };

const valued = h => h.db.prepare('SELECT sum(usd) s, sum(noCacheUsd) n FROM usage_valued').get();
const raw = h => h.db.prepare('SELECT sum(usd) s, count(*) c FROM usage').get();
const sidecars = h => h.db.prepare('SELECT count(*) c FROM claude_cache_costs').get().c;

async function fixture(t, lines) {
  const dir = await mkdtemp(join(tmpdir(), 'quota-claude-'));
  const file = join(dir, 'log.jsonl');
  await writeFile(file, lines.map(l => l + '\n').join(''));
  const state = join(dir, 'state');
  const h = await openHistory(state);
  t.after(async (t) => { try { h.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  return { h, file, state };
}

test('claudeCacheAssumption switches only the view between 5m and 1h amounts', async (t) => {
  const { h, file } = await fixture(t, [entry('a', FROM - 1000), entry('b', FROM)]);
  await h.ingest(file, IDENTITIES, priced(6.25, COEFF, 'r1'), NOW);
  assert.equal(sidecars(h), 2);
  assert.equal(valued(h).s, 12.5);

  h.set('claudeCacheAssumption', { ttl: '1h', from: FROM, basis: 'user-assumption' });
  const on = valued(h);
  assert.equal(on.s, 16.25); // the row before `from` keeps 6.25, the row at `from` gets 10
  assert.equal(on.n, 16.25); // noCacheUsd reflects the same effective amount
  assert.equal(raw(h).s, 12.5); // stored USD is untouched

  h.set('claudeCacheAssumption', null);
  assert.equal(valued(h).s, 12.5);

  h.set('claudeCacheAssumption', { ttl: '5m', from: FROM, basis: 'user-assumption' });
  assert.equal(valued(h).s, 12.5);
  h.set('claudeCacheAssumption', { ttl: '1h', from: 'soon', basis: 'user-assumption' });
  assert.equal(valued(h).s, 12.5);
  h.close();
});

test('a pricing replay backfills coefficients without changing stored rows', async (t) => {
  const { h, file, state } = await fixture(t, [entry('a', FROM), entry('b', FROM + 1000)]);
  await h.ingest(file, IDENTITIES, priced(6.25, null, 'a'), NOW);
  assert.equal(sidecars(h), 0);
  assert.equal(raw(h).s, 12.5);

  await h.ingest(file, IDENTITIES, priced(6.25, COEFF, 'b'), NOW);
  assert.equal(sidecars(h), 2);
  assert.equal(raw(h).s, 12.5);
  h.set('claudeCacheAssumption', { ttl: '1h', from: FROM, basis: 'user-assumption' });
  assert.equal(valued(h).s, 20);

  await h.ingest(file, IDENTITIES, priced(6.25, COEFF, 'b'), NOW);
  assert.equal(sidecars(h), 2);
  h.close();

  const h2 = await openHistory(state);
  assert.equal(sidecars(h2), 2);
  assert.equal(valued(h2).s, 20);
  h2.close();
});

test('coefficients never attach to a row whose stored values do not match', async (t) => {
  const { h, file } = await fixture(t, [entry('a', FROM)]);
  await h.ingest(file, IDENTITIES, priced(6.25, { ...COEFF, fiveMinuteUsd: 7 }, 'r1'), NOW);
  assert.equal(sidecars(h), 0);
  h.close();

  const f2 = await fixture(t, [entry('a', FROM)]);
  await f2.h.ingest(f2.file, IDENTITIES, priced(null, COEFF, 'r1'), NOW);
  assert.equal(sidecars(f2.h), 0);
  f2.h.close();

  const f3 = await fixture(t, [entry('a', FROM)]);
  await f3.h.ingest(f3.file, IDENTITIES, priced(6.25, null, 'a'), NOW);
  f3.h.db.prepare("UPDATE usage SET model='claude-y', tokens=9999").run();
  await f3.h.ingest(f3.file, IDENTITIES, priced(6.25, COEFF, 'b'), NOW);
  assert.equal(sidecars(f3.h), 0);
  f3.h.close();
});

test('malformed coefficient sets are rejected at ingestion', async (t) => {
  for (const bad of [
    { ...COEFF, oneHourUsd: 5 },              // 1h cheaper than 5m
    { ...COEFF, oneHourUsd: -1 },             // negative amount
    { ...COEFF, fiveMinuteUsd: 0 },           // no 5m amount to match against
    { ...COEFF, fiveMinuteUsd: NaN },
    { ...COEFF, oneHourUsd: Infinity },
    { ...COEFF, cacheWriteTokens: 0 },        // no tokens the price applies to
    { ...COEFF, cacheWriteTokens: -100 },
  ]) {
    const { h, file } = await fixture(t, [entry('a', FROM)]);
    await h.ingest(file, IDENTITIES, priced(6.25, bad, 'r1'), NOW);
    assert.equal(sidecars(h), 0, JSON.stringify(bad));
    h.close();
  }
});

test('historyResetAt excludes old records and retention deletes the sidecar with its row', async (t) => {
  const { h, file } = await fixture(t, [entry('old', FROM - DAY), entry('new', FROM)]);
  h.set('historyResetAt', FROM - 1000);
  await h.ingest(file, IDENTITIES, priced(6.25, COEFF, 'r1'), NOW);
  assert.equal(raw(h).c, 1);
  assert.equal(sidecars(h), 1);

  h.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('stale', NOW - 100 * DAY, 'anthropic', null, 'claude-x', 1, 1, 0, 2, 6.25, 'official');
  h.db.prepare('INSERT INTO claude_cache_costs VALUES (?,?,?,?)').run('stale', 6.25, 10, 1e6);
  h.maintain(NOW);
  assert.equal(h.db.prepare("SELECT count(*) c FROM usage WHERE id='stale'").get().c, 0);
  assert.equal(h.db.prepare("SELECT count(*) c FROM claude_cache_costs WHERE id='stale'").get().c, 0);
  assert.equal(sidecars(h), 1);
  h.close();
});
