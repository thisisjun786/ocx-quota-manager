import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openHistory } from '../src/history.mjs';
import { createBindingRegistry } from '../src/account-binding.mjs';

const NOW = 1800000000000, DAY = 86400000;
const TOKEN = 'SENTINEL_EPOCH_TOKEN';
// A binding as the credential reader produces it. Only the physical evidence matters here.
const binding = (accountId, physical, extra = {}) =>
  ({ key: `openai\0${accountId}`, provider: 'openai', accountId, kind: 'pool',
     physical, deleted: false, needsReauth: false, expiresAt: null, ...extra });
const stored = (basis, digest) => ({ basis, digest, storable: true });
const volatileId = digest => ({ basis: 'key_material', digest, storable: false });

async function fixture(t) {
 const dir = await mkdtemp(join(tmpdir(), 'quota-epoch-'));
 let store = await openHistory(dir);
 let time = NOW;
 const open = () => {
  const purged = [];
  const registry = createBindingRegistry({ store, now: () => time,
    purgeKeys: (provider, account) => { purged.push(`${provider}:${account}`); return [`directQuotaV1:${provider}:${account}`]; } });
  return { registry, purged };
 };
 let current = open();
 const handle = {
  get store() { return store; },
  get registry() { return current.registry; },
  get purged() { return current.purged; },
  advance: ms => { time += ms; },
  now: () => time,
  // A restart closes the database and rebuilds the registry, so the process-local
  // comparison table is genuinely empty afterwards.
  restart: async () => { store.close(); store = await openHistory(dir); current = open(); },
 };
 t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
 return handle;
}

test('a token refresh keeps the boundary while a replaced physical account starts a new one', async t => {
 const f = await fixture(t);
 const first = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 assert.equal(first.changed, true);
 assert.equal(first.reason, 'initial');
 // The token is not part of the evidence, so refreshing it changes nothing.
 const refreshed = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 assert.equal(refreshed.epoch, first.epoch);
 assert.equal(refreshed.changed, false);
 f.advance(60000);
 const replaced = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-b')));
 assert.equal(replaced.changed, true);
 assert.equal(replaced.reason, 'physical_changed');
 assert.notEqual(replaced.epoch, first.epoch);
 const rows = f.store.epochs.list('openai', 'pool1');
 assert.equal(rows.length, 2);
 assert.equal(rows[0].endedAt, f.now());
 assert.equal(rows[1].endedAt, null);
 // The replacement invalidates the previous account's cached observation.
 assert.deepEqual(f.purged, ['openai:pool1', 'openai:pool1']);
});

test('a different kind of evidence cannot claim the same account', async t => {
 const f = await fixture(t);
 const first = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 const switched = f.registry.resolve(binding('pool1', stored('credential_account_id', 'physical-a')));
 // Same digest string, different basis. Treating these as one account would merge two
 // identifier namespaces that happen to collide.
 assert.equal(switched.reason, 'basis_changed');
 assert.notEqual(switched.epoch, first.epoch);
});

test('a storable boundary is restored after a restart', async t => {
 const f = await fixture(t);
 const first = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 await f.restart();
 const after = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 assert.equal(after.epoch, first.epoch);
 assert.equal(after.changed, false);
 assert.equal(f.store.epochs.list('openai', 'pool1').length, 1);
});

test('an unstorable boundary is stable in one process and unverifiable across a restart', async t => {
 const f = await fixture(t);
 const first = f.registry.resolve(binding('key:k1', volatileId('salted-a')));
 const again = f.registry.resolve(binding('key:k1', volatileId('salted-a')));
 assert.equal(again.epoch, first.epoch);
 assert.equal(again.changed, false);
 // A rotated key is detected immediately inside the process.
 const rotated = f.registry.resolve(binding('key:k1', volatileId('salted-b')));
 assert.equal(rotated.reason, 'physical_changed');
 // After a restart the salt is new, so sameness cannot be proven. Claiming continuity
 // would attribute one key's history to whatever key now sits in that slot.
 await f.restart();
 const restarted = f.registry.resolve(binding('key:k1', volatileId('salted-c')));
 assert.equal(restarted.reason, 'restart_unverifiable');
 assert.notEqual(restarted.epoch, rotated.epoch);
});

test('a deleted account closes its boundary, drops its cache and opens nothing new', async t => {
 const f = await fixture(t);
 const first = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 f.store.set('directQuotaV1:openai:pool1', { epoch: first.epoch, observation: null });
 f.advance(60000);
 const removed = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a'), { deleted: true }));
 assert.equal(removed, null);
 assert.equal(f.store.epochs.current('openai', 'pool1'), null);
 assert.equal(f.store.get('directQuotaV1:openai:pool1'), null);
 assert.equal(f.store.epochs.list('openai', 'pool1').length, 1);
});

test('epoch numbers are never reused after retention removes the closed rows', async t => {
 const f = await fixture(t);
 const first = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 f.registry.retire(binding('pool1', stored('chatgpt_account_id', 'physical-a')), 'removed');
 // Age the closed row past retention and let maintenance collect it.
 f.advance(200 * DAY);
 f.store.maintain(f.now());
 assert.deepEqual(f.store.epochs.list('openai', 'pool1'), []);
 // A per-account maximum would hand the replacement the number its predecessor used, and a
 // pending response captured under the old epoch would then match again.
 const reopened = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-c')));
 assert.notEqual(reopened.epoch, first.epoch);
 assert.ok(reopened.epoch > first.epoch);
});

test('maintenance keeps an open boundary regardless of its age', async t => {
 const f = await fixture(t);
 const first = f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 f.advance(200 * DAY);
 f.store.maintain(f.now());
 const rows = f.store.epochs.list('openai', 'pool1');
 assert.equal(rows.length, 1);
 assert.equal(rows[0].epoch, first.epoch);
 assert.equal(rows[0].endedAt, null);
});

test('no token or unstorable digest is written to the epoch table', async t => {
 const f = await fixture(t);
 f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 f.registry.resolve(binding('key:k1', volatileId('salted-secret')));
 const dump = JSON.stringify(f.store.db.prepare('SELECT * FROM identity_epochs').all());
 assert.equal(dump.includes(TOKEN), false);
 // The process-salted comparison value is a keyed hash of the key itself, so persisting it
 // would store a token hash. It must be absent, not merely unreadable.
 assert.equal(dump.includes('salted-secret'), false);
 const key = f.store.epochs.current('openai', 'key:k1');
 assert.equal(key.physicalDigest, null);
 assert.equal(f.store.epochs.current('openai', 'pool1').physicalDigest, 'physical-a');
});

test('the new table does not change existing sample queries', async t => {
 const f = await fixture(t);
 const snapshot = { providers: [{ id: 'openai', accounts: [{ id: 'pool1', updatedAt: new Date(NOW).toISOString(),
   windows: [{ id: 'weekly', usedPercent: 12.34, resetAt: new Date(NOW + DAY).toISOString(), stale: false }] }] }] };
 f.store.capture(snapshot, NOW);
 const before = f.store.points('openai', 'pool1', 'weekly', 0);
 f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 f.registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-b')));
 // Aggregation reads by public account id and does not distinguish epochs today. That is
 // the current behaviour, documented here rather than silently changed; the remaining
 // isolation belongs to JUN-123.
 assert.deepEqual(f.store.points('openai', 'pool1', 'weekly', 0), before);
 assert.equal(before.length, 1);
 assert.equal(before[0].used, 12.34);
});

test('retiring a boundary drops its cached observation with no extra wiring', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'quota-epoch-default-'));
 const store = await openHistory(dir);
 t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
 // The documented construction, with no purge callback supplied. The other tests inject one,
 // which hid whether the default path honours the contract at all.
 const registry = createBindingRegistry({ store, now: () => NOW });
 const opened = registry.resolve(binding('pool1', stored('chatgpt_account_id', 'physical-a')));
 store.set('directQuotaV1:openai:pool1', { epoch: opened.epoch, observation: { measuredAt: NOW, windows: [] } });
 registry.retire(binding('pool1', stored('chatgpt_account_id', 'physical-a')), 'removed');
 assert.equal(store.epochs.current('openai', 'pool1'), null);
 assert.equal(store.get('directQuotaV1:openai:pool1'), null);
});
