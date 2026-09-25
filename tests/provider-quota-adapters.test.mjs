import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS } from '../src/provider-quota-adapters.mjs';
import { createCommandCodeQuotaAdapter } from '../src/command-code-quota.mjs';

test('the three guards the origin readers were verified under still hold through this reader', async t => {
 // Those readers were checked live against a repointed base, a disabled provider and an
 // organisation-scoped account, each making no request. The base check and the disabled guard
 // moved into this reader, so the regression belongs here: a change to either would otherwise
 // only surface as a credential leaving for a destination it does not belong to.
 const home = await mkdtemp(join(tmpdir(), 'origin-guards-'));
 const store = await openHistory(join(home, 'state'));
 t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
 const TOKEN = 'SENTINEL_ORIGIN_GUARD';
 const BASE = 'https://api.commandcode.ai';
 const write = async provider => {
  await writeFile(join(home, 'config.json'), JSON.stringify({ providers: { 'command-code': provider } }));
  await writeFile(join(home, 'auth.json'), JSON.stringify({ 'command-code': { accounts: [{ id: 'cc-1',
    credential: { access: TOKEN, accountId: 'physical-1' } }] } }));
 };
 const requests = [];
 const run = async (provider, destination) => {
  await write(provider);
  requests.length = 0;
  const direct = createDirectQuota({ store,
    transport: createQuotaTransport({ now: () => NOW,
      fetcher: async (url, init) => {
       requests.push({ url, authorization: init.headers.Authorization });
       return { status: 200, headers: { get: () => null },
         text: async () => JSON.stringify({ windowLimits: { fiveHour: { used: 1, cap: 14, resetAt: 0 } } }) };
      } }),
    registry: createBindingRegistry({ store, now: () => NOW }),
    readSource: () => readCredentialSource({ home, now: NOW }),
    adapters: [createCommandCodeQuotaAdapter({ destination })], now: () => NOW });
  await direct.collect();
  return requests.map(request => request.url);
 };
 const live = { enabled: true, baseUrl: BASE, authMode: 'oauth', orgId: null };
 // The declared destination is reached, so the three refusals below are refusals and not a
 // path that was broken to begin with.
 assert.deepEqual(await run({ baseUrl: BASE, authMode: 'oauth' }, live),
   ['https://api.commandcode.ai/alpha/billing/credits']);
 assert.equal(requests[0].authorization, `Bearer ${TOKEN}`);
 // A configuration pointing the provider somewhere else means the token on disk was issued
 // there. It never travels to the declared host.
 assert.deepEqual(await run({ baseUrl: 'https://relay.example', authMode: 'oauth' },
   { ...live, baseUrl: 'https://relay.example' }), []);
 // The same refusal when only this reader can see it: the destination still looks canonical
 // to the adapter, and the configured base is what disagrees.
 assert.deepEqual(await run({ baseUrl: 'https://relay.example', authMode: 'oauth' }, live), []);
 // A provider the user turned off is not read at all.
 assert.deepEqual(await run({ baseUrl: BASE, authMode: 'oauth', disabled: true }, live), []);
 // An organisation-scoped account states a scope this table cannot put in a request, so
 // nothing is read rather than the unscoped surface being read in its place.
 assert.deepEqual(await run({ baseUrl: BASE, authMode: 'oauth' }, { ...live, orgId: 'org-7' }), []);
});

test('a configured organisation reaches the transport and never reaches the request', async t => {
 // The organisation travels with the credential, but a destination's query is a fixed literal
 // and authorize builds headers, so no configured value can reach the URL. Command Code's
 // organisation scope is not on disk in the first place: the client reads it at runtime from
 // that provider's own whoami surface. This records both halves of why that path stays shut.
 const home = await mkdtemp(join(tmpdir(), 'origin-org-'));
 t.after(() => rm(home, { recursive: true, force: true }));
 await writeFile(join(home, 'config.json'), JSON.stringify({ providers: {
   'command-code': { baseUrl: 'https://api.commandcode.ai', organization: 'org-7' } } }));
 await writeFile(join(home, 'auth.json'), JSON.stringify({ 'command-code': { accounts: [{ id: 'cc-1',
   credential: { access: 'SENTINEL_ORG_TOKEN', accountId: 'physical-1' } }] } }));
 const source = await readCredentialSource({ home, now: NOW });
 const credential = source.token('command-code\u0000cc-1');
 assert.equal(credential.organization, 'org-7');
 const urls = [];
 const transport = createQuotaTransport({ now: () => NOW,
   fetcher: async url => { urls.push(url); return { status: 200, headers: { get: () => null },
     text: async () => '{}' }; } });
 await transport.request({ provider: 'command-code', endpointId: 'credits', credential });
 await transport.request({ provider: 'command-code', endpointId: 'credits',
   credential: { ...credential, organization: null } });
 // The same request either way: the organisation changes no part of the destination.
 assert.deepEqual(urls, ['https://api.commandcode.ai/alpha/billing/credits',
   'https://api.commandcode.ai/alpha/billing/credits']);
 assert.equal(urls.some(url => url.includes('org-7')), false);
});

import { projectMeasurement, publishedPercent } from '../src/quota-measurement.mjs';
import { identityDigest, readCredentialSource } from '../src/credential-source.mjs';
import { ENDPOINTS, createQuotaTransport } from '../src/quota-transport.mjs';
import { createDirectQuota } from '../src/direct-quota.mjs';
import { createBindingRegistry } from '../src/account-binding.mjs';
import { openHistory } from '../src/history.mjs';
import { projectQuotaAccount } from '../src/snapshot.mjs';
import { resolveScope } from '../src/window-scope.mjs';

test('a limit keeps one identity whichever path read it, and a sibling cannot rename it', () => {
 // The cached provider path and direct collection both publish an account's scoped windows.
 // If they name the same limit differently, history records one limit as two series, and the
 // account flips between them whenever one path is the fresher of the two.
 const cached = projectQuotaAccount('a1', 'a', null, false, { updatedAt: NOW,
   fiveHourPercent: 0, weeklyPercent: 43,
   customWindows: [{ label: 'Fable', percent: 24 }] }, NOW);
 const direct = read(find('anthropic', 'oauth-usage'), {
   five_hour: { utilization: 0 }, seven_day: { utilization: 43 },
   limits: [{ kind: 'weekly_scoped', percent: 24, scope: { model: { display_name: 'Fable' } } }] });
 assert.deepEqual(ids(direct), cached.windows.map(w => w.id));
 const cachedCursor = projectQuotaAccount('c1', 'c', null, false, { updatedAt: NOW,
   monthlyPercent: 2.5, customWindows: [{ label: 'First-party models', percent: 1.9 },
     { label: 'API usage', percent: 22.21 }] }, NOW);
 const directCursor = read(find('cursor', 'period-usage'), { planUsage: {
   totalPercentUsed: 2.5, autoPercentUsed: 1.9, apiPercentUsed: 22.21 } });
 assert.deepEqual(ids(directCursor), cachedCursor.windows.map(w => w.id));
 // A window that appears before an existing one must not rename it. Numbering by position
 // did exactly that, which is how one limit's history got split without anything failing.
 const reordered = projectQuotaAccount('a1', 'a', null, false, { updatedAt: NOW,
   customWindows: [{ label: 'Opus', percent: 5 }, { label: 'Fable', percent: 24 }] }, NOW);
 assert.deepEqual(reordered.windows.map(w => w.id), ['custom-opus', 'custom-fable']);
 // Two windows sharing a label: the first claim keeps the name and the second falls back to
 // its position. Demoting both would agree with nothing, because a direct reading of the same
 // provider keeps its first claim too, so the two paths would name even the first one
 // differently.
 const ambiguous = projectQuotaAccount('a1', 'a', null, false, { updatedAt: NOW,
   customWindows: [{ label: 'Fable', percent: 5 }, { label: 'Fable', percent: 24 }] }, NOW);
 assert.deepEqual(ambiguous.windows.map(w => w.id), ['custom-fable', 'custom-1']);
 const directAmbiguous = read(find('anthropic', 'oauth-usage'), {
   seven_day_fable: { utilization: 5 },
   limits: [{ kind: 'weekly_scoped', percent: 24, scope: { model: { display_name: 'Fable' } } }] });
 assert.equal(directAmbiguous[0].id, ambiguous.windows[0].id);
 // A row with no usable percentage is not published, so it must not push the window beside
 // it onto a positional identifier and back into disagreement with the direct reading.
 const skipped = projectQuotaAccount('a1', 'a', null, false, { updatedAt: NOW,
   customWindows: [{ label: 'Fable', percent: null }, { label: 'Fable', percent: 24 }] }, NOW);
 assert.deepEqual(skipped.windows.map(w => w.id), ['custom-fable']);
 // The positional form shares a namespace with a label made of digits, so it has to be
 // checked rather than assumed free: two windows must never publish under one identifier.
 const collide = labels => projectQuotaAccount('a1', 'a', null, false, { updatedAt: NOW,
   customWindows: labels.map(label => ({ label, percent: 5 })) }, NOW).windows.map(w => w.id);
 for (const labels of [['1', '!!!'], ['2', 'Fable', 'Fable'], ['!!!', '???', '0']]) {
  const produced = collide(labels);
  assert.equal(new Set(produced).size, produced.length, JSON.stringify([labels, produced]));
 }
});


test('the registered adapters reach a provider through the shipped endpoint table', async t => {
 // End to end through the real table, the real reader and the real registry: only the
 // network is replaced. A unit test of parse alone cannot show that the header the endpoint
 // needs is actually built, or that the base check lets the request through.
 const home = await mkdtemp(join(tmpdir(), 'quota-adapters-')), codexHome = join(home, 'native');
 await mkdir(codexHome);
 await writeFile(join(home, 'config.json'), JSON.stringify({ providers: { openai: {} } }));
 await writeFile(join(codexHome, 'auth.json'),
   JSON.stringify({ tokens: { account_id: 'main-physical', access_token: 'SENTINEL_ADAPTER_TOKEN' } }));
 const store = await openHistory(join(home, 'state'));
 t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
 const calls = [];
 const fetcher = async (url, init) => {
  calls.push({ url, init });
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
    account_id: 'main-physical', plan_type: 'pro',
    rate_limit: { primary_window: { used_percent: 14, limit_window_seconds: 604800, reset_at: 1790100895 },
      secondary_window: null } }) };
 };
 const direct = createDirectQuota({ store,
   transport: createQuotaTransport({ fetcher, now: () => NOW }),
   registry: createBindingRegistry({ store, now: () => NOW }),
   readSource: () => readCredentialSource({ home, codexHome, now: NOW }),
   adapters: ADAPTERS, now: () => NOW });
 await direct.collect();
 // Only the declared quota endpoint, with the workspace named in the header the endpoint
 // requires and the credential in the other one.
 assert.deepEqual(calls.map(call => call.url), ['https://chatgpt.com/backend-api/wham/usage']);
 assert.equal(calls[0].init.headers['ChatGPT-Account-Id'], 'main-physical');
 assert.equal(calls[0].init.headers.Authorization, 'Bearer SENTINEL_ADAPTER_TOKEN');
 assert.equal(calls[0].init.method, 'GET');
 const snapshot = { warnings: [], providers: [{ id: 'openai', enabled: true, accounts: [{
   id: '__main__', label: 'main', plan: null, active: true, status: 'unavailable',
   updatedAt: null, windows: [], quotaMode: 'unavailable' }] }] };
 const account = (await direct.project(snapshot, NOW)).providers[0].accounts[0];
 assert.deepEqual(account.windows.map(w => [w.id, w.usedPercent]), [['weekly', 14]]);
 assert.equal(account.directQuota.status, 'ok');
 assert.deepEqual(account.directQuota.endpoints.map(e => e.id), ['wham-usage']);
 // No credential reaches anything a reader could see.
 assert.equal(JSON.stringify(snapshot).includes('SENTINEL_ADAPTER_TOKEN'), false);
});


const NOW = 1800000000000;
const find = (provider, endpointId) =>
  ADAPTERS.find(a => a.provider === provider && a.endpointId === endpointId);

// The same projection direct collection applies to every row (src/direct-quota.mjs:134-149),
// so a row is judged here exactly as it is judged there.
function read(adapter, json, binding = null) {
  return (adapter.parse(json, { fetchedAt: NOW, binding }) ?? []).map(row => {
    const measurement = projectMeasurement({ ...row.raw,
      source: `${adapter.provider}/${adapter.endpointId}`, sourceVersion: adapter.sourceVersion,
      scopeKey: row.raw?.scopeKey ?? row.windowId }, { fetchedAt: NOW });
    return { id: row.windowId, label: row.label, resetAt: row.resetAt, measurement,
      published: publishedPercent(measurement) };
  });
}
const ids = rows => rows.map(row => row.id);

// A real WHAM payload, reduced to the fields that decide anything.
const ACCOUNT = 'acct-physical';
const binding = { kind: 'pool', accountId: 'pool1',
  physical: { basis: 'chatgpt_account_id', storable: true, digest: identityDigest(ACCOUNT) } };
const wham = windows => ({ account_id: ACCOUNT, plan_type: 'pro', rate_limit: { allowed: true, ...windows } });

test('Codex reads the window duration the response declares, and a weekly primary is not a five hour one', () => {
 const adapter = find('openai', 'wham-usage');
 // The shape real accounts return today: one primary window of seven days.
 const weekly = read(adapter, wham({ primary_window: { used_percent: 14,
   limit_window_seconds: 604800, reset_at: 1790100895 }, secondary_window: null }), binding);
 assert.deepEqual(ids(weekly), ['weekly']);
 assert.equal(weekly[0].published, 14);
 // reset_at arrives in epoch seconds and must not be read as milliseconds.
 assert.equal(weekly[0].resetAt, 1790100895000);
 assert.equal(weekly[0].measurement.windowSemantics, 'fixed_reset');
 // A sub-day primary is the burst window, and the seven-day secondary is the weekly one.
 const burst = read(adapter, wham({
   primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1790100895 },
   secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: 1790200895 },
   tertiary_window: { used_percent: 5, limit_window_seconds: 2592000, reset_at: 1790300895 } }), binding);
 assert.deepEqual(ids(burst), ['short', 'weekly', 'monthly']);
 assert.equal(burst[0].label, '5시간');
 assert.deepEqual(burst.map(row => row.published), [30, 55, 5]);
 // A primary of at least twenty-eight days is the monthly window, and the secondary then
 // carries the weekly one rather than being dropped.
 const monthly = read(adapter, wham({
   primary_window: { used_percent: 60, limit_window_seconds: 2592000, reset_at: 1790100895 },
   secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: 1790200895 } }), binding);
 assert.deepEqual(ids(monthly), ['monthly', 'weekly']);
 // An older payload declares no duration. It stays weekly, which is what that shape has
 // always meant, and says that the duration was not declared.
 const undeclared = read(adapter, wham({ primary_window: { used_percent: 9 } }), binding);
 assert.deepEqual(ids(undeclared), ['weekly']);
 assert.equal(undeclared[0].measurement.windowSemantics, 'unknown');
});

test('Codex refuses a reading the response does not attribute to the account that was asked', () => {
 const adapter = find('openai', 'wham-usage');
 const windows = { primary_window: { used_percent: 14, limit_window_seconds: 604800 } };
 assert.deepEqual(ids(read(adapter, wham(windows), binding)), ['weekly']);
 // One login can reach several workspaces. An answer about another of them would otherwise be
 // filed under this account's identity.
 const other = { ...wham(windows), account_id: 'a-different-account' };
 assert.deepEqual(read(adapter, other, binding), []);
 // An answer that names nobody cannot be attributed either, so it is refused rather than
 // assumed to be the right one.
 const anonymous = { ...wham(windows), account_id: undefined };
 assert.deepEqual(read(adapter, anonymous, binding), []);
 // A binding with no storable physical evidence has nothing to compare, and is not blocked
 // by a comparison it cannot make.
 const unverifiable = { kind: 'native', physical: { basis: 'none', storable: false, digest: null } };
 assert.deepEqual(ids(read(adapter, anonymous, unverifiable)), ['weekly']);
});

test('Claude keeps the overall windows and the model scoped ones apart, and collects a duplicate once', () => {
 const adapter = find('anthropic', 'oauth-usage');
 const resets = '2026-09-20T16:59:59.703991+00:00';
 const rows = read(adapter, {
   five_hour: { utilization: 0, resets_at: null },
   seven_day: { utilization: 43, resets_at: resets },
   seven_day_opus: null,
   limits: [
     // These two repeat the overall windows above and must not become extra windows.
     { kind: 'session', percent: 0, resets_at: null, scope: null },
     { kind: 'weekly_all', percent: 43, resets_at: resets, scope: null },
     { kind: 'weekly_scoped', percent: 24, resets_at: resets, scope: { model: { display_name: 'Fable' } } },
   ] });
 assert.deepEqual(ids(rows), ['five-hour', 'weekly', 'custom-fable']);
 // A real zero is a reading, not an absence.
 assert.equal(rows[0].published, 0);
 // The scoped window keeps its own figure rather than inheriting the overall one.
 assert.equal(rows[1].published, 43);
 assert.equal(rows[2].published, 24);
 assert.deepEqual(rows.map(row => row.measurement.scopeKey), ['all', 'all', 'fable']);
 // The same limit reported as a bucket and again in the limits array is one window.
 const both = read(adapter, {
   seven_day_fable: { utilization: 24, resets_at: resets },
   limits: [{ kind: 'weekly_scoped', percent: 99, resets_at: resets,
     scope: { model: { display_name: 'Fable' } } }] });
 assert.deepEqual(ids(both), ['custom-fable']);
 assert.equal(both[0].published, 24);
 // The published identity is the one the product's scope table already recognises, so the
 // window keeps its meaning instead of becoming a limit with no known consumers.
 assert.equal(resolveScope({ id: 'anthropic' }, { id: 'custom-fable', label: 'Fable' }).id, 'fable');
});

test('Cursor publishes the reported percentage and keeps the computed one beside it', () => {
 const adapter = find('cursor', 'period-usage');
 // The numbers the issue names: the endpoint reports 2.53% while the spend it reports
 // computes to 19.6125%, and the vendor's own display message says 19%.
 const rows = read(adapter, { billingCycleEnd: '1791784764000', planUsage: {
   totalPercentUsed: 2.5306451612903227, includedSpend: 7845, limit: 40000,
   autoPercentUsed: 1.9026666666666667, apiPercentUsed: 22.21 } });
 assert.deepEqual(ids(rows), ['monthly', 'custom-first-party-models', 'custom-api-usage']);
 const total = rows[0].measurement;
 assert.equal(total.reportedPercent, 2.5306451612903227);
 assert.equal(total.calculatedPercent, 19.6125);
 // Neither replaces the other, and the disagreement is recorded rather than repaired.
 assert.equal(total.reconciliation, 'mismatch');
 assert.equal(total.method, 'reported_percent');
 assert.equal(rows[0].published, 2.5306451612903227);
 assert.equal(total.used, 7845);
 assert.equal(total.limit, 40000);
 assert.equal(rows[0].resetAt, 1791784764000);
 // The secondary pools measure part of the plan and are separate windows, not a replacement
 // for the total, and they keep the labels the product's scope table matches on.
 assert.deepEqual(rows.slice(1).map(row => row.label), ['First-party models', 'API usage']);
 assert.equal(resolveScope({ id: 'cursor' },
   { id: 'custom-first-party-models', label: 'First-party models' }).id, 'cursor-first-party');
 // Without a reported percentage the computed one is published, and says so.
 const computed = read(adapter, { planUsage: { includedSpend: 7845, limit: 40000 } });
 assert.equal(computed[0].measurement.method, 'used_limit');
 assert.equal(computed[0].published, 19.6125);
 assert.equal(computed[0].measurement.reconciliation, 'unverified');
});

test('Grok keeps the weekly credit window and the legacy monthly pool separate', () => {
 const credits = find('xai', 'grok-credits'), billing = find('xai', 'grok-billing');
 const weekly = read(credits, { config: { creditUsagePercent: 4,
   currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-09-21T15:34:45.448780+00:00' } } });
 assert.deepEqual(ids(weekly), ['weekly']);
 assert.equal(weekly[0].published, 4);
 // The wire format omits a zero-valued field, so an absent percentage is not a measured zero.
 assert.deepEqual(read(credits, { config: {
   currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-09-21T15:34:45.448780+00:00' } } }), []);
 // A period that is not the weekly one does not become the weekly window.
 assert.deepEqual(read(credits, { config: { creditUsagePercent: 4,
   currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2026-10-01T00:00:00+00:00' } } }), []);
 // The monthly pool is its own window from its own endpoint, so a failed weekly read leaves
 // the weekly window absent rather than showing the monthly number in its place.
 const monthly = read(billing, { config: { used: { val: 1250 }, monthlyLimit: { val: 40000 },
   billingPeriodEnd: '2026-10-01T00:00:00+00:00' } });
 assert.deepEqual(ids(monthly), ['monthly']);
 assert.equal(monthly[0].measurement.method, 'used_limit');
 assert.equal(monthly[0].published, 3.125);
 // A limit of zero is a limit of zero, not a pool that is nothing used: there is no
 // percentage to publish, and the row is dropped rather than reported as 0%.
 const empty = read(billing, { config: { used: { val: 0 }, monthlyLimit: { val: 0 } } });
 assert.equal(empty[0].measurement.limitState, 'zero');
 assert.equal(empty[0].published, null);
});

test('a decimal survives and an integer is never turned into a guarantee', () => {
 const cursor = find('cursor', 'period-usage'), codex = find('openai', 'wham-usage');
 const decimal = read(cursor, { planUsage: { totalPercentUsed: 2.5577419354838713,
   includedSpend: 7929, limit: 40000 } })[0];
 // No intermediate rounding anywhere on the path.
 assert.equal(decimal.published, 2.5577419354838713);
 assert.equal(decimal.measurement.calculatedPercent, 19.8225);
 assert.equal(decimal.measurement.precisionEvidence, 'observed_fraction');
 const whole = read(codex, wham({ primary_window: { used_percent: 14,
   limit_window_seconds: 604800 } }), binding)[0];
 // One whole number is not evidence that the provider cannot report a fraction, so it is
 // recorded as unknown rather than as integer_only, and no resolution is claimed.
 assert.equal(whole.measurement.precisionEvidence, 'unknown');
 assert.equal(whole.measurement.resolutionPp, null);
});

test('every adapter names a declared endpoint and publishes a window the product already knows', () => {
 const published = ['five-hour', 'short', 'weekly', 'monthly'];
 for (const adapter of ADAPTERS) {
  assert.ok(ENDPOINTS[adapter.provider]?.[adapter.endpointId],
    `${adapter.provider}/${adapter.endpointId}`);
  assert.equal(typeof adapter.sourceVersion, 'string');
  // An API key is not a subscription session, so these endpoints are not asked with one.
  assert.equal(adapter.appliesTo({ kind: 'key', accountId: 'key:a' }), false);
  assert.equal(adapter.appliesTo({ kind: 'oauth', accountId: 'a' }), true);
 }
 // Registration order is the merge precedence, so a provider may appear more than once.
 assert.deepEqual(ADAPTERS.map(a => `${a.provider}/${a.endpointId}`),
   ['openai/wham-usage', 'anthropic/oauth-usage', 'cursor/period-usage',
     'xai/grok-credits', 'xai/grok-billing', 'devin/user-status']);
 const everyId = [
   ...read(find('openai', 'wham-usage'), wham({ primary_window: { used_percent: 1,
     limit_window_seconds: 604800 } }), binding),
   ...read(find('anthropic', 'oauth-usage'), { five_hour: { utilization: 1 },
     seven_day: { utilization: 1 }, limits: [{ kind: 'weekly_scoped', percent: 1,
       scope: { model: { display_name: 'Fable' } } }] }),
   ...read(find('cursor', 'period-usage'), { planUsage: { totalPercentUsed: 1,
     autoPercentUsed: 1, apiPercentUsed: 1 } }),
 ].map(row => row.id);
 for (const id of everyId) {
  assert.ok(published.includes(id) || id.startsWith('custom-'), id);
  // Nothing is numbered by position: a response whose order changed must not rename a limit.
  assert.equal(/custom-\d+$/.test(id), false, id);
 }
});
