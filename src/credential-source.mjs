import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';

// Read-only reuse of credentials that another client already owns. This module never
// writes a source file, never exchanges a refresh token, and never selects an account.
// Only the files named below are read: no other home and no keychain is probed.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const SOURCE_FILES = ['ocxConfig', 'ocxAuth', 'ocxCodexAccounts', 'codexAuth', 'claudeCredentials'];
export const PHYSICAL_BASES = ['native_account_id', 'chatgpt_account_id', 'credential_account_id',
  'key_material', 'provider_reported', 'none'];
// Where the provider's base address came from, which decides whether a stored credential can
// be sent to that provider's own endpoint at all.
//
// native  - read from the vendor's own client store, so the credential is the vendor's by
//           construction and no configured base can contradict it.
// default - the provider is configured and declares no base, so the client's own default
//           applies and that default is the official one.
// custom  - a base was declared. Only its origin is kept: a relay base can carry a key in
//           its path, and an origin cannot.
// invalid - a base was declared that is not a usable absolute URL.
// unknown - the provider's configuration could not be read, so nothing is known. A credential
//           whose destination is unknown is never spent.
export const BASE_URL_STATES = ['native', 'default', 'custom', 'invalid', 'unknown'];
// The auth file names the OpenAI provider differently from the configuration. Those
// accounts are read from the credential store instead, so the key is folded and skipped.
const OPENAI_AUTH_KEYS = ['chatgpt', 'openai-multi'];

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rows = value => Array.isArray(value) ? value.filter(record) : [];
// An identifier we publish or key on. The 200-character bound matches the projection's.
const name = value => typeof value === 'string' && value.length && value.length <= 200 ? value : null;
// A credential is not display text: it has no length ceiling and an empty string is absent.
// Using the display helper here would exclude a real access token and admit an empty one.
const secret = value => typeof value === 'string' && value.length > 0 ? value : null;
const stamp = value => Number.isFinite(value) && value > 0 ? value : null;
// An identifier that will be placed in a request header. A header value is not display text:
// a carriage return in it would split the request, so the shape is checked here rather than
// left to whatever the client does with it. The pipe admits Cursor's 'google-oauth2|...'.
const headerSafe = value => typeof value === 'string' &&
  /^[A-Za-z0-9._~@|:+-]{1,200}$/.test(value) ? value : null;

// Only the origin, never the whole base. Userinfo and path are dropped by construction.
//
// A base that is absent is a settled answer: the client's own default applies. A base that is
// PRESENT but unusable is not the same thing, and reading one as the other would turn a broken
// configuration into permission to send its credential to the vendor.
const baseUrlOf = (declared, configured) => {
  if (!configured) return { status: 'unknown', origin: null };
  const raw = declared?.baseUrl;
  if (raw === undefined || raw === null) return { status: 'default', origin: null };
  if (typeof raw !== 'string' || !raw.length) return { status: 'invalid', origin: null };
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { status: 'invalid', origin: null };
    return { status: 'custom', origin: url.origin };
  } catch { return { status: 'invalid', origin: null }; }
};
const NATIVE_BASE = { status: 'native', origin: null };

// A hash of a non-secret account or organisation identifier. Storable: it is not derived
// from a credential, so recording it as epoch evidence publishes nothing about the token.
// Exported so the public projection can record the same evidence for the same account.
// Two independent hashes would silently stop matching the moment either one changed.
export const identityDigest = value =>
  createHash('sha256').update('qm-epoch-v1\0').update(value).digest('hex');
const idDigest = (basis, value) => ({ basis, storable: true, digest: identityDigest(value) });
// Where the key itself is the only physical identifier, the comparison value is salted with
// a salt regenerated every process. It therefore cannot be persisted as a token hash, and
// storable:false keeps it out of the database entirely.
const PROCESS_SALT = randomBytes(32);
const keyDigest = value => ({ basis: 'key_material', storable: false,
  digest: createHmac('sha256', PROCESS_SALT).update(value).digest('hex') });
// No identifier at all. Identity cannot be proven across a restart, so it is treated as
// unverifiable rather than silently assumed to be the same account.
const noDigest = () => ({ basis: 'none', storable: false, digest: null });

async function readObject(path, read) {
  try {
    const raw = await read(path);
    if (raw.length > MAX_FILE_BYTES) return { status: 'oversized', value: null };
    const value = JSON.parse(raw.toString());
    if (!record(value)) return { status: 'malformed', value: null };
    return { status: 'ok', value };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', value: null };
    return { status: error instanceof SyntaxError ? 'malformed' : 'unreadable', value: null };
  }
}

// A pool entry is usable only when it still carries an access token and was not deleted.
// This is the same condition the public projection applies, so both sides agree on the roster.
const poolCredential = entry => {
  if (!record(entry) || entry.deletedAt) return null;
  const credential = record(entry.credential) ? entry.credential : entry;
  return secret(credential.accessToken);
};

// A file that is absent is a settled answer. A file that is unreadable mid-replacement is not,
// and only the latter may reuse a previously good roster.
const settled = status => status === 'ok' || status === 'missing';

/**
 * Read the configured credential sources and describe every account they can reach.
 * The returned value is JSON-safe and carries no credential: tokens stay in a closure
 * and are reachable only through token(bindingKey).
 */
export async function readCredentialSource({ home, codexHome = null, claudeHome = null,
  now = Date.now(), read = readFile } = {}) {
  const paths = {
    ocxConfig: join(home, 'config.json'),
    ocxAuth: join(home, 'auth.json'),
    ocxCodexAccounts: join(home, 'codex-accounts.json'),
    ...(codexHome ? { codexAuth: join(codexHome, 'auth.json') } : {}),
    ...(claudeHome ? { claudeCredentials: join(claudeHome, '.credentials.json') } : {}),
  };
  const read4 = await Promise.all(SOURCE_FILES.map(async key =>
    [key, paths[key] ? await readObject(paths[key], read) : { status: 'missing', value: null }]));
  const source = Object.fromEntries(read4);
  const files = Object.fromEntries(SOURCE_FILES.map(key => [key, { status: source[key].status }]));

  const config = source.ocxConfig.value ?? {};
  const auth = source.ocxAuth.value ?? {};
  const credentials = source.ocxCodexAccounts.value ?? {};
  const native = source.codexAuth.value ?? {};
  const claude = source.claudeCredentials.value ?? {};
  const configured = record(config.providers) ? config.providers : null;
  // A configuration whose provider map is not a record is a failed read, not an empty one.
  // The public projection reaches the same conclusion, so both sides agree on the status.
  if (configured === null && files.ocxConfig.status === 'ok') files.ocxConfig.status = 'malformed';

  const tokens = new Map();
  // A null prototype: a provider literally named __proto__ must become an own property
  // rather than reaching through to Object.prototype.
  const providers = Object.create(null);
  const nativeOnly = [];
  const bind = (provider, accountId, kind, physical, options = {}) => {
    const key = `${provider}\0${accountId}`;
    return { key, provider, accountId, kind, physical, token: options.token ?? null,
      tokenKind: options.kind ?? 'bearer',
      // Carried to the transport but never published: the upstream account identifier some
      // quota endpoints require in a header, and a configured organisation. The published
      // roster keeps only the digest of the first, as it always has.
      //
      // The organisation is whatever the configuration states, and no provider the client
      // ships states one today, so it is null in practice. In particular it does NOT open
      // Command Code's organisation-scoped read: the client reads that scope at runtime from
      // that provider's own whoami surface and keeps it neither in its configuration nor with
      // the stored login, so there is nothing here to read it from. A configuration that did
      // state an organisation would be carried like any other.
      accountRef: headerSafe(options.accountRef),
      organization: headerSafe(options.organization),
      baseUrl: options.baseUrl ?? { status: 'unknown', origin: null },
      deleted: options.deleted === true, needsReauth: options.needsReauth === true,
      expiresAt: stamp(options.expiresAt) };
  };
  const add = (provider, binding, dependsOn) => {
    const entry = providers[provider] ??= { enabled: true, rosterStatus: 'empty', bindings: [], sources: [] };
    for (const file of dependsOn) if (!entry.sources.includes(file)) entry.sources.push(file);
    // baseUrl travels with the credential and stops there. The roster publishes what an
    // account IS, not where its requests would go, and the transport is the only thing that
    // needs the destination.
    const { token, tokenKind, accountRef, organization, baseUrl, ...published } = binding;
    // Two rows claiming one public id cannot both be looked up: the physical evidence of the
    // first would be paired with the credential of the last. Keep the row so the published
    // roster still matches, but refuse the ambiguous credential.
    if (entry.bindings.some(existing => existing.accountId === published.accountId)) {
      tokens.delete(published.key);
      entry.bindings.push({ ...published, needsReauth: true, ambiguous: true });
      return;
    }
    if (token !== null) {
      tokens.set(published.key, { kind: tokenKind, value: token, accountRef, organization,
        baseUrl });
    }
    entry.bindings.push({ ...published, ambiguous: false });
  };
  const depend = (provider, dependsOn) => {
    const entry = providers[provider] ??= { enabled: true, rosterStatus: 'empty', bindings: [], sources: [] };
    for (const file of dependsOn) if (!entry.sources.includes(file)) entry.sources.push(file);
  };

  // Which providers exist at all. With a configuration it is the configured set, so the
  // public identifiers are unchanged. Without one the roster is rebuilt from the credential
  // stores, because a native-only install must still be readable.
  const nativeAccountId = record(native.tokens) ? name(native.tokens.account_id) : null;
  const providerIds = configured ? Object.keys(configured) : [...new Set([
    ...(nativeAccountId || Object.keys(credentials).length ? ['openai'] : []),
    ...Object.keys(auth).filter(id => record(auth[id]) && !OPENAI_AUTH_KEYS.includes(id)),
  ])];

  for (const id of providerIds) {
    const declared = configured && Object.hasOwn(configured, id) ? configured[id] : undefined;
    // The public projection skips a provider whose entry is not a record, so this one does
    // too. Registering its accounts anyway would query a provider nothing publishes.
    if (configured && !record(declared)) continue;
    const provider = record(declared) ? declared : {};
    depend(id, id === 'openai' ? ['ocxConfig', 'ocxCodexAccounts', 'codexAuth'] : ['ocxConfig', 'ocxAuth']);
    providers[id].enabled = provider.disabled !== true;
    // Where this provider's requests would go. A credential is only ever sent to an endpoint
    // that recognises this origin as the provider's own, so a relay base keeps its token.
    const base = baseUrlOf(provider, configured !== null);
    if (id === 'openai') {
      // The default account is always published, with or without a usable login, so the
      // roster lists it either way and marks it for reauthentication when it has no token.
      const mainToken = nativeAccountId ? secret(native.tokens.access_token) : null;
      add(id, bind(id, '__main__', 'native',
        nativeAccountId ? idDigest('native_account_id', nativeAccountId) : noDigest(),
        // The native login is read from the vendor's own client store, so the configured
        // base of the OCX provider says nothing about whose credential this is.
        { token: mainToken, needsReauth: mainToken === null, accountRef: nativeAccountId,
          baseUrl: NATIVE_BASE }), ['codexAuth']);
      // With a configuration the configured rows stay authoritative so the published
      // identifiers do not move. Without one the credential store is the only roster there is.
      const pool = configured ? rows(config.codexAccounts).filter(a => name(a.id))
        : Object.keys(credentials).filter(key => name(key) && poolCredential(credentials[key]) !== null)
            .map(key => ({ id: key }));
      for (const account of pool) {
        if (account.isMain === true || account.id === '__main__') continue;
        const entry = record(credentials[account.id]) ? credentials[account.id] : {};
        const credential = record(entry.credential) ? entry.credential : entry;
        const token = poolCredential(entry);
        const physical = name(credential.chatgptAccountId)
          ? idDigest('chatgpt_account_id', credential.chatgptAccountId) : noDigest();
        add(id, bind(id, account.id, 'pool', physical,
          { token, deleted: Boolean(entry.deletedAt), needsReauth: token === null,
            expiresAt: credential.expiresAt, accountRef: credential.chatgptAccountId,
            organization: provider.organization, baseUrl: base }), ['ocxCodexAccounts']);
      }
    } else {
      const set = record(auth[id]) ? auth[id] : {};
      for (const account of rows(set.accounts)) {
        if (!name(account.id)) continue;
        const credential = record(account.credential) ? account.credential : {};
        const token = secret(credential.access);
        const physical = name(credential.accountId)
          ? idDigest('credential_account_id', credential.accountId)
          // Devin's stored login has no accountId. Compare its token only in memory
          // so an account replacement cannot commit the previous account's reply.
          : id === 'devin' && token !== null ? keyDigest(token) : noDigest();
        add(id, bind(id, account.id, 'oauth', physical,
          { token, needsReauth: token === null || account.needsReauth === true,
            expiresAt: credential.expires, accountRef: credential.accountId,
            organization: provider.organization, baseUrl: base }), ['ocxAuth']);
      }
    }
    // API keys live only in the configuration, so an absent configuration has none. The
    // public projection does not publish key accounts for openai, whose accounts come from
    // the credential store instead, so neither does this roster.
    if (id === 'openai') continue;
    const pool = rows(provider.apiKeyPool);
    for (const entry of pool) {
      const key = secret(entry.key);
      if (!name(entry.id) || key === null) continue;
      add(id, bind(id, `key:${entry.id}`, 'key', keyDigest(key),
        { token: key, kind: 'api-key', organization: provider.organization, baseUrl: base }),
        ['ocxConfig']);
    }
    const bare = secret(provider.apiKey);
    if (bare !== null && !pool.some(entry => entry.key === bare)) {
      add(id, bind(id, 'key:default', 'key', keyDigest(bare),
        { token: bare, kind: 'api-key', organization: provider.organization, baseUrl: base }),
        ['ocxConfig']);
    }
  }

  // The native Claude credential has no account identifier, so it is registered without
  // being projected: publishing it would invent an account the rest of the product
  // does not know about. A later issue decides whether to promote it.
  const claudeToken = record(claude.claudeAiOauth) ? secret(claude.claudeAiOauth.accessToken) : null;
  if (claudeToken !== null) {
    const { token, tokenKind, accountRef, organization, baseUrl, ...published } =
      bind('anthropic-native', 'default', 'claude-native', noDigest(),
        { token: claudeToken, expiresAt: claude.claudeAiOauth.expiresAt, baseUrl: NATIVE_BASE });
    tokens.set(published.key, { kind: tokenKind, value: token, accountRef, organization,
      baseUrl });
    nativeOnly.push(published);
  }

  for (const entry of Object.values(providers)) {
    const broken = entry.sources.some(file => !settled(files[file].status));
    entry.rosterStatus = broken ? 'unavailable' : entry.bindings.length ? 'ok' : 'empty';
    delete entry.sources;
  }

  return { readAt: now, files, providers: { ...providers }, nativeOnly,
    token: key => { const found = tokens.get(key); return found ? { ...found } : null; } };
}
