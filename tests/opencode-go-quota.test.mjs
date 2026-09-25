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
import { parseOpenCodeGoUsage, createOpenCodeGoQuotaAdapter } from '../src/opencode-go-quota.mjs';

const NOW = 1800000000000;
const KEYS = { a: 'SENTINEL_OPENCODE_KEY_A', b: 'SENTINEL_OPENCODE_KEY_B' };
const BASE = 'https://opencode.ai/zen/go/v1';
const LIVE = { enabled: true, baseUrl: BASE };
const RESET = new Date(NOW + 3600000).toISOString();
// The shape this surface answers with: a status word, a percentage and an ISO reset.
const usage = (rolling, weekly, monthly) => ({ usage: {
  rolling: { status: 'ok', percent: rolling, resetsAt: RESET },
  weekly: { status: 'ok', percent: weekly, resetsAt: RESET },
  monthly: { status: 'ok', percent: monthly, resetsAt: RESET } } });
const binding = kind => ({ key: `opencode-go${String.fromCharCode(0)}key:a`, provider: 'opencode-go',
  accountId: 'key:a', kind, physical: { basis: 'key_material', storable: false, digest: 'k' },
  deleted: false, needsReauth: false, expiresAt: null, ambiguous: false });

async function fixture(t, { destination = LIVE } = {}) {
 const home = await mkdtemp(join(tmpdir(), 'opencode-go-quota-'));
 await writeFile(join(home, 'config.json'), JSON.stringify({ providers: { 'opencode-go': { baseUrl: BASE,
   apiKeyPool: [{ id: 'a', key: KEYS.a }, { id: 'b', key: KEYS.b }] } } }));
 const store = await openHistory(join(home, 'state'));
 t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
 let time = NOW;
 // Each key answers differently, so a reading filed under the wrong account is visible.
 let reply = authorization => ({ body: authorization === `Bearer ${KEYS.a}` ? usage(1, 5, 41) : usage(2, 6, 42) });
 const requests = [];
 const fetcher = async (url, init) => {
  requests.push({ url, authorization: init.headers.Authorization });
  const answer = reply(init.headers.Authorization);
  return { status: answer.status ?? 200, headers: { get: () => null },
    text: async () => typeof answer.text === 'string' ? answer.text : JSON.stringify(answer.body ?? {}) };
 };
 const direct = createDirectQuota({ store, transport: createQuotaTransport({ fetcher, now: () => time }),
   registry: createBindingRegistry({ store, now: () => time }),
   readSource: () => readCredentialSource({ home, now: time }),
   adapters: [createOpenCodeGoQuotaAdapter({ destination })], now: () => time, random: () => 0 });
 const account = id => ({ id, label: id, plan: null, active: false, status: 'unavailable',
   updatedAt: null, windows: [], quotaMode: 'unavailable' });
 return { direct, requests, store, respond: next => { reply = next; }, advance: ms => { time += ms; },
   snapshot: () => ({ warnings: [], providers: [{ id: 'opencode-go', enabled: true,
     accounts: [account('key:a'), account('key:b')] }] }),
   // The stored value holds a slot per endpoint, because one account can be read by more
   // than one. This reader declares a single endpoint, so this is that endpoint's slot.
   record: id => store.get(`directQuotaV1:opencode-go:${id}`)?.endpoints?.usage ?? null };
}

test('each pooled key reads its own usage under its own account id', async t => {
 const f = await fixture(t);
 await f.direct.collect();
 assert.deepEqual(f.requests.map(r => r.url), ['https://opencode.ai/zen/go/v1/usage', 'https://opencode.ai/zen/go/v1/usage']);
 assert.deepEqual(f.requests.map(r => r.authorization).sort(),
   [`Bearer ${KEYS.a}`, `Bearer ${KEYS.b}`].sort());
 const [first, second] = (await f.direct.project(f.snapshot())).providers[0].accounts;
 // The public account ids are the ones the pool already published, and no key stands in
 // for another: each row carries the numbers its own key answered with.
 assert.deepEqual([first.id, second.id], ['key:a', 'key:b']);
 assert.deepEqual(first.windows.map(w => [w.id, w.label, w.usedPercent]),
   [['five-hour', '5시간', 1], ['weekly', '주간', 5], ['monthly', '월간', 41]]);
 assert.deepEqual(second.windows.map(w => w.usedPercent), [2, 6, 42]);
 const rolling = first.windows[0];
 assert.equal(rolling.measurement.method, 'reported_percent');
 assert.equal(rolling.measurement.reportedPercent, 1);
 // No used and no limit are invented from a plan price or a locally priced call.
 assert.equal(rolling.measurement.used, null);
 assert.equal(rolling.measurement.limit, null);
 assert.equal(rolling.measurement.limitState, 'missing');
 assert.equal(rolling.measurement.calculatedPercent, null);
 // The provider calls this window rolling; the other two say nothing about how they reset.
 assert.equal(rolling.measurement.windowSemantics, 'sliding');
 assert.equal(first.windows[1].measurement.windowSemantics, 'unknown');
 assert.equal(rolling.resetAt, RESET);
 assert.equal(JSON.stringify(first).includes(KEYS.a), false);
});

test('a percentage keeps the decimals it was given, and a window the provider is not reporting is not a zero', async t => {
 const f = await fixture(t);
 f.respond(() => ({ body: { usage: { rolling: { status: 'ok', percent: 1.25, resetsAt: RESET },
   weekly: { status: 'unsupported', percent: 0, resetsAt: RESET },
   monthly: { status: 'ok', percent: 0, resetsAt: RESET } } } }));
 await f.direct.collect();
 const account = (await f.direct.project(f.snapshot())).providers[0].accounts[0];
 assert.deepEqual(account.windows.map(w => [w.id, w.usedPercent]), [['five-hour', 1.25], ['monthly', 0]]);
 assert.equal(account.windows[0].measurement.precisionEvidence, 'observed_fraction');
 // Zero that the provider does report stays a reading of zero.
 assert.equal(account.windows[1].measurement.reportedPercent, 0);
 assert.equal(account.windows[1].measurement.precisionEvidence, 'unknown');
});

test('a response with no usable window leaves the account saying so', async t => {
 const f = await fixture(t);
 f.respond(() => ({ body: { usage: { rolling: { status: 'unsupported', percent: 3, resetsAt: RESET } } } }));
 await f.direct.collect();
 assert.equal(f.record('key:a').lastAttempt.status, 'observation_unavailable');
 assert.deepEqual((await f.direct.project(f.snapshot())).providers[0].accounts[0].windows, []);
 assert.deepEqual(parseOpenCodeGoUsage({}, { fetchedAt: NOW }), []);
 assert.deepEqual(parseOpenCodeGoUsage({ usage: { rolling: { percent: 'x' } } }, { fetchedAt: NOW }), []);
 // Without a status word the reading is still a reading.
 assert.equal(parseOpenCodeGoUsage({ usage: { rolling: { percent: 4 } } }, { fetchedAt: NOW })[0].raw.percent, 4);
});

test('a key is not sent to a destination the configuration no longer points at', async t => {
 const applies = destination => createOpenCodeGoQuotaAdapter({ destination }).appliesTo(binding('key'));
 assert.equal(createOpenCodeGoQuotaAdapter().appliesTo(binding('key')), false);
 assert.equal(applies({ ...LIVE, enabled: false }), false);
 assert.equal(applies({ ...LIVE, baseUrl: 'https://opencode.ai/zen/v1' }), false);
 assert.equal(applies({ ...LIVE, baseUrl: 'https://opencode.ai.evil.example/zen/go/v1' }), false);
 assert.equal(applies(LIVE), true);
 assert.equal(applies({ ...LIVE, baseUrl: `${BASE}/` }), true);
 // This surface is read with the provider key, so an OAuth row is not its account.
 assert.equal(createOpenCodeGoQuotaAdapter({ destination: LIVE }).appliesTo(binding('oauth')), false);
 const f = await fixture(t, { destination: { ...LIVE, baseUrl: 'https://gateway.example/zen/go/v1' } });
 await f.direct.collect();
 assert.deepEqual(f.requests, []);
 assert.equal(f.record('key:a'), null);
});

test('a reset instant nobody can render is no reset, and the reading survives it', async t => {
 const f = await fixture(t);
 f.respond(() => ({ body: { usage: { rolling: { status: 'ok', percent: 3, resetsAt: 1e20 },
   weekly: { status: 'ok', percent: 4, resetsAt: 'not a date' } } } }));
 await f.direct.collect();
 const account = (await f.direct.project(f.snapshot())).providers[0].accounts[0];
 assert.deepEqual(account.windows.map(w => [w.id, w.usedPercent, w.resetAt]),
   [['five-hour', 3, null], ['weekly', 4, null]]);
 assert.equal(account.windows[0].measurement.cycleKey, null);
});
