import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openHistory } from '../src/history.mjs';
import { readCredentialSource } from '../src/credential-source.mjs';
import { createBindingRegistry } from '../src/account-binding.mjs';
import { createQuotaTransport } from '../src/quota-transport.mjs';
import { createDirectQuota } from '../src/direct-quota.mjs';
import { parseCommandCodeCredits, createCommandCodeQuotaAdapter } from '../src/command-code-quota.mjs';

const NOW = 1800000000000;
const TOKEN = 'SENTINEL_COMMAND_CODE_ACCESS';
const BASE = 'https://api.commandcode.ai';
const LIVE = { enabled: true, baseUrl: BASE, authMode: 'oauth', orgId: null };
// The shapes below are the ones the issue names for this surface: a window that has not opened
// reports a cap with nothing used and resetAt 0, and a used figure can carry decimals.
const CREDITS = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 69.9, purchasedCredits: 4, freeCredits: 1 },
  windowLimits: { limited: true, exceeded: null,
    fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
    weekly: { used: 1.75, cap: 14, exceeded: false, resetAt: NOW + 3600000 } },
};
const binding = kind => ({ key: `command-code${String.fromCharCode(0)}cc-1`, provider: 'command-code',
  accountId: 'cc-1', kind, physical: { basis: 'credential_account_id', storable: true, digest: 'd' },
  deleted: false, needsReauth: false, expiresAt: null, ambiguous: false });

async function fixture(t, { destination = LIVE, provider = { baseUrl: BASE, authMode: 'oauth' } } = {}) {
 const home = await mkdtemp(join(tmpdir(), 'command-code-quota-'));
 await writeFile(join(home, 'config.json'), JSON.stringify({ providers: { 'command-code': provider } }));
 await writeFile(join(home, 'auth.json'), JSON.stringify({ 'command-code': { accounts: [{ id: 'cc-1',
   credential: { access: TOKEN, accountId: 'physical-1' } }] } }));
 const store = await openHistory(join(home, 'state'));
 t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
 let time = NOW, reply = () => ({ body: CREDITS });
 const requests = [];
 const fetcher = async (url, init) => {
  requests.push({ url, authorization: init.headers.Authorization });
  const answer = reply();
  return { status: answer.status ?? 200, headers: { get: () => null },
    text: async () => typeof answer.text === 'string' ? answer.text : JSON.stringify(answer.body ?? {}) };
 };
 // The real endpoint table, so the declared destination is what the test exercises.
 const direct = createDirectQuota({ store, transport: createQuotaTransport({ fetcher, now: () => time }),
   registry: createBindingRegistry({ store, now: () => time }),
   readSource: () => readCredentialSource({ home, now: time }),
   adapters: [createCommandCodeQuotaAdapter({ destination })], now: () => time, random: () => 0 });
 return { direct, requests, store, respond: next => { reply = next; }, advance: ms => { time += ms; },
   snapshot: () => ({ warnings: [], providers: [{ id: 'command-code', enabled: true, accounts: [{ id: 'cc-1',
     label: 'cc', plan: null, active: true, status: 'unavailable', updatedAt: null, windows: [], quotaMode: 'unavailable' }] }] }),
   // The stored value holds a slot per endpoint, because one account can be read by more
   // than one. This reader declares a single endpoint, so this is that endpoint's slot.
   record: () => store.get('directQuotaV1:command-code:cc-1')?.endpoints?.credits ?? null };
}

test('a credit window publishes its own used and cap, and a reading of zero stays a reading', async t => {
 const f = await fixture(t);
 await f.direct.collect();
 // One declared destination, credential in a header, nothing else contacted.
 assert.deepEqual(f.requests.map(r => r.url), ['https://api.commandcode.ai/alpha/billing/credits']);
 assert.equal(f.requests[0].authorization, `Bearer ${TOKEN}`);
 const account = (await f.direct.project(f.snapshot())).providers[0].accounts[0];
 const [five, weekly] = account.windows;
 assert.equal(five.id, 'five-hour'); assert.equal(five.label, '5시간');
 // used 0 against cap 14 is a limit that exists and a usage of nothing, not a missing limit.
 assert.equal(five.usedPercent, 0); assert.equal(five.remainingPercent, 100);
 assert.equal(five.measurement.limitState, 'present');
 assert.equal(five.measurement.limit, 14); assert.equal(five.measurement.used, 0);
 assert.equal(five.measurement.calculatedPercent, 0);
 assert.equal(five.measurement.method, 'used_limit'); assert.equal(five.measurement.unit, 'credits');
 // resetAt 0 means the window never opened. Published as a reset it would be permanently past.
 assert.equal(five.resetAt, null); assert.equal(five.stale, false);
 assert.equal(weekly.id, 'weekly'); assert.equal(weekly.label, '주간');
 assert.equal(weekly.usedPercent, 12.5);
 assert.equal(weekly.measurement.precisionEvidence, 'observed_fraction');
 assert.equal(weekly.measurement.cycleKey, String(NOW + 3600000));
 assert.equal(weekly.measurement.source, 'command-code/credits');
 // The credit pools beside the windows are a different quantity and never become a limit.
 const published = JSON.stringify(account);
 assert.equal(published.includes('69.9'), false);
 assert.equal(published.includes('purchased'), false);
 assert.equal(published.includes(TOKEN), false);
});

test('a cap of zero is a limit of zero, not a usage of zero', async t => {
 const f = await fixture(t);
 f.respond(() => ({ body: { windowLimits: { fiveHour: { used: 0, cap: 0, resetAt: 0 } } } }));
 await f.direct.collect();
 // Nothing divides by a limit of zero, so no percentage is published and the account says so.
 assert.equal(f.record().lastAttempt.status, 'observation_unavailable');
 assert.deepEqual((await f.direct.project(f.snapshot())).providers[0].accounts[0].windows, []);
});

test('the reader answers wrapped or bare, and an unknown window changes no other number', async t => {
 const rows = parseCommandCodeCredits({ data: { windowLimits: { fiveHour: { used: 7, cap: 14, resetAt: 0 },
   daily: { used: 3, cap: 4 }, weekly: { used: 'x', cap: 35 } } } }, { fetchedAt: NOW });
 assert.deepEqual(rows.map(row => row.windowId), ['five-hour']);
 assert.equal(rows[0].raw.limit, 14);
 assert.equal(rows[0].raw.precisionEvidence, 'unknown');
 assert.deepEqual(parseCommandCodeCredits({ credits: { monthlyCredits: 5 } }, { fetchedAt: NOW }), []);
 assert.deepEqual(parseCommandCodeCredits(null, { fetchedAt: NOW }), []);
});

test('a credential is not spent on a provider that was turned off, repointed, or is not the one routing', () => {
 const applies = destination => createCommandCodeQuotaAdapter({ destination }).appliesTo(binding('oauth'));
 // A registered adapter with no destination is inert: nothing tells it where the credential belongs.
 assert.equal(createCommandCodeQuotaAdapter().appliesTo(binding('oauth')), false);
 assert.equal(applies({ ...LIVE, enabled: false }), false);
 assert.equal(applies({ ...LIVE, baseUrl: 'https://api.commandcode.ai.evil.example' }), false);
 assert.equal(applies({ ...LIVE, baseUrl: null }), false);
 // An organisation account is read with a per-request scope the fixed table cannot build.
 assert.equal(applies({ ...LIVE, orgId: 'org_1' }), false);
 // The account that routes requests is the one worth metering.
 assert.equal(createCommandCodeQuotaAdapter({ destination: LIVE }).appliesTo(binding('key')), false);
 assert.equal(createCommandCodeQuotaAdapter({ destination: { ...LIVE, authMode: 'key' } }).appliesTo(binding('key')), true);
 assert.equal(applies(LIVE), true);
 assert.equal(applies({ ...LIVE, baseUrl: `${BASE}/` }), true);
 // A destination may be read at each decision, so turning the provider off stops the next one.
 let enabled = true;
 const live = createCommandCodeQuotaAdapter({ destination: () => ({ ...LIVE, enabled }) });
 assert.equal(live.appliesTo(binding('oauth')), true);
 enabled = false;
 assert.equal(live.appliesTo(binding('oauth')), false);
 // A reader that throws refuses the request rather than failing the whole collection.
 assert.equal(createCommandCodeQuotaAdapter({ destination: () => { throw new Error('unreadable'); } })
   .appliesTo(binding('oauth')), false);
});

test('a disabled provider is never contacted at all', async t => {
 const f = await fixture(t, { destination: { ...LIVE, enabled: false } });
 await f.direct.collect();
 assert.deepEqual(f.requests, []);
 assert.equal(f.record(), null);
});

test('a refusal, a denial, a provider failure and an empty answer are four different outcomes', async t => {
 const f = await fixture(t);
 for (const [answer, status] of [[{ status: 401 }, 'credential_expired'], [{ status: 403 }, 'access_denied'],
   [{ status: 503 }, 'server_error'], [{ status: 200, text: 'not json' }, 'invalid_json'],
   [{ status: 200, body: { windowLimits: {} } }, 'observation_unavailable']]) {
  f.respond(() => answer);
  f.advance(30 * 60000);
  await f.direct.collect();
  assert.equal(f.record().lastAttempt.status, status, status);
 }
 // A good reading survives every one of them.
 f.respond(() => ({ body: CREDITS }));
 f.advance(30 * 60000);
 await f.direct.collect();
 const good = f.record().observation.windows[0].usedPercent;
 f.respond(() => ({ status: 503 }));
 f.advance(30 * 60000);
 await f.direct.collect();
 assert.equal(f.record().observation.windows[0].usedPercent, good);
 assert.equal(f.record().lastAttempt.status, 'server_error');
});

test('a reset instant nobody can render is no reset, and the reading survives it', async t => {
 const f = await fixture(t);
 // A limit of 35 with nothing used is the other shape this surface answers with, and it is
 // still a limit that exists. The out-of-range reset must not take the reading down with it.
 f.respond(() => ({ body: { windowLimits: { fiveHour: { used: 0, cap: 35, resetAt: 1e20 },
   weekly: { used: 2, cap: 4, resetAt: -5 } } } }));
 await f.direct.collect();
 const account = (await f.direct.project(f.snapshot())).providers[0].accounts[0];
 assert.deepEqual(account.windows.map(w => [w.id, w.usedPercent, w.resetAt]),
   [['five-hour', 0, null], ['weekly', 50, null]]);
 assert.equal(account.windows[0].measurement.limitState, 'present');
 assert.equal(account.windows[0].measurement.limit, 35);
});
