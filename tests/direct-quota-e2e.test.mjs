import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCollector } from '../src/collector.mjs';
import { createApp } from '../src/server.mjs';
import { directOptions } from '../src/direct-adapters.mjs';

// Criterion 6 of JUN-124: a direct read reaches the database, the API and a browser payload
// without OpenCodex running, without its management API and without an admin token, and
// survives a restart.
//
// The entry point's own wiring is proven separately, by running the real process, in
// tests/direct-adapters.test.mjs. What this covers is the data path behind it. The endpoint
// table is NOT substituted: swapping it would take the destination checks out of the very
// path being proven, so only the fetcher is injected and the requested URL is asserted.
const TOKEN = 'SENTINEL_E2E_COMMAND_CODE';
const NOW = 1800000000000;

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'quota-e2e-'));
  const codexHome = join(home, 'native');
  await mkdir(codexHome);
  // A configuration file is not an OpenCodex server. Without one the credential's destination
  // is unknown and the transport refuses before any fetcher is reached, so the fixture states
  // the provider's own canonical base exactly as a real install would.
  await writeFile(join(home, 'config.json'), JSON.stringify({ providers: {
    'command-code': { baseUrl: 'https://api.commandcode.ai', authMode: 'oauth' } } }));
  await writeFile(join(home, 'auth.json'), JSON.stringify({ 'command-code': {
    activeAccountId: 'cc1',
    // accountId is what makes the physical evidence storable, which is what lets the stored
    // reading survive a restart at all.
    accounts: [{ id: 'cc1', credential: { access: TOKEN, email: 'cc@example.test',
      accountId: 'cc-physical' } }] } }));
  const dataDir = join(home, 'state');
  const urls = [];
  // A rated window and an unrateable one in the same response.
  const billing = { data: { windowLimits: {
    fiveHour: { used: 123.4, cap: 1000, resetAt: (NOW + 3600000) / 1000 },
    weekly: { used: 4200, cap: 0, resetAt: (NOW + 86400000) / 1000 },
  } } };
  const fetcher = async (url, init) => {
    urls.push({ url, authorization: init?.headers?.Authorization ?? null });
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(billing) };
  };
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  return { home, codexHome, dataDir, urls, fetcher };
}

const build = (f, dataDir) => createCollector({
  home: f.home, codexHome: f.codexHome, claudeHome: join(f.home, 'noclaude'),
  claudeProfile: join(f.home, 'noclaude.json'), dataDir,
  // The same helper src/server.mjs calls, given the same home, so the adapters under test are
  // the ones a real install would register rather than a list this test assembled.
  ...directOptions({ QUOTA_DIRECT_PROVIDERS: 'command-code' }, { home: f.home }),
  directFetcher: f.fetcher, now: () => NOW });

async function get(t, collector) {
  const server = createApp({ port: 0, snapshot: () => collector.snapshot() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch('http://127.0.0.1:' + port + '/api/v1/snapshot',
    { headers: { host: '127.0.0.1:' + port } });
  assert.equal(response.status, 200);
  return response.json();
}

test('a direct read reaches the database, the API and the browser payload with no OpenCodex running',
  { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const collector = await build(f, f.dataDir);
  t.after(async () => { await collector.close(); });
  await collector.collect();

  // The real endpoint table decided this, not a substitute: the canonical host and path, with
  // the credential in a header and nowhere else.
  assert.deepEqual(f.urls.map(entry => entry.url), ['https://api.commandcode.ai/alpha/billing/credits']);
  assert.equal(f.urls[0].authorization, 'Bearer ' + TOKEN);

  const payload = await get(t, collector);
  assert.equal(payload.schemaVersion, 1);
  const provider = payload.providers.find(p => p.id === 'command-code');
  const account = provider.accounts.find(a => a.id === 'cc1');
  // The rated window reached the browser payload as a window.
  const window = account.windows.find(w => w.id === 'five-hour');
  assert.equal(window.usedPercent, 12.34);
  assert.equal(window.measurement.used, 123.4);
  assert.equal(window.measurement.limit, 1000);
  assert.equal(window.measurement.source, 'command-code/credits');
  // The unrateable one reached it as evidence, with no invented percentage.
  const evidence = account.directQuota.evidence.find(row => row.id === 'weekly');
  assert.equal(evidence.measurement.used, 4200);
  assert.equal(evidence.measurement.limitState, 'zero');
  assert.equal('usedPercent' in evidence, false);
  // And the schedule is published rather than left null.
  assert.equal(typeof account.directQuota.nextAttemptAt, 'string');
  // Nothing in the payload carries the credential.
  assert.equal(JSON.stringify(payload).includes(TOKEN), false);
});

test('a restart republishes what was stored, on a copy of the database', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const first = await build(f, f.dataDir);
  await first.collect();
  const firstPayload = await first.snapshot();
  const deadline = firstPayload.providers.find(p => p.id === 'command-code').accounts[0].directQuota.nextAttemptAt;
  assert.ok(Date.parse(deadline) > NOW);
  await first.close();

  // A copy, so the original state directory is never the thing under test.
  const copy = join(f.home, 'state-copy');
  await cp(f.dataDir, copy, { recursive: true });
  const restarted = await build(f, copy);
  t.after(async () => { await restarted.close(); });
  const before = f.urls.length;
  const payload = await get(t, restarted);
  const account = payload.providers.find(p => p.id === 'command-code').accounts.find(a => a.id === 'cc1');

  // Serving a snapshot does not fetch: the stored reading is what comes back.
  assert.equal(f.urls.length, before);
  assert.equal(account.windows.find(w => w.id === 'five-hour').usedPercent, 12.34);
  assert.equal(account.directQuota.evidence.find(row => row.id === 'weekly').measurement.used, 4200);
  // The exact recorded deadline survives reopening the database; no extra fetch is needed.
  assert.equal(account.directQuota.nextAttemptAt, deadline);
});
