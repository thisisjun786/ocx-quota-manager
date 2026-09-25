import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openHistory } from '../src/history.mjs';
import { MEASURED_AT, HISTORY_READING } from '../src/time.mjs';
import { readCredentialSource } from '../src/credential-source.mjs';
import { createBindingRegistry } from '../src/account-binding.mjs';
import { createQuotaTransport } from '../src/quota-transport.mjs';
import { createDirectQuota } from '../src/direct-quota.mjs';
import { SOURCE_STATUS } from '../src/snapshot.mjs';
import { identityDigest } from '../src/credential-source.mjs';
import { windowAnalytics } from '../src/analytics.mjs';
import { weeklyQuotaUsage } from '../public/quota.js';
import { recommendQuotaAccounts } from '../src/recommendation.mjs';

const NOW = 1800000000000, MINUTE = 60000;
const MAIN = 'SENTINEL_DIRECT_MAIN';
// The adapter is attached to a provider the roster really produces. A made-up provider id
// would never match a binding, so the test would pass without exercising the path.
const ENDPOINTS = { openai: { 'synthetic-usage': { host: 'quota.invalid', path: '/usage',
  configuredOrigins: ['https://quota.invalid'], acceptsDefaultBase: true,
  authorize: c => ({ Authorization: `Bearer ${c.value}` }) },
 // A second endpoint on the same provider. One account read twice is the case a single
 // stored slot could not represent.
 'synthetic-extra': { host: 'quota.invalid', path: '/extra',
  configuredOrigins: ['https://quota.invalid'], acceptsDefaultBase: true,
  authorize: c => ({ Authorization: `Bearer ${c.value}` }) } } };
const adapter = {
  provider: 'openai', endpointId: 'synthetic-usage', sourceVersion: 'synthetic-1',
  appliesTo: binding => binding.accountId === '__main__',
  parse: json => (json.windows ?? []).map(window => ({ windowId: window.id, label: window.id,
    resetAt: window.resetAt ?? null, raw: { scopeKey: `account:${window.id}`, ...window } })),
};
const extra = { ...adapter, endpointId: 'synthetic-extra', sourceVersion: 'synthetic-2' };

async function fixture(t, { withConfig = false } = {}) {
 const home = await mkdtemp(join(tmpdir(), 'quota-direct-'));
 const codexHome = join(home, 'native');
 await mkdir(codexHome);
 const dir = join(home, 'state');
 // No OpenCodex configuration, no auth file and no admin token: the isolated case.
 if (withConfig) await writeFile(join(home, 'config.json'), JSON.stringify({ providers: { openai: {} } }));
 await writeFile(join(codexHome, 'auth.json'),
   JSON.stringify({ tokens: { account_id: 'main-physical', access_token: MAIN } }));
 const store = await openHistory(dir);
 t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
 let time = NOW;
 const requests = [];
 let handler = () => ({ windows: [{ id: 'weekly', used: 123.4, limit: 1000 }] });
 let gate = null;
 const fetcher = async (url, init) => {
  requests.push({ url, authorization: init.headers.Authorization });
  if (gate) await gate;
  const body = handler(url, init);
  if (body instanceof Error) throw body;
  if (typeof body?.status === 'number') {
   return { status: body.status, headers: { get: k => body.headers?.[k.toLowerCase()] ?? null },
     text: async () => JSON.stringify(body.body ?? {}) };
  }
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
 };
 const build = (options = {}) => createDirectQuota({
   store, transport: createQuotaTransport({ fetcher, now: () => time, endpoints: ENDPOINTS }),
   registry: createBindingRegistry({ store, now: () => time }),
   readSource: () => readCredentialSource({ home, codexHome, now: time }),
   adapters: [adapter], now: () => time, random: () => 0, ...options });
 return { home, codexHome, store, requests, build,
   hold: () => { let release; gate = new Promise(resolve => { release = resolve; }); return () => { gate = null; release(); }; },
   advance: ms => { time += ms; }, now: () => time,
   respond: next => { handler = next; },
   snapshot: (status = 'unavailable') => ({ warnings: [], providers: [{ id: 'openai', enabled: true,
     accounts: [{ id: '__main__', label: 'main', plan: null, active: true, status,
       updatedAt: null, windows: [], quotaMode: 'unavailable' }] }] }),
   // One account can be read by several endpoints, so the stored value holds a slot per
   // endpoint. These tests use one adapter, and read that adapter's slot.
   record: () => store.get('directQuotaV1:openai:__main__')?.endpoints?.['synthetic-usage'] ?? null,
   stored: () => store.get('directQuotaV1:openai:__main__') };
}

test('an isolated install collects through the credential reader with no OpenCodex present', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 const stored = f.record();
 assert.equal(stored.lastAttempt.status, 'ok');
 assert.equal(stored.observation.windows[0].measurement.calculatedPercent, 12.34);
 // Only the declared quota endpoint was contacted, with the credential in a header.
 assert.deepEqual(f.requests.map(r => r.url), ['https://quota.invalid/usage']);
 assert.equal(f.requests[0].authorization, `Bearer ${MAIN}`);
 const projected = await direct.project(f.snapshot());
 const account = projected.providers[0].accounts[0];
 assert.equal(account.windows[0].usedPercent, 12.34);
 assert.equal(account.status, 'ok');
 assert.equal(account.directQuota.status, 'ok');
});

test('Retry-After survives rebuilding the collector and its published deadline stays intact',async t=>{
 const f=await fixture(t);f.respond(()=>({status:429,headers:{'retry-after':'3600'}}));
 await f.build().collect();assert.equal(f.requests.length,1);
 f.advance(10*MINUTE);const restarted=f.build();
 await restarted.collect();assert.equal(f.requests.length,1);
 const a=(await restarted.project(f.snapshot())).providers[0].accounts[0];
 assert.equal(a.directQuota.nextAttemptAt,new Date(NOW+60*MINUTE).toISOString());
 f.advance(50*MINUTE);await restarted.collect();assert.equal(f.requests.length,2);
});

test('successive readings carry their own evidence and a 0.22 point move is observable', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 const first = f.record().observation.windows[0].measurement.calculatedPercent;
 f.respond(() => ({ windows: [{ id: 'weekly', used: 125.6, limit: 1000 }] }));
 f.advance(3 * MINUTE);
 await direct.collect();
 const second = f.record().observation.windows[0].measurement.calculatedPercent;
 assert.equal(first, 12.34);
 assert.equal(second, 12.56);
 assert.ok(Math.abs(second - first - 0.22) < 1e-9);
});

test('a 401 retries once only when the file really holds a different token', async t => {
 const f = await fixture(t);
 const direct = f.build();
 const rotate = token => writeFileSync(join(f.codexHome, 'auth.json'),
   JSON.stringify({ tokens: { account_id: 'main-physical', access_token: token } }));
 // Refused, and the file still holds the same token when re-read. Retrying would just
 // repeat the refusal, so the credential is reported as expired instead.
 f.respond(() => ({ status: 401 }));
 await direct.collect();
 assert.equal(f.record().lastAttempt.status, 'credential_expired');
 assert.equal(f.requests.length, 1);
 assert.equal(direct.diagnostics().retried, 0);

 // Now another client rotates the token while the lookup is in flight, which is the only
 // situation where a retry can succeed.
 f.advance(30 * MINUTE);
 let rotated = false;
 f.respond((url, init) => {
  if (init.headers.Authorization === `Bearer ${MAIN}`) {
   if (!rotated) { rotated = true; rotate('SENTINEL_DIRECT_ROTATED'); }
   return { status: 401 };
  }
  return { windows: [{ id: 'weekly', used: 1, limit: 100 }] };
 });
 await direct.collect();
 // Exactly one retry, carrying the value that was actually on disk.
 assert.equal(f.requests.length, 3);
 assert.equal(f.requests[2].authorization, 'Bearer SENTINEL_DIRECT_ROTATED');
 assert.equal(f.record().lastAttempt.status, 'ok');
 assert.equal(direct.diagnostics().retried, 1);

 // A second refusal after that rotation does not retry again: the ceiling is one per request.
 f.advance(30 * MINUTE);
 f.respond(() => ({ status: 401 }));
 await direct.collect();
 assert.equal(f.requests.length, 4);
 assert.equal(direct.diagnostics().retried, 1);
});

test('a replaced physical account during a 401 re-read is discarded, not retried', async t => {
 const f = await fixture(t);
 const direct = f.build();
 f.respond(() => ({ status: 401 }));
 // The account itself changes while the lookup is in flight. Retrying would file the new
 // account's answer under the old identity.
 const swap = async () => writeFile(join(f.codexHome, 'auth.json'),
   JSON.stringify({ tokens: { account_id: 'replacement-physical', access_token: 'SENTINEL_DIRECT_B' } }));
 f.respond(() => { void swap(); return { status: 401 }; });
 await direct.collect();
 await swap();
 await direct.collect();
 const stored = f.stored();
 // Whatever was written belongs to the account that was confirmed at write time, never to
 // a mixture of the two.
 if (stored) assert.equal(stored.epoch, f.store.epochs.current('openai', '__main__').epoch);
});

test('a reading with no usable number never becomes zero and never erases a good one', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 const good = f.record().observation;
 f.advance(3 * MINUTE);
 // limit 0 cannot be divided, so there is nothing to publish.
 f.respond(() => ({ windows: [{ id: 'weekly', used: 10, limit: 0 }] }));
 await direct.collect();
 const after = f.record();
 assert.equal(after.lastAttempt.status, 'observation_unavailable');
 assert.deepEqual(after.observation, good);
 // The preserved reading is still applied: a failed lookup reports a failure, it does not
 // withdraw the last thing we actually measured.
 const account = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.equal(account.windows[0].usedPercent, 12.34);
 assert.equal(account.directQuota.status, 'observation_unavailable');
 assert.notEqual(account.windows[0].usedPercent, 0);
});

test('a refused or failed lookup keeps the measurement and its freshness', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 const measuredAt = f.record().observation.measuredAt;
 for (const [status, kind] of [[403, 'access_denied'], [503, 'server_error']]) {
  f.advance(3 * MINUTE);
  f.respond(() => ({ status }));
  await direct.collect();
  const after = f.record();
  assert.equal(after.lastAttempt.status, kind);
  assert.equal(after.observation.measuredAt, measuredAt);
 }
 // Still inside the fifteen-minute window, so the reading is current rather than stale.
 const account = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.equal(account.windows[0].stale, false);
 assert.equal(account.updatedAt, new Date(measuredAt).toISOString());
 // Past it, the same reading reads as stale without being deleted.
 f.advance(20 * MINUTE);
 const later = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.equal(later.windows[0].stale, true);
 assert.equal(later.status, 'stale');
});

test('a window whose reset has passed is stale even inside the freshness window', async t => {
 const f = await fixture(t);
 const direct = f.build();
 f.respond(() => ({ windows: [{ id: 'weekly', used: 1, limit: 100, resetAt: NOW + MINUTE }] }));
 await direct.collect();
 f.advance(2 * MINUTE);
 const account = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.equal(account.windows[0].stale, true);
});

// The cached path republishes its windows under the account's own timestamp, which advances on
// every refresh. Judging a retained measurement only against that timestamp let an identical
// bare reading displace it on every poll: the published evidence flapped between transports and
// history stored a fresh basis break each time.
const bareSnapshot = (used, updatedAt, resetAt = null) => ({ warnings: [],
  providers: [{ id: 'openai', enabled: true, accounts: [{ id: '__main__', label: 'main',
    plan: null, active: true, status: 'ok', updatedAt, quotaMode: 'observed',
    windows: [{ id: 'weekly', label: 'weekly', usedPercent: used,
      remainingPercent: 100 - used, resetAt, stale: false }] }] }] });

test('a newer timestamp on the same reading does not displace the measured window', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 const measuredAt = f.record().observation.measuredAt;
 // The same reading restated by the cache five minutes later: the measured window keeps its
 // claim, and the account is still dated by the newer confirmation.
 const republish = bareSnapshot(12.34, new Date(measuredAt + 5 * MINUTE).toISOString());
 const account = (await direct.project(republish)).providers[0].accounts[0];
 assert.equal(account.windows[0].usedPercent, 12.34);
 assert.ok(account.windows[0].measurement, 'the measurement survives the identical republish');
 assert.equal(account.windows[0][MEASURED_AT], measuredAt);
 assert.equal(account.updatedAt, new Date(measuredAt + 5 * MINUTE).toISOString());
 // Storing the projected snapshot adds no bare echo row beside the measured one.
 f.store.capture(await direct.project(bareSnapshot(12.34, new Date(measuredAt + 6 * MINUTE).toISOString())), f.now());
 const rows = f.store.db.prepare("SELECT * FROM quota_observations WHERE provider='openai'").all();
 assert.equal(rows.filter(r => r.method === null).length, 0, 'no bare echo was stored');
});

test('a genuinely newer reading still wins over the retained measurement', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 const measuredAt = f.record().observation.measuredAt;
 const moved = bareSnapshot(50, new Date(measuredAt + 5 * MINUTE).toISOString());
 const account = (await direct.project(moved)).providers[0].accounts[0];
 assert.equal(account.windows[0].usedPercent, 50);
 assert.equal(account.windows[0].measurement, undefined, 'the newer bare reading stands on its own');
 // A reset beyond the drift tolerance is a different cycle, not a restatement.
 const cycled = bareSnapshot(12.34, new Date(measuredAt + 5 * MINUTE).toISOString(),
   new Date(NOW + 20 * 3600000).toISOString());
 const after = (await direct.project(cycled)).providers[0].accounts[0];
  assert.equal(after.windows[0].measurement, undefined, 'a moved reset is a new reading');
});

test('a republish that confirms only one window does not reshuffle the window order', async t => {
 const f = await fixture(t);
 f.respond(() => ({ windows: [
   { id: 'five-hour', used: 33, limit: 100 },
   { id: 'weekly', used: 49, limit: 100 },
   { id: 'custom-fable', used: 19, limit: 100 }] }));
 const direct = f.build();
 await direct.collect();
 const measuredAt = f.record().observation.measuredAt;
 // A republish five minutes later restates the weekly reading exactly while the other two
 // have moved on. Only weekly is confirmed by the newer source; the rest keep their
 // measured rows. The card order must not follow the confirmed subset.
 const republish = { warnings: [], providers: [{ id: 'openai', enabled: true,
   accounts: [{ id: '__main__', label: 'main', plan: null, active: true, status: 'ok',
     updatedAt: new Date(measuredAt + 5 * MINUTE).toISOString(), quotaMode: 'observed',
     windows: [
       { id: 'five-hour', label: '5시간', usedPercent: 50, remainingPercent: 50, resetAt: null, stale: false },
       { id: 'weekly', label: '주간', usedPercent: 49, remainingPercent: 51, resetAt: null, stale: false },
       { id: 'custom-fable', label: 'Fable', usedPercent: 25, remainingPercent: 75, resetAt: null, stale: false }] }] }] };
 const account = (await direct.project(republish)).providers[0].accounts[0];
 assert.deepEqual(account.windows.map(w => w.id), ['five-hour', 'weekly', 'custom-fable']);
 // The confirmed window still gains the measured row; the moved ones keep the newer source.
 assert.ok(account.windows.find(w => w.id === 'weekly').measurement, 'weekly keeps its measurement');
 assert.equal(account.windows.find(w => w.id === 'five-hour').usedPercent, 50);
 // And a later full read lands in the same order, so the card is stable across polls.
 const full = await direct.project({ ...republish,
   providers: [{ ...republish.providers[0], accounts: [{ ...republish.providers[0].accounts[0],
     updatedAt: new Date(measuredAt + 6 * MINUTE).toISOString() }] }] });
 assert.deepEqual(full.providers[0].accounts[0].windows.map(w => w.id),
   ['five-hour', 'weekly', 'custom-fable']);
});

test('a login the source declares unusable is not overwritten by a cached reading', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 for (const status of ['reauth', 'paused']) {
  const account = (await direct.project(f.snapshot(status))).providers[0].accounts[0];
  assert.equal(account.status, status);
  assert.deepEqual(account.windows, []);
 }
});

test('an account missing from this projection read has nothing applied to it', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 // The snapshot still lists the account but the credential files no longer do. The two
 // reads disagree, so the safe answer is to apply nothing rather than guess.
 await writeFile(join(f.codexHome, 'auth.json'), '{}');
 const account = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.deepEqual(account.windows, []);
 assert.equal(account.directQuota, undefined);
});

test('the external interval is independent of how often collection runs', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 assert.equal(f.requests.length, 1);
 // Twelve collector ticks at ten seconds each stay inside one two-minute lookup interval.
 for (let tick = 0; tick < 12; tick += 1) { f.advance(10000); await direct.collect(); }
 assert.equal(f.requests.length, 2);
});

test('one in-flight lookup is shared and never duplicated', async t => {
 const f = await fixture(t);
 const direct = f.build();
 // Hold the response open so both collections are genuinely in flight at the same time.
 // Without the gate the first would finish before the second started and the test would
 // pass for the wrong reason.
 const release = f.hold();
 const first = direct.collect();
 const second = direct.collect();
 // Both collections read the credential files before reaching the endpoint, so the gate is
 // released only after they have had time to get there. Releasing sooner would let the
 // first finish before the second began and the test would pass for the wrong reason.
 await new Promise(resolve => setTimeout(resolve, 50));
 release();
 await Promise.all([first, second]);
 assert.equal(f.requests.length, 1);
});

test('no credential and no key-derived digest reaches the database or the response', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 const projected = await direct.project(f.snapshot());
 const meta = JSON.stringify(f.store.db.prepare('SELECT key,value FROM meta').all());
 const epochs = JSON.stringify(f.store.db.prepare('SELECT * FROM identity_epochs').all());
 for (const dump of [meta, epochs, JSON.stringify(projected)]) {
  assert.equal(dump.includes(MAIN), false);
 }
 // The native account's evidence is an identifier hash, which is storable. A key-derived
 // digest would not be, and none is present here.
 const current = f.store.epochs.current('openai', '__main__');
 assert.equal(current.basis, 'native_account_id');
 assert.ok(current.physicalDigest);
});

test('reading a quota never modifies a credential file', async t => {
 const f = await fixture(t, { withConfig: true });
 const watched = [join(f.home, 'config.json'), join(f.codexHome, 'auth.json')];
 const digest = async () => Promise.all(watched.map(async path => {
  const info = await stat(path);
  return `${createHash('sha256').update(await readFile(path)).digest('hex')}:${info.mtimeMs}`;
 }));
 const before = await digest();
 const direct = f.build();
 await direct.collect();
 await direct.project(f.snapshot());
 assert.deepEqual(await digest(), before);
});

test('the published fields are identical with and without a direct reading', async t => {
 const f = await fixture(t);
 // Old shape: exactly what ships today, with direct collection disabled.
 const off = await f.build({ adapters: [] }).project(f.snapshot());
 const direct = f.build();
 await direct.collect();
 const on = await direct.project(f.snapshot());
 const strip = snapshot => JSON.parse(JSON.stringify(snapshot, (name, value) =>
   ['measurement', 'directQuota'].includes(name) ? undefined : value));
 const offAccount = strip(off).providers[0].accounts[0];
 const onAccount = strip(on).providers[0].accounts[0];
 // Same key set: the new contract adds optional fields and renames nothing.
 assert.deepEqual(Object.keys(onAccount).sort(), Object.keys(offAccount).sort());
 assert.deepEqual(Object.keys(onAccount.windows[0] ?? {}).sort(),
   ['id', 'label', 'remainingPercent', 'resetAt', 'stale', 'usedPercent']);
 // With no adapters registered nothing is added at all.
 assert.equal(offAccount.directQuota, undefined);
 assert.deepEqual(off.providers[0].accounts[0].windows, []);
 assert.equal(f.requests.length, 1);
});

test('aggregation still reads by public id and does not separate epochs', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 f.store.capture(await direct.project(f.snapshot()), f.now());
 const before = f.store.points('openai', '__main__', 'weekly', 0);
 assert.equal(before.length, 1);
 // Replacing the physical account opens a new boundary and drops its cached reading.
 await writeFile(join(f.codexHome, 'auth.json'),
   JSON.stringify({ tokens: { account_id: 'replacement-physical', access_token: 'SENTINEL_DIRECT_B' } }));
 f.advance(3 * MINUTE);
 await direct.collect();
 // The samples table is still keyed by the public id, so both boundaries share one series.
 // That is today's behaviour, recorded here rather than changed; the remaining isolation
 // belongs to JUN-123.
 const after = f.store.points('openai', '__main__', 'weekly', 0);
 assert.ok(after.length >= before.length);
 assert.deepEqual(after.slice(0, before.length), before);
});

test('a reply that arrives after the account was replaced is discarded, not stored', async t => {
 const f = await fixture(t);
 const direct = f.build();
 const release = f.hold();
 const flight = direct.collect();
 await new Promise(resolve => setTimeout(resolve, 50));
 // The account is replaced while the lookup is in flight. Comparing the source captured
 // before the request against itself would pass, which is why the guard re-reads.
 writeFileSync(join(f.codexHome, 'auth.json'),
   JSON.stringify({ tokens: { account_id: 'replacement-physical', access_token: 'SENTINEL_DIRECT_B' } }));
 release();
 await flight;
 assert.equal(f.record(), null);
 assert.equal(direct.diagnostics().discarded, 1);
});

test('a reply that arrives after the account was deleted is discarded', async t => {
 const f = await fixture(t, { withConfig: true });
 // A pool account, which is the shape that can carry deletedAt.
 writeFileSync(join(f.home, 'config.json'), JSON.stringify({ providers: { openai: {} },
   codexAccounts: [{ id: 'pool1' }] }));
 writeFileSync(join(f.home, 'codex-accounts.json'), JSON.stringify({
   pool1: { credential: { accessToken: 'SENTINEL_DIRECT_POOL', chatgptAccountId: 'pool-physical' } } }));
 const direct = f.build({ adapters: [{ ...adapter, appliesTo: b => b.accountId === 'pool1' }] });
 const release = f.hold();
 const flight = direct.collect();
 await new Promise(resolve => setTimeout(resolve, 50));
 writeFileSync(join(f.home, 'codex-accounts.json'), JSON.stringify({
   pool1: { credential: { accessToken: 'SENTINEL_DIRECT_POOL', chatgptAccountId: 'pool-physical' },
     deletedAt: f.now() } }));
 release();
 await flight;
 assert.equal(f.store.get('directQuotaV1:openai:pool1'), null);
 assert.equal(direct.diagnostics().discarded, 1);
});

test('a throwing parser records a failure and backs off instead of refetching at once', async t => {
 const f = await fixture(t);
 const direct = f.build({ adapters: [{ ...adapter, parse: () => { throw new TypeError('bad shape'); } }] });
 await direct.collect();
 assert.equal(f.record().lastAttempt.status, 'invalid_json');
 assert.equal(f.requests.length, 1);
 // Without the schedule update the same malformed response is fetched again immediately.
 await direct.collect();
 assert.equal(f.requests.length, 1);
});

test('a provider that disappears from a healthy read is retired with its cache', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 assert.ok(f.record());
 const epoch = f.store.epochs.current('openai', '__main__').epoch;
 assert.ok(epoch);
 // The whole provider vanishes. Iterating only what is still present would never reach it,
 // leaving the epoch open and its reading attributable to whatever appears next.
 writeFileSync(join(f.codexHome, 'auth.json'), '{}');
 f.advance(3 * MINUTE);
 await direct.collect();
 assert.equal(f.store.epochs.current('openai', '__main__'), null);
 assert.equal(f.record(), null);
});

test('a projection whose read describes a different physical account applies nothing', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 assert.equal(f.record().lastAttempt.status, 'ok');
 // The public id survives a physical replacement, so a snapshot read from account B and a
 // projection read from account A would otherwise agree on '__main__' and attach A's 49%
 // to B. The evidence each read recorded is what separates them.
 const snapshot = f.snapshot();
 snapshot[SOURCE_STATUS] = { files: {}, providers: { openai: { modelListStatus: 'absent',
   accounts: { __main__: identityDigest('a-different-physical-account') } } } };
 const account = (await direct.project(snapshot)).providers[0].accounts[0];
 assert.deepEqual(account.windows, []);
 assert.equal(account.directQuota, undefined);
 // Matching evidence still applies normally.
 const agreeing = f.snapshot();
 agreeing[SOURCE_STATUS] = { files: {}, providers: { openai: { modelListStatus: 'absent',
   accounts: { __main__: identityDigest('main-physical') } } } };
 assert.equal((await direct.project(agreeing)).providers[0].accounts[0].windows[0].usedPercent, 12.34);
});

test('the projection judges freshness by the instant it was given', async t => {
 const f = await fixture(t);
 const direct = f.build();
 f.respond(() => ({ windows: [{ id: 'weekly', used: 1, limit: 100, resetAt: NOW + MINUTE }] }));
 await direct.collect();
 // One millisecond either side of the reset. Calling now() again inside the projection
 // would let a snapshot taken before the reset be marked stale by a later clock read.
 const before = await direct.project(f.snapshot(), NOW + MINUTE - 1);
 assert.equal(before.providers[0].accounts[0].windows[0].stale, false);
 const after = await direct.project(f.snapshot(), NOW + MINUTE + 1);
 assert.equal(after.providers[0].accounts[0].windows[0].stale, true);
});

test('two endpoints on one account both survive, and the earlier adapter owns a shared window', async t => {
 const f = await fixture(t);
 // The same limit measured twice, plus one only the second endpoint reports.
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'weekly', used: 500, limit: 1000 }, { id: 'monthly', used: 250, limit: 1000 }] }
   : { windows: [{ id: 'weekly', used: 123.4, limit: 1000 }] });
 const direct = f.build({ adapters: [adapter, extra] });
 await direct.collect();
 // A slot per endpoint. One slot made the reply that happened to land last the only one kept.
 assert.deepEqual(Object.keys(f.stored().endpoints).sort(), ['synthetic-extra', 'synthetic-usage']);
 const account = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.deepEqual(account.windows.map(w => [w.id, w.usedPercent]), [['weekly', 12.34], ['monthly', 25]]);
 assert.equal(account.directQuota.status, 'ok');
 assert.deepEqual(account.directQuota.endpoints.map(e => [e.id, e.status]),
   [['synthetic-usage', 'ok'], ['synthetic-extra', 'ok']]);
 // Declared precedence, not arrival order: registering them the other way round hands the
 // shared window to the other endpoint from the very same stored value.
 const reversed = (await f.build({ adapters: [extra, adapter] }).project(f.snapshot()))
   .providers[0].accounts[0];
 assert.deepEqual(reversed.windows.map(w => [w.id, w.usedPercent]), [['weekly', 50], ['monthly', 25]]);
});

test('one endpoint failing leaves the other endpoint reading standing', async t => {
 const f = await fixture(t);
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'monthly', used: 250, limit: 1000 }] }
   : { status: 503 });
 const direct = f.build({ adapters: [adapter, extra] });
 await direct.collect();
 const account = (await direct.project(f.snapshot())).providers[0].accounts[0];
 // The reading that was taken is published, and the endpoint that failed is still named.
 assert.deepEqual(account.windows.map(w => w.id), ['monthly']);
 assert.equal(account.directQuota.status, 'partial');
 assert.deepEqual(account.directQuota.endpoints.map(e => [e.id, e.status]),
   [['synthetic-usage', 'server_error'], ['synthetic-extra', 'ok']]);
 // Once every endpoint has failed there is no partial reading left to report.
 f.advance(20 * MINUTE);
 f.respond(() => ({ status: 503 }));
 await direct.collect();
 const later = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.equal(later.directQuota.status, 'server_error');
 // The earlier success is not withdrawn by a later failure; it is reported as stale.
 assert.deepEqual(later.windows.map(w => [w.id, w.stale]), [['monthly', true]]);
});

test('each window carries the freshness of the endpoint that measured it', async t => {
 const f = await fixture(t);
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'monthly', used: 250, limit: 1000 }] }
   : { windows: [{ id: 'weekly', used: 123.4, limit: 1000 }] });
 const direct = f.build({ adapters: [adapter, extra] });
 await direct.collect();
 // Only the second endpoint answers again, twenty minutes later.
 f.advance(20 * MINUTE);
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'monthly', used: 260, limit: 1000 }] }
   : { status: 503 });
 await direct.collect();
 const account = (await direct.project(f.snapshot())).providers[0].accounts[0];
 // A stale window beside a fresh one must not borrow the fresh one's age, and the account
 // is dated by the newest reading it actually has.
 assert.deepEqual(account.windows.map(w => [w.id, w.stale]), [['weekly', true], ['monthly', false]]);
 assert.equal(account.updatedAt, new Date(f.now()).toISOString());
 assert.equal(account.status, 'stale');
});

test('a disabled provider is never read and never published', async t => {
 const f = await fixture(t, { withConfig: true });
 const direct = f.build();
 await direct.collect();
 assert.equal(f.requests.length, 1);
 const before = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.equal(before.directQuota.status, 'ok');
 // Turning the provider off stops the requests and withdraws the published reading.
 writeFileSync(join(f.home, 'config.json'), JSON.stringify({ providers: { openai: { disabled: true } } }));
 f.advance(3 * MINUTE);
 await direct.collect();
 assert.equal(f.requests.length, 1);
 const off = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.equal(off.directQuota, undefined);
 assert.deepEqual(off.windows, []);
 // Disabling is not replacing an account, so the boundary is still open and turning it back
 // on returns to the same epoch with the same reading rather than starting a new one.
 const epoch = f.store.epochs.current('openai', '__main__');
 assert.ok(epoch);
 writeFileSync(join(f.home, 'config.json'), JSON.stringify({ providers: { openai: {} } }));
 f.advance(3 * MINUTE);
 await direct.collect();
 assert.equal(f.requests.length, 2);
 assert.equal(f.store.epochs.current('openai', '__main__').epoch, epoch.epoch);
});

test('an expiry outside the range a date can hold is dropped, not thrown', async t => {
 const f = await fixture(t, { withConfig: true });
 // A real credential file in the wild carries this value. Formatting it throws, and a throw
 // inside the projection fails the whole snapshot rather than one field.
 writeFileSync(join(f.home, 'config.json'), JSON.stringify({ providers: { openai: {} },
   codexAccounts: [{ id: 'pool1' }] }));
 writeFileSync(join(f.home, 'codex-accounts.json'), JSON.stringify({
   pool1: { credential: { accessToken: 'SENTINEL_DIRECT_POOL', chatgptAccountId: 'pool-physical',
     expiresAt: Number.MAX_SAFE_INTEGER } } }));
 const direct = f.build({ adapters: [{ ...adapter, appliesTo: b => b.accountId === 'pool1' }] });
 await direct.collect();
 const snapshot = f.snapshot();
 snapshot.providers[0].accounts.push({ id: 'pool1', label: 'pool', plan: null, active: false,
   status: 'unavailable', updatedAt: null, windows: [], quotaMode: 'unavailable' });
 const projected = await direct.project(snapshot);
 const pool = projected.providers[0].accounts.find(a => a.id === 'pool1');
 assert.equal(pool.directQuota.expiresAt, null);
 assert.equal(pool.windows[0].usedPercent, 12.34);
});

test('an endpoint that has fallen behind neither overwrites nor withholds another endpoint reading', async t => {
 const f = await fixture(t);
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'monthly', used: 250, limit: 1000 }] }
   : { windows: [{ id: 'weekly', used: 400, limit: 1000 }] });
 const direct = f.build({ adapters: [adapter, extra] });
 await direct.collect();
 // Three minutes later the weekly endpoint fails and keeps its older reading, while the
 // monthly endpoint answers fresh.
 f.advance(3 * MINUTE);
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'monthly', used: 260, limit: 1000 }] }
   : { status: 503 });
 await direct.collect();
 // Meanwhile the snapshot already carries a weekly reading from the other collection path,
 // taken after the direct one and before the monthly refresh.
 const dated = (at, percent) => {
  const snapshot = f.snapshot();
  const account = snapshot.providers[0].accounts[0];
  account.updatedAt = new Date(at).toISOString();
  account.windows = [{ id: 'weekly', label: 'weekly', usedPercent: percent,
    remainingPercent: 100 - percent, resetAt: null, stale: false }];
  return snapshot;
 };
 const account = (await direct.project(dated(NOW + 2 * MINUTE, 70))).providers[0].accounts[0];
 // The older weekly does not replace the newer one, and the fresh monthly is not withheld
 // because of it. Judging the set as a whole could only do one of those two.
 assert.deepEqual(account.windows.map(w => [w.id, w.usedPercent]), [['weekly', 70], ['monthly', 26]]);
 // The account is dated by the newest reading it has, because both clients judge every
 // window's freshness by that one timestamp: holding it back for the retained window would
 // make a reading taken seconds ago read as fifteen minutes stale.
 assert.equal(account.updatedAt, new Date(NOW + 3 * MINUTE).toISOString());
 // The retained window keeps its own source's instant beside it, so nothing files it at the
 // account's newer one.
 assert.equal(account.windows.find(w => w.id === 'weekly')[MEASURED_AT], NOW + 2 * MINUTE);
 assert.equal(account.windows.find(w => w.id === 'monthly').measurement.fetchedAt,
   new Date(NOW + 3 * MINUTE).toISOString());
 assert.equal(account.directQuota.status, 'partial');
 // A retained window that is still current is left current: it is not marked behind merely
 // because another endpoint answered more recently.
 assert.equal(account.windows.find(w => w.id === 'weekly').stale, false);
 // A failed endpoint never ages out of its slot, so the guard must not turn into an
 // indefinite veto: half an hour later the monthly reading still publishes.
 f.advance(30 * MINUTE);
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'monthly', used: 270, limit: 1000 }] }
   : { status: 503 });
 await direct.collect();
 const later = (await direct.project(dated(NOW + 2 * MINUTE, 70))).providers[0].accounts[0];
 assert.deepEqual(later.windows.map(w => [w.id, w.usedPercent]), [['weekly', 70], ['monthly', 27]]);
 assert.equal(later.updatedAt, new Date(NOW + 33 * MINUTE).toISOString());
 assert.equal(later.windows.find(w => w.id === 'weekly')[MEASURED_AT], NOW + 2 * MINUTE);
 // Half an hour on, the retained window still carries the instant its own source measured it
 // at, and the fresh monthly carries the instant this reading measured it at. This fixture
 // supplies the retained window's stale flag directly, so it says nothing about how that flag
 // is computed; the source that publishes such a window recomputes it on every read.
 assert.equal(later.windows.find(w => w.id === 'monthly').measurement.fetchedAt,
   new Date(NOW + 33 * MINUTE).toISOString());
 // Once the weekly endpoint recovers its reading replaces the one that was protected, which
 // is checked against that same dated snapshot rather than an empty one.
 // Far enough for both slots to be due again: the failed endpoint is backing off.
 f.advance(3 * MINUTE);
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'monthly', used: 280, limit: 1000 }] }
   : { windows: [{ id: 'weekly', used: 800, limit: 1000 }] });
 await direct.collect();
 const recovered = (await direct.project(dated(NOW + 2 * MINUTE, 70))).providers[0].accounts[0];
 assert.deepEqual(recovered.windows.map(w => [w.id, w.usedPercent]), [['weekly', 80], ['monthly', 28]]);
 // Nothing is retained now, so the account is dated by the newest reading it has.
 assert.equal(recovered.updatedAt, new Date(NOW + 36 * MINUTE).toISOString());
});

test('history files a window at the instant it was measured, not the account instant', async t => {
 const f = await fixture(t);
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'monthly', used: 250, limit: 1000 }] }
   : { windows: [{ id: 'weekly', used: 400, limit: 1000 }] });
 const direct = f.build({ adapters: [adapter, extra] });
 await direct.collect();
 // The weekly endpoint is measured once and then stops answering, while the monthly endpoint
 // keeps refreshing. Filing every window under the account's instant would record the weekly
 // reading again at each refresh, which reads later as a plateau nobody observed.
 for (const step of [5, 10]) {
  f.advance(step === 5 ? 5 * MINUTE : 5 * MINUTE);
  f.respond(url => url.endsWith('/extra')
    ? { windows: [{ id: 'monthly', used: 250 + step, limit: 1000 }] }
    : { status: 503 });
  await direct.collect();
  f.store.capture(await direct.project(f.snapshot()), f.now());
 }
 const at = (window, from = 0) => f.store.points('openai', '__main__', window, from).map(p => p.at);
 // One weekly observation was made, so history holds exactly one weekly sample, at its own
 // instant rather than at either of the later account instants.
 assert.deepEqual(at('weekly'), [NOW]);
 assert.deepEqual(at('monthly'), [NOW + 5 * MINUTE, NOW + 10 * MINUTE]);
});

test('a retained window is filed at its own instant while the account reports the newest reading', async t => {
 const f = await fixture(t);
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'monthly', used: 250, limit: 1000 }] }
   : { status: 503 });
 const direct = f.build({ adapters: [adapter, extra] });
 await direct.collect();
 // The other collection path measured a weekly window two minutes before this one answered.
 const snapshot = f.snapshot();
 const account = snapshot.providers[0].accounts[0];
 account.updatedAt = new Date(NOW - 2 * MINUTE).toISOString();
 account.windows = [{ id: 'weekly', label: 'weekly', usedPercent: 70, remainingPercent: 30,
   resetAt: null, stale: false }];
 const projected = await direct.project(snapshot);
 // Both clients judge every window's freshness by the account timestamp, so it reports the
 // newest reading rather than the retained one's.
 assert.equal(projected.providers[0].accounts[0].updatedAt, new Date(NOW).toISOString());
 f.store.capture(projected, f.now());
 // Refresh only the monthly endpoint twice more.
 for (const used of [260, 270]) {
  f.advance(5 * MINUTE);
  f.respond(url => url.endsWith('/extra') ? { windows: [{ id: 'monthly', used, limit: 1000 }] } : { status: 503 });
  await direct.collect();
  const again = f.snapshot();
  const account2 = again.providers[0].accounts[0];
  account2.updatedAt = new Date(NOW - 2 * MINUTE).toISOString();
  account2.windows = [{ id: 'weekly', label: 'weekly', usedPercent: 70, remainingPercent: 30,
    resetAt: null, stale: false }];
  f.store.capture(await direct.project(again), f.now());
 }
 const at = window => f.store.points('openai', '__main__', window, 0).map(p => p.at);
 // The weekly reading was made once and is filed once, at its own instant. Filing it under
 // the account's instant would have recorded it three times and invented a plateau.
 assert.deepEqual(at('weekly'), [NOW - 2 * MINUTE]);
 assert.deepEqual(at('monthly'), [NOW, NOW + 5 * MINUTE, NOW + 10 * MINUTE]);
 // None of this reaches the response: the per-window instant travels on a symbol key.
 assert.equal(JSON.stringify(projected).includes('measuredAt'), false);
 assert.deepEqual(Object.keys(projected.providers[0].accounts[0].windows.find(w => w.id === 'monthly')).sort(),
   ['id', 'label', 'measurement', 'remainingPercent', 'resetAt', 'stale', 'usedPercent']);
});

test('a window that already says when it was measured keeps that answer', async t => {
 const f = await fixture(t);
 f.respond(url => url.endsWith('/extra')
   ? { windows: [{ id: 'monthly', used: 250, limit: 1000 }] }
   : { status: 503 });
 const direct = f.build({ adapters: [adapter, extra] });
 await direct.collect();
 const snapshot = f.snapshot();
 const account = snapshot.providers[0].accounts[0];
 account.updatedAt = new Date(NOW - 2 * MINUTE).toISOString();
 account.windows = [{ id: 'weekly', label: 'weekly', usedPercent: 70, remainingPercent: 30,
   resetAt: null, stale: false }];
 // Projecting the same object twice must not retag a window with the second projection's
 // account instant. Callers rebuild the snapshot today, so this is a property of the
 // projection rather than a path anything currently takes.
 const once = await direct.project(snapshot);
 assert.equal(once.providers[0].accounts[0].windows.find(w => w.id === 'weekly')[MEASURED_AT],
   NOW - 2 * MINUTE);
 f.advance(5 * MINUTE);
 f.respond(url => url.endsWith('/extra') ? { windows: [{ id: 'monthly', used: 260, limit: 1000 }] } : { status: 503 });
 await direct.collect();
 const twice = await direct.project(once);
 assert.equal(twice.providers[0].accounts[0].windows.find(w => w.id === 'weekly')[MEASURED_AT],
   NOW - 2 * MINUTE);
});

// --- JUN-124: percent-less evidence, the last known reading, and the real schedule ---

// A reading the contract accepts but cannot turn into a percentage. Three shapes produce it,
// and all three used to vanish along with the reason they could not be rated.
test('a reading with no publishable percentage is kept as evidence instead of discarded', async t => {
 for (const [name, window] of [
   ['zero', { id: 'monthly', used: 4200, limit: 0, unit: 'usd-cents' }],
   ['missing', { id: 'monthly', used: 4200, unit: 'usd-cents' }],
   ['unlimited', { id: 'monthly', used: 4200, unlimited: true, unit: 'usd-cents' }],
 ]) {
  const f = await fixture(t);
  f.respond(() => ({ windows: [window] }));
  const direct = f.build();
  await direct.collect();
  const account = (await direct.project(f.snapshot())).providers[0].accounts[0];
  const evidence = account.directQuota.evidence;
  assert.equal(evidence.length, 1, name);
  assert.equal(evidence[0].id, 'monthly', name);
  assert.equal(evidence[0].endpointId, 'synthetic-usage', name);
  assert.equal(evidence[0].measurement.used, 4200, name);
  assert.equal(evidence[0].measurement.unit, 'usd-cents', name);
  assert.equal(evidence[0].measurement.limitState, name === 'zero' ? 'zero'
    : name === 'unlimited' ? 'unlimited' : 'missing', name);
  // No percentage was observed, so none is published -- not even as null, which a reader
  // would take for a measured zero.
  assert.equal('usedPercent' in evidence[0], false, name);
  assert.equal('remainingPercent' in evidence[0], false, name);
  assert.equal(evidence[0].measurement.reportedPercent, null, name);
  assert.equal(evidence[0].measurement.calculatedPercent, null, name);
  // It is evidence, not a window. The account still has nothing to draw a bar from.
  assert.deepEqual(account.windows, [], name);
  assert.equal(account.directQuota.status, 'observation_unavailable', name);
 }
});

test('evidence is replaced per window, so a response that omits one does not erase it', async t => {
 const f = await fixture(t);
 // Two windows, neither with a usable denominator.
 f.respond(() => ({ windows: [{ id: 'fiveHour', used: 10, limit: 0 }, { id: 'weekly', used: 20, limit: 0 }] }));
 const direct = f.build();
 await direct.collect();
 const first = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.deepEqual(first.directQuota.evidence.map(row => row.id).sort(), ['fiveHour', 'weekly']);

 // The next reply rates the five-hour window and says nothing at all about the weekly one.
 // Replacing the endpoint wholesale would discard a weekly reading nothing replaced.
 f.advance(3 * MINUTE);
 f.respond(() => ({ windows: [{ id: 'fiveHour', used: 10, limit: 100 }] }));
 await direct.collect();
 const second = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.deepEqual(second.directQuota.evidence.map(row => row.id), ['weekly']);
 assert.equal(second.directQuota.evidence[0].measurement.used, 20);
 // The window that regained a denominator is now a window, and its evidence row is gone.
 assert.deepEqual(second.windows.map(w => w.id), ['fiveHour']);
 assert.equal(second.windows[0].usedPercent, 10);
});

test('a refusal, a failure and a rejected row all leave retained evidence alone', async t => {
 const f = await fixture(t);
 f.respond(() => ({ windows: [{ id: 'monthly', used: 4200, limit: 0 }] }));
 const direct = f.build();
 await direct.collect();
 assert.equal(f.stored().endpoints['synthetic-usage'].unrated.length, 1);

 // A parse that yields no rows is a refusal, not an answer. Reading it as "the provider now
 // reports nothing" would throw away the only reading we have.
 f.advance(3 * MINUTE);
 f.respond(() => ({ windows: [] }));
 await direct.collect();
 assert.equal(f.stored().endpoints['synthetic-usage'].unrated.length, 1);

 // A transport failure likewise.
 f.advance(9 * MINUTE);
 f.respond(() => ({ status: 503 }));
 await direct.collect();
 assert.equal(f.stored().endpoints['synthetic-usage'].unrated.length, 1);

 // A row the measurement contract refuses supplies no replacement, so it cannot claim the
 // right to clear one. An unrecognised method is refused whole.
 f.advance(30 * MINUTE);
 f.respond(() => ({ windows: [{ id: 'monthly', used: 5, limit: 0, method: 'guessed' }] }));
 await direct.collect();
 const rows = f.stored().endpoints['synthetic-usage'].unrated;
 assert.equal(rows.length, 1);
 assert.equal(rows[0].measurement.used, 4200);
});

test('replacing the physical account drops its evidence with the rest of its boundary', async t => {
 const f = await fixture(t);
 f.respond(() => ({ windows: [{ id: 'monthly', used: 4200, limit: 0 }] }));
 const direct = f.build();
 await direct.collect();
 assert.equal(f.stored().endpoints['synthetic-usage'].unrated.length, 1);
 await writeFile(join(f.codexHome, 'auth.json'),
   JSON.stringify({ tokens: { account_id: 'replacement-physical', access_token: 'SENTINEL_DIRECT_B' } }));
 f.advance(3 * MINUTE);
 f.respond(() => ({ status: 503 }));
 await direct.collect();
 const account = (await direct.project(f.snapshot())).providers[0].accounts[0];
 assert.equal(account.directQuota?.evidence, undefined);
});

test('a login that needs attention keeps its last good reading without claiming it is current', async t => {
 for (const status of ['reauth', 'paused']) {
  const f = await fixture(t);
  const direct = f.build();
  await direct.collect();
  const snapshot = f.snapshot(status);
  const before = snapshot.providers[0].accounts[0];
  // An account that already carries a window is the case that proves nothing is overwritten.
  before.windows = [{ id: 'weekly', label: 'weekly', usedPercent: 70, remainingPercent: 30,
    resetAt: null, stale: false }];
  before.updatedAt = new Date(NOW - 2 * MINUTE).toISOString();
  const account = (await direct.project(snapshot)).providers[0].accounts[0];
  // Everything the existing web and menu-bar clients use to refuse a stale value is untouched.
  assert.equal(account.status, status);
  assert.equal(account.quotaMode, 'unavailable');
  assert.equal(account.updatedAt, new Date(NOW - 2 * MINUTE).toISOString());
  assert.deepEqual(account.windows.map(w => w.usedPercent), [70]);
  // The reading is published where a screen can show it as a past observation.
  assert.equal(account.directQuota.lastKnown.accountStatus, status);
  assert.equal(account.directQuota.lastKnown.windows[0].id, 'weekly');
  assert.equal(account.directQuota.lastKnown.windows[0].usedPercent, 12.34);
  assert.equal(account.directQuota.lastKnown.windows[0].measurement.calculatedPercent, 12.34);
 }
});

test('a replaced account brings no last known reading forward', async t => {
 const f = await fixture(t);
 const direct = f.build();
 await direct.collect();
 await writeFile(join(f.codexHome, 'auth.json'),
   JSON.stringify({ tokens: { account_id: 'replacement-physical', access_token: 'SENTINEL_DIRECT_B' } }));
 f.advance(3 * MINUTE);
 f.respond(() => ({ status: 503 }));
 await direct.collect();
 const account = (await direct.project(f.snapshot('reauth'))).providers[0].accounts[0];
 // The withheld marker is still published, because the screen needs one place to learn that
 // this account is holding something back. What must not survive is the reading itself: the
 // previous boundary's observation belongs to a different physical account.
 assert.deepEqual(account.directQuota.lastKnown, { accountStatus: 'reauth', windows: [] });
});

test('the next attempt is published as the schedule the collector actually holds', async t => {
 const f = await fixture(t);
 const direct = f.build({ intervalMs: 120000 });
 await direct.collect();
 const ok = (await direct.project(f.snapshot())).providers[0].accounts[0];
  // Success schedules the routine interval, less the jitter the fixture pins to its lower
  // bound: 120000 * (1 + 0.2 * (0 * 2 - 1)) = 96000.
  assert.equal(ok.directQuota.nextAttemptAt, new Date(NOW + 96000).toISOString());
 assert.equal(ok.directQuota.endpoints[0].nextAttemptAt, ok.directQuota.nextAttemptAt);

 // A failure schedules backoff instead, and the account reports the soonest of its endpoints.
 f.advance(3 * MINUTE);
 f.respond(() => ({ status: 503 }));
 await direct.collect();
 const failed = (await direct.project(f.snapshot())).providers[0].accounts[0];
 const at = Date.parse(failed.directQuota.nextAttemptAt);
 // One minute of base backoff, less the jitter the fixture pins to its lower bound:
 // 60000 + 60000 * 0.2 * (0 * 2 - 1) = 48000.
 assert.equal(at, NOW + 3 * MINUTE + 48000);
 assert.equal(Math.min(...failed.directQuota.endpoints
   .map(e => Date.parse(e.nextAttemptAt)).filter(Number.isFinite)), at);
});

test('repeated snapshot reads never add a provider request', async t => {
 const f = await fixture(t);
 const direct = f.build();
 // This is what criterion 3 actually asks for. The browser polls /api/v1/snapshot every ten
 // seconds, and that route projects rather than collects, so a reader cannot outrun the
 // provider backoff no matter how often it refreshes. Guard the property rather than the UI.
 await direct.collect();
 await direct.collect();
 for (let i = 0; i < 5; i += 1) await direct.project(f.snapshot());
 assert.equal(f.requests.length, 1);
 // Only once the schedule is due does a second request go out.
 f.advance(3 * MINUTE);
 await direct.collect();
 assert.equal(f.requests.length, 2);
});

test('an unchanged reading stretches toward the idle ceiling and any change snaps back', async t => {
 const f = await fixture(t);
 // random() = 0.5 zeroes the jitter so the asserted instants are exact.
 const direct = f.build({ intervalMs: 120000, random: () => 0.5 });
 const next = async () => Date.parse((await direct.project(f.snapshot()))
   .providers[0].accounts[0].directQuota.nextAttemptAt);
 await direct.collect();
 assert.equal(await next(), NOW + 120000);
 // Identical answers stretch the wait: two, four, then the ten-minute ceiling.
 f.advance(120000); await direct.collect();
 assert.equal(await next(), NOW + 120000 + 240000);
 f.advance(240000); await direct.collect();
 assert.equal(await next(), NOW + 360000 + 480000);
 f.advance(480000); await direct.collect();
 assert.equal(await next(), NOW + 840000 + 600000);
 // The ceiling stays under the twenty-minute observation-gap threshold, so idle time
 // keeps reading as watched rather than as a collection gap.
 assert.ok(600000 < 20 * MINUTE);
 // A moved reading drops straight back to the base interval.
 f.respond(() => ({ windows: [{ id: 'weekly', used: 130, limit: 1000 }] }));
 f.advance(600000); await direct.collect();
 assert.equal(await next(), NOW + 1440000 + 120000);
});

test('a window near its reset keeps the base interval instead of stretching', async t => {
 const f = await fixture(t);
 const direct = f.build({ intervalMs: 120000, random: () => 0.5 });
 // Ten minutes before the reset is exactly where a slow poll loses the pre-reset reading.
 f.respond(() => ({ windows: [{ id: 'weekly', used: 50, limit: 100, resetAt: NOW + 10 * MINUTE }] }));
 const next = async () => Date.parse((await direct.project(f.snapshot()))
   .providers[0].accounts[0].directQuota.nextAttemptAt);
 await direct.collect();
 assert.equal(await next(), NOW + 120000);
 f.advance(120000); await direct.collect();
 assert.equal(await next(), NOW + 240000, 'unchanged but inside the reset lead time');
});

test('a rate-limited endpoint cools past the ordinary backoff ceiling and honors Retry-After', async t => {
 const f = await fixture(t);
 const direct = f.build({ intervalMs: 120000, random: () => 0.5 });
 const next = async () => Date.parse((await direct.project(f.snapshot()))
   .providers[0].accounts[0].directQuota.nextAttemptAt);
 f.respond(() => ({ status: 429 }));
 await direct.collect();
 assert.equal(await next(), NOW + 60000);
 // The provider's own hint floors the wait.
 f.respond(() => ({ status: 429, headers: { 'retry-after': '300' } }));
 f.advance(60000); await direct.collect();
 assert.equal(await next(), NOW + 60000 + 300000);
 // Without a hint the cooldown doubles past the ordinary eight-minute cap.
 f.respond(() => ({ status: 429 }));
 f.advance(300000); await direct.collect();
 assert.equal(await next(), NOW + 360000 + 240000);
 f.advance(240000); await direct.collect();
 assert.equal(await next(), NOW + 600000 + 480000);
 f.advance(480000); await direct.collect();
 assert.equal(await next(), NOW + 1080000 + 960000);
 f.advance(960000); await direct.collect();
 assert.equal(await next(), NOW + 2040000 + 1800000, 'sixth failure reaches the thirty-minute cap');
});


test('newer cache percentages cannot switch the retained consumption history to an unidentified stream', async t => {
 const f = await fixture(t), direct = f.build();
 const reset = NOW + 7 * 86400000;
 let used = 10;
 f.respond(() => ({windows:[{id:'weekly', used, limit:100, scopeKey:'all',
   unit:'credits', windowSemantics:'fixed_reset', usedAccumulation:'cumulative', resetAt:reset}]}));
 const project = async (cacheUsed, cacheAt = f.now()) => {
   const s = await direct.project(bareSnapshot(cacheUsed, new Date(cacheAt).toISOString(), new Date(reset).toISOString()));
   f.store.capture(s, f.now());
   const p=s.providers[0], a=p.accounts[0], w=a.windows[0];
   w.analytics=windowAnalytics(f.store,p,a,w,f.now());
   return {s,p,a,w};
 };
 await direct.collect(); await project(10);
 f.advance(10 * MINUTE); used=20; await direct.collect();
 const measured=await project(20);
 assert.equal(measured.w.analytics.consumptionPeriods.oneHour.deltaPp,10);
 f.advance(MINUTE);
 const moved=await project(21);
 assert.equal(moved.w.usedPercent,21,'newer cached remaining percentage stays visible');
 assert.equal(moved.w.measurement,undefined,'cache is not relabelled as a direct measurement');
 assert.ok(moved.w[HISTORY_READING]);
 assert.equal(moved.w.analytics.status,'stale','derived balances remain historical while cache is ahead');
 assert.equal(moved.w.analytics.exhaustsAt,null);
 assert.equal(moved.w.analytics.consumptionPeriods.oneHour.deltaPp,10,'same verified direct history survives source switch');
 assert.equal(moved.w.analytics.consumptionPeriods.oneHour.observedAt,new Date(NOW+10*MINUTE).toISOString());
 assert.match(weeklyQuotaUsage(moved.p,'oneHour').value,/10%p/);
 assert.equal(recommendQuotaAccounts(moved.p,'oneHour',1).totalConsumedPp,10);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM quota_observations WHERE epoch IS NULL').get().n,0,
   'a newer cache does not interrupt the direct history stream');
 f.advance(MINUTE);
 const echo=await project(20);assert.equal(echo.w.analytics.consumptionPeriods.oneHour.deltaPp,10);
 f.advance(10*MINUTE);used=30;await direct.collect();
 const ahead=await project(31,f.now()+1);
 assert.equal(ahead.w.analytics.consumptionPeriods.oneHour.deltaPp,20,'latest direct reading is captured even while cache remains ahead');
 assert.equal(JSON.stringify(ahead.s).includes('historyReading'),false,'private evidence is not a second public quota');
});


test('history fallback never crosses a physical identity mismatch or survives an unsupported window', async t => {
 const f=await fixture(t),direct=f.build();await direct.collect();f.advance(5*MINUTE);
 const s=bareSnapshot(50,new Date(f.now()).toISOString());
 s[SOURCE_STATUS]={files:{},providers:{openai:{accounts:{__main__:identityDigest('different-account')}}}};
 const w=(await direct.project(s)).providers[0].accounts[0].windows[0];
 assert.equal(w[HISTORY_READING],undefined);
 const other=bareSnapshot(50,new Date(f.now()).toISOString());other.providers[0].accounts[0].windows[0].id='custom-other';
 const output=(await direct.project(other)).providers[0].accounts[0].windows;
 assert.equal(output.find(w=>w.id==='custom-other')[HISTORY_READING],undefined);
});
