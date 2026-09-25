import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

import { directOptions, createDestinationReader, DIRECT_PROVIDERS } from '../src/direct-adapters.mjs';

const SERVER = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const CC_BASE = 'https://api.commandcode.ai';

async function home(t, providers) {
  const dir = await mkdtemp(join(tmpdir(), 'quota-direct-adapters-'));
  const codexHome = join(dir, 'native');
  await mkdir(codexHome);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ providers }));
  await writeFile(join(codexHome, 'auth.json'),
    JSON.stringify({ tokens: { account_id: 'main-physical', access_token: 'SENTINEL_ENTRY' } }));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return { dir, codexHome };
}

// Off is the default, and off must be the literal defaults createCollector already uses, or
// the claim that an existing install is unchanged is not checkable.
test('direct collection stays off unless the environment names providers', async t => {
  const h = await home(t, {});
  for (const env of [{}, { QUOTA_DIRECT_PROVIDERS: '' }, { QUOTA_DIRECT_PROVIDERS: '   ' },
    { QUOTA_DIRECT_PROVIDERS: ' , ,, ' }]) {
    assert.deepEqual(directOptions(env, { home: h.dir }), { directAdapters: [], directPrepare: null });
  }
  // A name nothing ships is reported and ignored rather than silently enabling everything.
  const warned = [];
  assert.deepEqual(directOptions({ QUOTA_DIRECT_PROVIDERS: 'not-a-provider' },
    { home: h.dir, warn: message => warned.push(message) }),
    { directAdapters: [], directPrepare: null });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /not-a-provider/);
});

test('a named provider registers its own adapters and nothing else', async t => {
  const h = await home(t, {});
  const only = directOptions({ QUOTA_DIRECT_PROVIDERS: 'xai' }, { home: h.dir });
  assert.deepEqual(only.directAdapters.map(a => a.provider + '/' + a.endpointId),
    ['xai/grok-credits', 'xai/grok-billing']);
  assert.equal(typeof only.directPrepare, 'function');
  // The two readers that are built per destination come from the same list.
  const readers = directOptions({ QUOTA_DIRECT_PROVIDERS: 'command-code,opencode-go' }, { home: h.dir });
  assert.deepEqual(readers.directAdapters.map(a => a.provider + '/' + a.endpointId),
    ['command-code/credits', 'opencode-go/usage']);
  assert.ok(DIRECT_PROVIDERS.includes('command-code') && DIRECT_PROVIDERS.includes('xai'));
});

test('a destination is re-read, so a configuration change takes effect on the next cycle', async t => {
  const h = await home(t, { 'command-code': { baseUrl: CC_BASE, authMode: 'oauth' } });
  const reader = createDestinationReader({ home: h.dir });
  const of = reader.of('command-code');
  // Nothing has been read yet, and an unread destination is never spent.
  assert.equal(of(), null);
  await reader.refresh();
  assert.deepEqual(of(), { enabled: true, baseUrl: CC_BASE, authMode: 'oauth', orgId: null });
  // A destination-only change: the credential and the roster are untouched, so only a reader
  // that actually re-read its configuration can notice.
  await writeFile(join(h.dir, 'config.json'),
    JSON.stringify({ providers: { 'command-code': { baseUrl: CC_BASE, authMode: 'key' } } }));
  await reader.refresh();
  assert.equal(of().authMode, 'key');
  // A configuration that cannot be read is not evidence that the default applies.
  await rm(join(h.dir, 'config.json'));
  await reader.refresh();
  assert.equal(of(), null);
});

test('the freshness hook is what makes an adapter stop applying, not the roster', async t => {
  const h = await home(t, { 'command-code': { baseUrl: CC_BASE, authMode: 'oauth' } });
  const { directAdapters, directPrepare } = directOptions(
    { QUOTA_DIRECT_PROVIDERS: 'command-code' }, { home: h.dir });
  const adapter = directAdapters[0];
  const binding = { provider: 'command-code', accountId: 'a', kind: 'oauth' };
  await directPrepare();
  assert.equal(adapter.appliesTo(binding), true);
  // Flip only the destination. The provider stays enabled and the credential stays valid, so
  // a cache that never refreshed would still say true here.
  await writeFile(join(h.dir, 'config.json'),
    JSON.stringify({ providers: { 'command-code': { baseUrl: CC_BASE, authMode: 'key' } } }));
  assert.equal(adapter.appliesTo(binding), true, 'stale until the cycle hook runs');
  await directPrepare();
  assert.equal(adapter.appliesTo(binding), false, 'the hook is the only thing that can change this');
});

// The defect this issue exists to close is that the entry point never passed the list. A test
// that calls directOptions and hands the result to createCollector itself would pass even if
// src/server.mjs still ignored it, so this runs the real process and reads the real response.
// analytics.directQuota is written in exactly one place, src/collector.mjs, and only when the
// adapter list is non-empty, so its presence is evidence that the entry point passed one.
async function serve(t, env) {
  const h = await home(t, { 'command-code': { baseUrl: 'https://relay.invalid', authMode: 'oauth' } });
  const data = await mkdtemp(join(tmpdir(), 'quota-direct-state-'));
  // The switch is read from the environment, so the parent's own value must not leak in:
  // a developer who has it exported would otherwise fail the unset case.
  const base = { ...process.env };
  delete base.QUOTA_DIRECT_PROVIDERS;
  // A port the probe released can be taken before the child binds it. Only that collision is
  // retried: any other failure to start is the thing under test failing and must surface.
  // Each attempt keeps its own buffer and its own child is stopped before the next begins, or
  // a late line from an abandoned process could mark a later attempt ready.
  let port, ready = '', live = null, stop = async () => {};
  for (let attempt = 0; attempt < 5; attempt += 1) {
    port = await freePort();
    const out = [];
    const child = spawn(process.execPath, [SERVER], { env: { ...base,
      QUOTA_HOST: '127.0.0.1', QUOTA_PORT: String(port), OPENCODEX_HOME: h.dir,
      QUOTA_CODEX_HOME: h.codexHome, QUOTA_CLAUDE_HOME: join(h.dir, 'noclaude'),
      QUOTA_CLAUDE_PROFILE: join(h.dir, 'noclaude.json'), QUOTA_DATA_DIR: data, ...env } });
    child.stdout.on('data', chunk => out.push(String(chunk)));
    child.stderr.on('data', chunk => out.push(String(chunk)));
    const exited = new Promise(resolve => child.once('exit', resolve));
    // A child that ignores SIGTERM is killed rather than waited on forever, and the timer is
    // cleared so it cannot outlive a normal exit.
    const halt = async () => {
      child.kill('SIGTERM');
      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(resolve, 10000); });
      const stopped = await Promise.race([exited.then(() => true), deadline.then(() => false)]);
      clearTimeout(timer);
      if (!stopped) { child.kill('SIGKILL'); await exited; }
    };
    for (let i = 0; i < 200; i += 1) {
      const seen = out.join('');
      if (seen.includes('Quota Monitor') || seen.includes('EADDRINUSE')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    ready = out.join('');
    if (ready.includes('Quota Monitor')) { live = child; stop = halt; break; }
    await halt();
    if (!ready.includes('EADDRINUSE')) break;
  }
  // The child owns the database directory, so it is removed only once that child is gone.
  t.after(async () => { await stop(); await rm(data, { recursive: true, force: true }); });
  assert.ok(live !== null, 'server did not start: ' + ready);
  const response = await fetch('http://127.0.0.1:' + port + '/api/v1/snapshot');
  // A failed snapshot answers 503, and a missing field there would mean something else.
  assert.equal(response.status, 200, 'snapshot route did not answer');
  let body = await response.json();
  // HTTP is deliberately ready before the background worker publishes its first DB view.
  for (let i=0; i<100 && !body.analytics?.pricingCatalog; i++) {
    await new Promise(resolve=>setTimeout(resolve,50));
    body=await (await fetch('http://127.0.0.1:' + port + '/api/v1/snapshot')).json();
  }
  return body;
}

test('the running service registers the adapters the environment names', { timeout: 60000 }, async t => {
  const on = await serve(t, { QUOTA_DIRECT_PROVIDERS: 'command-code' });
  assert.equal(on.schemaVersion, 1);
  assert.equal(on.analytics.directQuota.enabled, true);
  assert.deepEqual(on.analytics.directQuota.endpoints, ['command-code/credits']);
  // This fixture carries no Command Code credential, so the request count says nothing about
  // destination enforcement and is not asserted as if it did. What this test proves is
  // narrower and is exactly the defect being closed: the running entry point passed a
  // non-empty adapter list. Destination refusal is covered by tests/provider-quota-adapters
  // and the applicability tests above.
  assert.equal(on.analytics.directQuota.intervalSeconds, 120);
});

test('the running service publishes exactly what it did before when the switch is unset', { timeout: 60000 }, async t => {
  const off = await serve(t, {});
  assert.equal(off.schemaVersion, 1);
  assert.equal('directQuota' in off.analytics, false);
});

test('overlapping destination reads collapse into one, so no caller sees an older answer', async t => {
  const h = await home(t, { 'command-code': { baseUrl: CC_BASE, authMode: 'oauth' } });
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  // A read that does not finish until told to, so two refreshes are genuinely concurrent.
  const reader = createDestinationReader({ home: h.dir, read: async path => {
    calls.push(path);
    await gate;
    return JSON.stringify({ providers: { 'command-code': { baseUrl: CC_BASE, authMode: 'key' } } });
  } });
  const first = reader.refresh();
  const second = reader.refresh();
  release();
  await Promise.all([first, second]);
  // One read, not two. Running them in parallel is what let a slower earlier read land last
  // and reinstate a credential mode the configuration had already moved away from; returning
  // early from the overtaken one instead would leave its caller on a value older still.
  assert.equal(calls.length, 1);
  assert.equal(reader.of('command-code')().authMode, 'key');
  // Once nothing is in flight the next call reads again rather than serving the cache.
  await reader.refresh();
  assert.equal(calls.length, 2);
});

test('an unreadable configuration clears what was cached, and refresh never rejects', async t => {
  const h = await home(t, { 'command-code': { baseUrl: CC_BASE, authMode: 'oauth' } });
  // One reader through success, failure and recovery. Checking a second, never-populated
  // reader would prove only that an empty cache is empty.
  let mode = 'ok';
  const reader = createDestinationReader({ home: h.dir, read: async path => {
    if (mode === 'throw') throw new Error('nope');
    if (mode === 'garbage') return 'not json';
    return readFile(path);
  } });
  await reader.refresh();
  assert.equal(reader.of('command-code')().authMode, 'oauth');
  // A throwing read must not escape into the caller: this hook runs inside the snapshot path,
  // where a rejection would turn a readable configuration problem into an HTTP 503. And a
  // configuration that cannot be read is not evidence that the last one still applies.
  mode = 'throw';
  await assert.doesNotReject(() => reader.refresh());
  assert.equal(reader.of('command-code')(), null);
  mode = 'garbage';
  await assert.doesNotReject(() => reader.refresh());
  assert.equal(reader.of('command-code')(), null);
  mode = 'ok';
  await reader.refresh();
  assert.equal(reader.of('command-code')().authMode, 'oauth');
});

test('the registrar reads destinations from the home it was handed, not some other one', async t => {
  // src/server.mjs resolves the OpenCodex home once and passes that same value both as the
  // collector's home and to directOptions. This pins the half that is testable: a registrar
  // given one home must not answer from another.
  const mine = await home(t, { 'command-code': { baseUrl: CC_BASE, authMode: 'oauth' } });
  const other = await home(t, { 'command-code': { baseUrl: 'https://relay.invalid', authMode: 'oauth' } });
  const binding = { provider: 'command-code', accountId: 'a', kind: 'oauth' };
  const here = directOptions({ QUOTA_DIRECT_PROVIDERS: 'command-code' }, { home: mine.dir });
  await here.directPrepare();
  assert.equal(here.directAdapters[0].appliesTo(binding), true);
  // Same environment, same provider, different home: the destination that decides this comes
  // from the configuration in that home, so a relay base refuses.
  const there = directOptions({ QUOTA_DIRECT_PROVIDERS: 'command-code' }, { home: other.dir });
  await there.directPrepare();
  assert.equal(there.directAdapters[0].appliesTo(binding), false);
});


test('a provider that declares no base uses its own default rather than reading nothing', async t => {
  // The credential contract calls an absent base 'default' and the transport accepts it
  // (acceptsDefaultBase). A registrar that stored null instead turned the feature into a
  // silent no-op on exactly the installs that never customised anything.
  const h = await home(t, { 'command-code': { authMode: 'oauth' } });
  const { directAdapters, directPrepare } = directOptions(
    { QUOTA_DIRECT_PROVIDERS: 'command-code' }, { home: h.dir });
  await directPrepare();
  assert.equal(directAdapters[0].appliesTo({ provider: 'command-code', accountId: 'a', kind: 'oauth' }), true);
  const go = await home(t, { 'opencode-go': {} });
  const other = directOptions({ QUOTA_DIRECT_PROVIDERS: 'opencode-go' }, { home: go.dir });
  await other.directPrepare();
  assert.equal(other.directAdapters[0].appliesTo({ provider: 'opencode-go', accountId: 'k', kind: 'key' }), true);
});

test('a base that is present but unusable stays refused instead of falling back to the default', async t => {
  // An absent base and a broken one are different states. Substituting the default for a
  // configuration that says something unusable would send a credential somewhere the operator
  // did not ask for.
  const binding = { provider: 'command-code', accountId: 'a', kind: 'oauth' };
  for (const [name, entry] of [
    ['empty string', { baseUrl: '', authMode: 'oauth' }],
    ['not a string', { baseUrl: 42, authMode: 'oauth' }],
    ['a relay', { baseUrl: 'https://relay.invalid', authMode: 'oauth' }],
    ['disabled', { disabled: true, authMode: 'oauth' }],
    // The readers compare a trimmed string and String.trim removes characters the URL parser
    // rejects, so a canonical address padded with a non-breaking space looks applicable to a
    // shape check while the transport refuses it. The registrar has to parse it the same way
    // the credential contract does, or the two disagree about what the configuration says.
    ['canonical padded with a non-breaking space', { baseUrl: CC_BASE + '\u00a0', authMode: 'oauth' }],
    ['a protocol that is not http', { baseUrl: 'ftp://api.commandcode.ai', authMode: 'oauth' }],
    ['not a URL at all', { baseUrl: 'api.commandcode.ai', authMode: 'oauth' }],
  ]) {
    const h = await home(t, { 'command-code': entry });
    const { directAdapters, directPrepare } = directOptions(
      { QUOTA_DIRECT_PROVIDERS: 'command-code' }, { home: h.dir });
    await directPrepare();
    assert.equal(directAdapters[0].appliesTo(binding), false, name);
  }
});

test('a repeated provider token does not publish the same endpoint twice', async t => {
  const h = await home(t, { 'command-code': { baseUrl: CC_BASE, authMode: 'oauth' } });
  const once = directOptions({ QUOTA_DIRECT_PROVIDERS: 'command-code' }, { home: h.dir });
  const twice = directOptions({ QUOTA_DIRECT_PROVIDERS: 'command-code, command-code ,command-code' }, { home: h.dir });
  const ids = options => options.directAdapters.map(a => a.provider + '/' + a.endpointId);
  // The response a reader sees must not depend on how many times the operator typed the name.
  assert.deepEqual(ids(twice), ids(once));
  assert.deepEqual(ids(once), ['command-code/credits']);
  // The same has always been true of the fixed list, which is filtered rather than mapped.
  const xai = directOptions({ QUOTA_DIRECT_PROVIDERS: 'xai,xai' }, { home: h.dir });
  assert.deepEqual(ids(xai), ['xai/grok-credits', 'xai/grok-billing']);
});

