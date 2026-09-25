import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { modelId, carriesSecret } from '../src/snapshot.mjs';

test('a known key is excluded through model syntax decoration, and a name fragment is not', () => {
 const key = 'SYNTHETIC_ONLY_KNOWN_KEY_93af', secrets = new Set([key]);
 // modelId admits all of these shapes, so only the secret rule can keep them out.
 for (const shape of [key, `${key}[1m]`, `vendor/${key}:latest`, `hf:${key}`, `x${key}/${key}`,
   `${key}:latest`, `aa:${key}:bb`, `vendor/${key}`]) assert.equal(carriesSecret(shape, secrets), true, shape);
 // A secret that itself contains a delimiter, and overlapping occurrences where only the
 // later one is bounded: scanning must advance one character, not one whole match.
 assert.equal(carriesSecret('a/user:pass/b', new Set(['user:pass'])), true);
 assert.equal(carriesSecret('xa/a/a', new Set(['a/a'])), true);
 // In-word characters are deliberately not delimiters: a raw substring rule once deleted
 // 126 real model names, so a key that is only a fragment must delete nothing.
 for (const shape of [`${key}-x`, `${key}.v2`, `${key}@1`, `${key}_x`, `x${key}`])
   assert.equal(carriesSecret(shape, secrets), false, shape);
 for (const fragment of ['gpt', 'gemini-3', 'g'])
   for (const model of ['gpt-5.6-luna', 'gpt-6-astra', 'gpt-oss:120b', 'gemini-3.8-flash', 'grok-4.6', 'k3[1m]'])
     assert.equal(carriesSecret(model, new Set([fragment])), false, `${fragment} vs ${model}`);
 // The accepted collision: a key written as a whole piece of a real id removes that id.
 // Intended, and it cannot be avoided without reopening the decorated-key exposure.
 assert.equal(carriesSecret('k3[1m]', new Set(['k3'])), true);
 assert.equal(carriesSecret('gpt-oss:120b', new Set(['gpt-oss'])), true);
 assert.equal(carriesSecret('~anthropic/claude-opus-latest', new Set(['anthropic'])), true);
});

test('a home or config path is not a model id, while the catalog alias still is', () => {
 for (const path of ['~jun/.opencodex/config.json', '~/.opencodex/x', '.opencodex/config.json',
   'a/.b/c', '~a/b/c', '~a', '~/config.json', '~root/x/y',
   // A second tilde anywhere is a home reference too: checking only the first occurrence
   // let these through.
   '~~jun/config.json', '~jun/~config.json', '~jun/config~.json', '~a~', 'a~b'])
   assert.equal(modelId(path), null, path);
 for (const id of ['~anthropic/claude-opus-latest', 'k3[1m]', 'glm-5.3[1m]', 'claude-opus-4-8[1m]',
   'gpt-oss:120b', 'qwen3.5:397b', 'deepseek-v4-flash:0731', 'Pro/deepseek-ai/DeepSeek-V3',
   'claude-sonnet-4@20250514', 'fireworks_ai/accounts/fireworks/models/inkling', 'auto'])
   assert.equal(modelId(id), id, id);
});
import { readSnapshot, SOURCE_STATUS } from '../src/snapshot.mjs';
const now = 1800000000000;
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'quota-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const native = join(home, 'native'); await mkdir(native);
  const files = {
    'config.json': { providers: { openai: {}, anthropic: {}, 'ollama-cloud': { apiKey: 'SECRET_SENTINEL', apiKeyPool: [{ id: 'k1', key: 'SECRET_SENTINEL' }] } }, codexAccounts: [{ id: 'pool1', email: 'someone@example.com', plan: 'pro' }], activeCodexAccountId: 'pool1' },
    'auth.json': { anthropic: { activeAccountId: 'a1', accounts: [{ id: 'a1', credential: { access: 'SECRET_SENTINEL', email: 'person@example.com' } }, { id: 'a2', credential: { access: 'SECRET_SENTINEL' } }] } },
    'codex-accounts.json': { pool1: { credential: { accessToken: 'SECRET_SENTINEL' } }, deleted: { deletedAt: now } },
    'codex-quota-cache.json': { version: 1, quotas: { pool1: { updatedAt: now, weeklyPercent: 80, weeklyResetAt: now / 1000 + 3600 }, deleted: { weeklyPercent: 10 } }, mainPolicyQuota: { identityKey: createHash('sha256').update('opencodex-main-quota-v1\0physical').digest('hex'), quota: { updatedAt: now, weeklyPercent: 0 } } },
    'provider-account-quota-cache.json': { version: 1, rows: { 'anthropic\0a1': { updatedAt: now, fiveHourPercent: 100, fiveHourResetAt: now + 3600000 }, 'anthropic\0a2': { updatedAt: now - 7 * 3600000, weeklyPercent: 23 } } },
  };
  const save = async (name, value) => writeFile(join(home, name), JSON.stringify(value));
  for (const [n, d] of Object.entries(files)) await save(n, d);
  await writeFile(join(native, 'auth.json'), JSON.stringify({ tokens: { account_id: 'physical', access_token: 'SECRET_SENTINEL' } }));
  return { home, native, files, save, read: () => readSnapshot(home, now, native) };
}
test('separate accounts, percentage extremes, unit conversion, stale and secret allowlist', async t => {
  const f = await fixture(t); const d = await f.read();
  assert.equal(d.providers.length, 3);
  const [openai, anthropic, ollama] = d.providers;
  assert.equal(openai.accounts.length, 2); assert.equal(openai.accounts[0].windows[0].remainingPercent, 100);
  assert.equal(openai.accounts[1].windows[0].remainingPercent, 20); assert.equal(openai.accounts[1].active, true);
  assert.equal(openai.accounts[1].windows[0].resetAt, '2027-01-15T09:00:00.000Z');
  assert.equal(anthropic.accounts[0].windows[0].resetAt, '2027-01-15T09:00:00.000Z');
  assert.equal(anthropic.accounts[0].windows[0].remainingPercent, 0);
  assert.equal(anthropic.accounts[1].status, 'stale');
  assert.equal(ollama.accounts.length, 1); assert.equal(ollama.accounts[0].status, 'unavailable');
  assert.equal(JSON.stringify(d).includes('SECRET_SENTINEL'), false);
  assert.equal(JSON.stringify(d).includes('someone@example.com'), false);
  assert.deepEqual(Object.keys(openai.accounts[0]).sort(), ['active','id','label','plan','quotaMode','status','updatedAt','windows'].sort());
});
test('main identity mismatch never reads alias cache', async t => {
  const f = await fixture(t); const q = f.files['codex-quota-cache.json']; q.mainPolicyQuota.identityKey = 'wrong'; q.quotas.__main__ = { updatedAt: now, weeklyPercent: 77 }; await f.save('codex-quota-cache.json', q);
  assert.equal((await f.read()).providers[0].accounts[0].status, 'unavailable');
});
test('expired resets, future timestamps and missing metrics remain honest', async t => {
  const f = await fixture(t); const p = f.files['provider-account-quota-cache.json'];
  p.rows['anthropic\0a1'] = { updatedAt: now, weeklyPercent: 20, weeklyResetAt: now - 1000 };
  p.rows['anthropic\0a2'] = { updatedAt: now + 120000, weeklyPercent: 12, monthlyPercent: '80', customWindows: [{ percent: -1 }] };
  await f.save('provider-account-quota-cache.json', p);
  const a = (await f.read()).providers[1].accounts; assert.equal(a[0].status, 'stale'); assert.equal(a[1].status, 'stale'); assert.equal(a[1].windows.length, 1);
});
test('malformed optional source produces warning; a failed read stays distinguishable', async t => {
  const f = await fixture(t); await writeFile(join(f.home, 'auth.json'), '{SECRET_SENTINEL');
  const d = await f.read(); assert.ok(d.warnings.length); assert.equal(JSON.stringify(d).includes('SECRET_SENTINEL'), false);
  assert.equal(d[SOURCE_STATUS].files.ocxAuth.status, 'malformed');
  // The configuration is no longer required: a native login alone still reports accounts.
  // It must not fail closed, and it must not pass as a healthy empty configuration either.
  await f.save('config.json', []);
  const broken = await f.read();
  assert.ok(broken.warnings.length);
  assert.equal(broken[SOURCE_STATUS].files.ocxConfig.status, 'malformed');
  assert.ok(broken.providers.some(p => p.id === 'openai'));
  assert.equal(JSON.stringify(broken).includes('SECRET_SENTINEL'), false);
});

test('a read failure and a genuinely empty model list are different states', async t => {
  const f = await fixture(t);
  // Same published shape in all three cases — an empty supportedModels — so only the
  // recorded status can tell "could not read" apart from "really is empty".
  const config = f.files['config.json'];
  config.providers = { openai: {}, anthropic: { models: [] }, xai: { models: 'not-a-list' } };
  await f.save('config.json', config);
  const healthy = await f.read();
  const status = healthy[SOURCE_STATUS];
  assert.equal(status.files.ocxConfig.status, 'ok');
  assert.equal(status.providers.anthropic.modelListStatus, 'ok');
  assert.equal(status.providers.openai.modelListStatus, 'absent');
  assert.equal(status.providers.xai.modelListStatus, 'invalid');
  for (const id of ['anthropic', 'xai']) {
    assert.deepEqual(healthy.providers.find(p => p.id === id).supportedModels, []);
  }
  // A configuration that cannot be read is not the same as one listing nothing.
  await writeFile(join(f.home, 'config.json'), '{truncated');
  const failed = await f.read();
  assert.equal(failed[SOURCE_STATUS].files.ocxConfig.status, 'malformed');
  assert.notEqual(failed[SOURCE_STATUS].files.ocxConfig.status, status.files.ocxConfig.status);
});

test('a native-only install reports its pool accounts without any configuration', async t => {
  const f = await fixture(t);
  // No configuration at all: the credential store is the only roster there is.
  await rm(join(f.home, 'config.json'));
  const d = await f.read();
  const openai = d.providers.find(p => p.id === 'openai');
  assert.ok(openai, 'openai provider is rebuilt from the credential stores');
  assert.equal(d[SOURCE_STATUS].files.ocxConfig.status, 'missing');
  assert.equal(d[SOURCE_STATUS].providers.openai.modelListStatus, 'absent');
  // __main__ plus the one pool entry that still holds an access token. The deleted entry
  // has no credential, so neither roster lists it.
  assert.deepEqual(openai.accounts.map(a => a.id).sort(), ['__main__', 'pool1']);
  assert.equal(JSON.stringify(d).includes('SECRET_SENTINEL'), false);
});
test('missing pool credentials do not show cached quota', async t => {
  const f = await fixture(t); await f.save('codex-accounts.json', {});
  const a = (await f.read()).providers[0].accounts[1]; assert.equal(a.status, 'reauth'); assert.deepEqual(a.windows, []);
});
test('legacy credentials remain readable and missing main identity remains visible',async t=>{
 const f=await fixture(t);await f.save('codex-accounts.json',{pool1:{accessToken:'SECRET_SENTINEL'}});await writeFile(join(f.native,'auth.json'),'{}');
 const d=await f.read();assert.equal(d.providers[0].accounts[0].status,'unavailable');assert.equal(d.providers[0].accounts[1].status,'ok');assert.ok(d.warnings.length);
});
