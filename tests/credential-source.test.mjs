import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCredentialSource, SOURCE_FILES, BASE_URL_STATES } from '../src/credential-source.mjs';
import { readSnapshot } from '../src/snapshot.mjs';

const NOW = 1800000000000;
// Distinct sentinels per account. One shared value would hide exactly the per-account
// binding mistakes these tests exist to catch.
const MAIN = 'SENTINEL_MAIN_TOKEN', POOL = 'SENTINEL_POOL_TOKEN', CLAUDE = 'SENTINEL_CLAUDE_TOKEN';
const GROK = 'SENTINEL_GROK_TOKEN', DEVIN = 'SENTINEL_DEVIN_TOKEN', KEY = 'SENTINEL_API_KEY';
const ALL = [MAIN, POOL, CLAUDE, GROK, DEVIN, KEY];

async function fixture(t) {
 const home = await mkdtemp(join(tmpdir(), 'quota-credential-'));
 const codexHome = join(home, 'native'), claudeHome = join(home, 'claude');
 await mkdir(codexHome); await mkdir(claudeHome);
 t.after(() => rm(home, { recursive: true, force: true }));
 const files = {
  'config.json': { providers: {
    openai: {},
    xai: { models: ['grok-4.6'] },
    devin: {},
    'ollama-cloud': { apiKeyPool: [{ id: 'k1', key: KEY }] },
  }, codexAccounts: [{ id: 'pool1', email: 'someone@example.com', plan: 'pro' }] },
  'auth.json': {
    xai: { accounts: [{ id: 'g1', credential: { access: GROK, accountId: 'xai-physical', expires: NOW + 3600000 } }] },
    // Devin carries no accountId, so only process-local token equality is provable.
    devin: { accounts: [{ id: 'd1', credential: { access: DEVIN } }] },
    // The auth file names OpenAI differently; those accounts come from the credential store.
    chatgpt: { accounts: [{ id: 'ignored', credential: { access: 'SENTINEL_IGNORED' } }] },
  },
  'codex-accounts.json': {
    pool1: { credential: { accessToken: POOL, chatgptAccountId: 'pool-physical' }, generation: 3 },
    removed: { generation: 2, deletedAt: NOW },
  },
  'codex-quota-cache.json': { version: 1, quotas: {} },
  'provider-account-quota-cache.json': { version: 1, rows: {} },
 };
 const save = (name, value) => writeFile(join(home, name), JSON.stringify(value));
 for (const [name, value] of Object.entries(files)) await save(name, value);
 await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'main-physical', access_token: MAIN } }));
 await writeFile(join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE, expiresAt: NOW + 7200000 } }));
 // Files that must never be read. Their presence is the point.
 await writeFile(join(home, 'keychain.json'), JSON.stringify({ secret: 'SENTINEL_KEYCHAIN' }));
 await mkdir(join(home, 'other-home'));
 await writeFile(join(home, 'other-home', 'auth.json'), JSON.stringify({ secret: 'SENTINEL_OTHER_HOME' }));
 const read = async path => { read.paths.push(path); return readFile(path); };
 read.paths = [];
 return { home, codexHome, claudeHome, files, save, read,
   load: (options = {}) => readCredentialSource({ home, codexHome, claudeHome, now: NOW, ...options }) };
}

test('only the allowed credential paths are read, and never a keychain or another home', async t => {
 const f = await fixture(t);
 const source = await f.load({ read: f.read });
 // The returned key set is one check; the paths actually handed to the reader are the
 // stronger one, because a key set cannot show what was opened.
 assert.deepEqual(Object.keys(source.files).sort(), [...SOURCE_FILES].sort());
 assert.deepEqual(f.read.paths.sort(), [
   join(f.claudeHome, '.credentials.json'), join(f.codexHome, 'auth.json'),
   join(f.home, 'auth.json'), join(f.home, 'codex-accounts.json'), join(f.home, 'config.json'),
 ].sort());
 assert.equal(f.read.paths.some(path => path.includes('keychain')), false);
 assert.equal(f.read.paths.some(path => path.includes('other-home')), false);
});

test('no credential reaches the returned value through serialisation or inspection', async t => {
 const f = await fixture(t);
 const source = await f.load();
 // A symbol-keyed property would survive util.inspect even though JSON.stringify drops it,
 // so both are checked. Tokens live in a closure instead.
 for (const shape of [JSON.stringify(source), inspect(source, { depth: null })]) {
  for (const sentinel of ALL) assert.equal(shape.includes(sentinel), false, sentinel);
 }
 // The accessor still returns them, so the reader is actually useful.
 // The routing material travels with the token, in the closure, so a transport can build a
 // header without any of it reaching the published roster.
 assert.deepEqual(source.token('openai\0__main__'), { kind: 'bearer', value: MAIN,
   accountRef: 'main-physical', organization: null, baseUrl: { status: 'native', origin: null } });
 assert.deepEqual(source.token('openai\0pool1'), { kind: 'bearer', value: POOL,
   accountRef: 'pool-physical', organization: null, baseUrl: { status: 'default', origin: null } });
 assert.deepEqual(source.token('ollama-cloud\0key:k1'), { kind: 'api-key', value: KEY,
   accountRef: null, organization: null, baseUrl: { status: 'default', origin: null } });
 assert.equal(source.token('openai\0absent'), null);
});

test('physical identity comes from the files, and a missing identifier is not invented', async t => {
 const f = await fixture(t);
 const source = await f.load();
 const find = (provider, id) => source.providers[provider].bindings.find(b => b.accountId === id);
 assert.equal(find('openai', '__main__').physical.basis, 'native_account_id');
 assert.equal(find('openai', '__main__').physical.storable, true);
 assert.equal(find('openai', 'pool1').physical.basis, 'chatgpt_account_id');
 assert.equal(find('xai', 'g1').physical.basis, 'credential_account_id');
 assert.equal(find('xai', 'g1').expiresAt, NOW + 3600000);
 // Devin has no accountId. Guessing one would merge two physical accounts behind one id.
 assert.equal(find('devin', 'd1').physical.basis, 'key_material');
 assert.equal(find('devin', 'd1').physical.storable, false);
 assert.equal(typeof find('devin', 'd1').physical.digest, 'string');
 // An API key is its own only identifier, so its digest must not be storable.
 const key = find('ollama-cloud', 'key:k1');
 assert.equal(key.physical.basis, 'key_material');
 assert.equal(key.physical.storable, false);
 assert.ok(key.physical.digest);
 // The digest is salted per process, so it is not a reproducible hash of the key.
 assert.notEqual(key.physical.digest, createHash('sha256').update(KEY).digest('hex'));
});

test('a deleted entry stays in the roster but is not queryable, and a tokenless one needs reauth', async t => {
 const f = await fixture(t);
 const config = f.files['config.json'];
 config.codexAccounts.push({ id: 'removed' }, { id: 'tokenless' });
 await f.save('config.json', config);
 const accounts = f.files['codex-accounts.json'];
 accounts.tokenless = { credential: { chatgptAccountId: 'tokenless-physical' } };
 await f.save('codex-accounts.json', accounts);
 const source = await f.load();
 const find = id => source.providers.openai.bindings.find(b => b.accountId === id);
 // Present, because the public projection still shows it; flagged, so no lookup is attempted.
 assert.equal(find('removed').deleted, true);
 assert.equal(find('tokenless').deleted, false);
 assert.equal(find('tokenless').needsReauth, true);
 assert.equal(source.token('openai\0tokenless'), null);
});

test('the native Claude credential is registered without being projected as an account', async t => {
 const f = await fixture(t);
 const source = await f.load();
 // Projecting it would invent an account the rest of the product does not know about.
 assert.equal(Object.keys(source.providers).includes('anthropic-native'), false);
 assert.deepEqual(source.nativeOnly.map(b => b.accountId), ['default']);
 assert.deepEqual(source.token('anthropic-native\0default'), { kind: 'bearer', value: CLAUDE,
  accountRef: null, organization: null, baseUrl: { status: 'native', origin: null } });
});

test('a configured base is reduced to its origin, and an unreadable one stays unknown', async t => {
 const f = await fixture(t);
 const config = f.files['config.json'];
 // A relay base often carries a key in its path, so only the origin is ever kept.
 config.providers.xai = { baseUrl: 'https://relay.example/v1/SENTINEL_PATH_KEY' };
 config.providers.devin = { baseUrl: 'not a url' };
 await f.save('config.json', config);
 const source = await f.load();
 const base = key => source.token(key).baseUrl;
 assert.deepEqual(base('xai\0g1'), { status: 'custom', origin: 'https://relay.example' });
 assert.equal(JSON.stringify(source).includes('SENTINEL_PATH_KEY'), false);
 assert.deepEqual(base('devin\0d1'), { status: 'invalid', origin: null });
 // The destination travels with the credential and stops there. The roster publishes what an
 // account is, not where its requests would go.
 const binding = source.providers.xai.bindings.find(b => b.accountId === 'g1');
 assert.equal('baseUrl' in binding, false);
 assert.equal(JSON.stringify(source).includes('relay.example'), false);
 // A base that is present but unusable is not the same as one that is absent. Reading the
 // first as the second would turn a broken configuration into permission to send its
 // credential to the vendor.
 const broken = f.files['config.json'];
 for (const value of [false, 17, {}, ['https://relay.example'], '']) {
  broken.providers.xai = { baseUrl: value };
  await f.save('config.json', broken);
  assert.deepEqual((await f.load()).token('xai\0g1').baseUrl,
    { status: 'invalid', origin: null }, JSON.stringify(value));
 }
 // Without a configuration nothing is known about where a provider's requests would go.
 await rm(join(f.home, 'config.json'));
 const blind = await f.load();
 assert.deepEqual(blind.token('xai\0g1').baseUrl, { status: 'unknown', origin: null });
 // The native login is read from the vendor's own store, so it is unaffected either way.
 assert.deepEqual(blind.token('openai\0__main__').baseUrl, { status: 'native', origin: null });
});

test('an account reference that cannot be a header value is dropped rather than carried', async t => {
 const f = await fixture(t);
 const auth = f.files['auth.json'];
 auth.cursor = { accounts: [{ id: 'c1', credential: { access: 'SENTINEL_CURSOR', accountId: 'google-oauth2|1234' } }] };
 // A carriage return in a header value splits the request. It is refused here, where the
 // value is read, rather than left to whatever the client does with it.
 auth.xai.accounts[0].credential.accountId = 'xai\r\nX-Injected: 1';
 await f.save('auth.json', auth);
 const config = f.files['config.json'];
 config.providers.cursor = {};
 await f.save('config.json', config);
 const source = await f.load();
 assert.equal(source.token('cursor\0c1').accountRef, 'google-oauth2|1234');
 assert.equal(source.token('xai\0g1').accountRef, null);
 // The physical identity still comes from the same field, so dropping the header value
 // does not make the account unidentifiable.
 assert.equal(source.providers.xai.bindings.find(b => b.accountId === 'g1').physical.basis,
   'credential_account_id');
});

test('every base state the reader can produce is declared, and a configured organisation travels with the token', async t => {
 const f = await fixture(t);
 const config = f.files['config.json'];
 // The organisation a later provider selects with. It is not published, for the same reason
 // the account reference is not: the roster publishes a digest, not the identifier.
 config.providers.xai = { organization: 'org-7' };
 config.providers.devin = { baseUrl: 'ftp://files.example' };
 await f.save('config.json', config);
 const configured = await f.load();
 assert.equal(configured.token('xai\0g1').organization, 'org-7');
 assert.equal(JSON.stringify(configured).includes('org-7'), false);
 const seen = new Set([configured.token('openai\0__main__').baseUrl.status,
   configured.token('xai\0g1').baseUrl.status, configured.token('devin\0d1').baseUrl.status,
   configured.token('ollama-cloud\0key:k1').baseUrl.status]);
 await rm(join(f.home, 'config.json'));
 seen.add((await f.load()).token('xai\0g1').baseUrl.status);
 // Four of the five states come out of ordinary reads; 'custom' is covered above. A state the
 // reader can produce but the vocabulary does not name would leave the transport guessing.
 assert.deepEqual([...seen].sort(), ['default', 'invalid', 'native', 'unknown']);
 for (const status of [...seen, 'custom']) assert.ok(BASE_URL_STATES.includes(status), status);
});

test('the roster matches the published account ids with and without a configuration', async t => {
 const f = await fixture(t);
 const ids = value => [...value].sort();
 for (const mode of ['configured', 'native-only']) {
  if (mode === 'native-only') await rm(join(f.home, 'config.json'));
  const source = await f.load();
  const snapshot = await readSnapshot(f.home, NOW, f.codexHome);
  const published = ids(snapshot.providers.flatMap(p => p.accounts.map(a => `${p.id}\0${a.id}`)));
  const roster = ids(Object.entries(source.providers)
    .flatMap(([id, entry]) => entry.bindings.map(b => `${id}\0${b.accountId}`)));
  assert.deepEqual(roster, published, mode);
 }
});

test('reading never modifies a source file', async t => {
 const f = await fixture(t);
 const watched = [join(f.home, 'config.json'), join(f.home, 'auth.json'),
   join(f.home, 'codex-accounts.json'), join(f.codexHome, 'auth.json'),
   join(f.claudeHome, '.credentials.json')];
 const digest = async () => Promise.all(watched.map(async path => {
  const info = await stat(path);
  return `${createHash('sha256').update(await readFile(path)).digest('hex')}:${info.mtimeMs}`;
 }));
 const before = await digest();
 await f.load(); await f.load();
 assert.deepEqual(await digest(), before);
});

test('a roster whose file is being replaced is unavailable, while an absent file is settled', async t => {
 const f = await fixture(t);
 await writeFile(join(f.home, 'auth.json'), '{truncated');
 let source = await f.load();
 // Mid-replacement is not a settled answer, so the caller may briefly reuse a good roster.
 assert.equal(source.files.ocxAuth.status, 'malformed');
 assert.equal(source.providers.xai.rosterStatus, 'unavailable');
 await rm(join(f.home, 'auth.json'));
 source = await f.load();
 // An absent file is settled: the accounts are gone and no lookup should continue.
 assert.equal(source.files.ocxAuth.status, 'missing');
 assert.equal(source.providers.xai.rosterStatus, 'empty');
});

test('an ambiguous public id refuses its credential instead of pairing the wrong one', async t => {
 const f = await fixture(t);
 const config = f.files['config.json'];
 // A pooled entry literally called 'default' collides with the bare-key account. Both rows
 // are published, so both stay in the roster, but a lookup cannot choose between them.
 config.providers['ollama-cloud'] = { apiKeyPool: [{ id: 'default', key: 'SENTINEL_POOL_KEY' }], apiKey: 'SENTINEL_BARE_KEY' };
 await f.save('config.json', config);
 const source = await f.load();
 const bindings = source.providers['ollama-cloud'].bindings.filter(b => b.accountId === 'key:default');
 assert.equal(bindings.length, 2);
 assert.equal(bindings[1].ambiguous, true);
 assert.equal(bindings[1].needsReauth, true);
 // Neither token is served: the first row's physical evidence would otherwise be paired
 // with the second row's key, which is how one account's usage lands on another.
 assert.equal(source.token('ollama-cloud\0key:default'), null);
});

test('the roster still matches the published ids in the awkward configurations', async t => {
 const f = await fixture(t);
 const ids = value => [...value].sort();
 const compare = async label => {
  const source = await f.load();
  const snapshot = await readSnapshot(f.home, NOW, f.codexHome);
  assert.deepEqual(
    ids(Object.entries(source.providers).flatMap(([id, e]) => e.bindings.map(b => `${id}\0${b.accountId}`))),
    ids(snapshot.providers.flatMap(p => p.accounts.map(a => `${p.id}\0${a.id}`))), label);
 };
 // The default account is published even with no usable native login.
 await writeFile(join(f.codexHome, 'auth.json'), '{}');
 await compare('no native login');
 // OpenAI key accounts are not published: those accounts come from the credential store.
 const config = f.files['config.json'];
 config.providers.openai = { apiKey: 'SENTINEL_OPENAI_KEY', apiKeyPool: [{ id: 'p', key: 'SENTINEL_OPENAI_POOL' }] };
 await f.save('config.json', config);
 await compare('openai api keys');
 // A provider entry that is not a record is skipped by the projection, so it is skipped here.
 config.providers.xai = null;
 await f.save('config.json', config);
 await compare('null provider entry');
});

test('a provider map that is not a record counts as a failed read, not an empty one', async t => {
 const f = await fixture(t);
 // The file parses, so a naive check would call it healthy and the caller would treat the
 // empty roster as settled instead of briefly reusing the last good one.
 await f.save('config.json', { providers: [] });
 const source = await f.load();
 assert.equal(source.files.ocxConfig.status, 'malformed');
 for (const entry of Object.values(source.providers)) assert.equal(entry.rosterStatus, 'unavailable');
});

test('a refreshed token from the real reader keeps the same boundary', async t => {
 const f = await fixture(t);
 const { createBindingRegistry } = await import('../src/account-binding.mjs');
 const { openHistory } = await import('../src/history.mjs');
 const dir = await mkdtemp(join(tmpdir(), 'quota-credential-epoch-'));
 const store = await openHistory(dir);
 t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
 const registry = createBindingRegistry({ store, now: () => NOW });
 const poolBinding = async () => (await f.load()).providers.openai.bindings.find(b => b.accountId === 'pool1');
 const first = registry.resolve(await poolBinding());
 // Rotate only the access token in the real file, exactly as another client would.
 const accounts = f.files['codex-accounts.json'];
 accounts.pool1.credential.accessToken = 'SENTINEL_POOL_ROTATED';
 await f.save('codex-accounts.json', accounts);
 const after = registry.resolve(await poolBinding());
 assert.equal(after.epoch, first.epoch);
 assert.equal(after.changed, false);
 // Replacing the physical account in the same file does start a new boundary.
 accounts.pool1.credential.chatgptAccountId = 'pool-physical-b';
 await f.save('codex-accounts.json', accounts);
 const replaced = registry.resolve(await poolBinding());
 assert.equal(replaced.reason, 'physical_changed');
 assert.notEqual(replaced.epoch, first.epoch);
 // Nothing token-derived reached the epoch table on any of those transitions.
 const dump = JSON.stringify(store.db.prepare('SELECT * FROM identity_epochs').all());
 for (const sentinel of [...ALL, 'SENTINEL_POOL_ROTATED']) assert.equal(dump.includes(sentinel), false, sentinel);
});
