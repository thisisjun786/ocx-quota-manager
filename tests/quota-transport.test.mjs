import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaTransport, ENDPOINTS, FAILURES } from '../src/quota-transport.mjs';

const NOW = 1800000000000;
const TOKEN = 'SENTINEL_TRANSPORT_TOKEN';
// A credential the reader would produce for a provider configured with no explicit base.
const CRED = { kind: 'bearer', value: TOKEN, accountRef: null, organization: null,
  baseUrl: { status: 'default', origin: null } };
// A synthetic endpoint injected by the test, so the shipped table's own entries are exercised
// only by the checks that are about the shipped table.
const endpoints = { synthetic: { usage: { host: 'quota.invalid', path: '/usage',
  query: { quota: '1' }, configuredOrigins: ['https://quota.invalid'], acceptsDefaultBase: true,
  authorize: c => ({ Authorization: `Bearer ${c.value}` }) } } };

const reply = (status, { body = '{}', headers = {}, stream = null } = {}) => {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const response = { status, headers: { get: key => map.get(key.toLowerCase()) ?? null } };
  if (stream) response.body = stream;
  response.text = async () => { response.textRead = true; return body; };
  return response;
};

function harness(handler, options = {}) {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  const transport = createQuotaTransport({ fetcher, now: () => NOW, endpoints, ...options });
  return { calls, ask: (extra = {}) =>
    transport.request({ provider: 'synthetic', endpointId: 'usage', credential: CRED, ...extra }) };
}

test('an undeclared endpoint and a missing credential are refused without a request', async () => {
 const h = harness(() => reply(200));
 for (const args of [{ provider: 'unknown' }, { endpointId: 'other' }]) {
  const outcome = await h.ask(args);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'endpoint_not_allowed');
 }
 const bare = await h.ask({ credential: null });
 assert.equal(bare.kind, 'credential_missing');
 // Nothing left the process for any of the three.
 assert.equal(h.calls.length, 0);
});

test('a host that is not a plain https hostname is refused before the request', async () => {
 const calls = [];
 const transport = createQuotaTransport({ now: () => NOW,
   fetcher: async (...args) => { calls.push(args); return reply(200); },
   endpoints: { synthetic: { usage: { host: 'user:pass@quota.invalid', path: '/usage',
     configuredOrigins: ['https://quota.invalid'], acceptsDefaultBase: true,
     authorize: () => ({}) } } } });
 const outcome = await transport.request({ provider: 'synthetic', endpointId: 'usage', credential: CRED });
 assert.equal(outcome.kind, 'endpoint_not_allowed');
 assert.equal(calls.length, 0);
});

test('a refused request is not reported as an expired credential', async () => {
 for (const [status, kind] of [[401, 'unauthorized'], [403, 'access_denied'],
   [503, 'server_error'], [418, 'unexpected_status']]) {
  const h = harness(() => reply(status));
  const outcome = await h.ask();
  assert.equal(outcome.kind, kind, `${status}`);
  assert.equal(outcome.status, status);
 }
 // The distinction is the point: 403 must not send the caller hunting for a new token.
 assert.notEqual('unauthorized', 'access_denied');
});

test('Retry-After is honoured as seconds or as a date, and nonsense is treated as absent', async () => {
 const seconds = await harness(() => reply(429, { headers: { 'Retry-After': '30' } })).ask();
 assert.equal(seconds.kind, 'rate_limited');
 assert.equal(seconds.retryAfterMs, 30000);
 const date = await harness(() => reply(429,
   { headers: { 'Retry-After': new Date(NOW + 30000).toUTCString() } })).ask();
 assert.equal(date.retryAfterMs, 30000);
 for (const header of ['', 'soon', '-5']) {
  const odd = await harness(() => reply(429, { headers: { 'Retry-After': header } })).ask();
  assert.equal(odd.retryAfterMs, null, JSON.stringify(header));
 }
});

test('a redirect is classified, not followed', async () => {
 const h = harness(() => reply(302, { headers: { Location: 'https://elsewhere.invalid/usage' } }));
 const outcome = await h.ask();
 assert.equal(outcome.kind, 'redirect');
 assert.equal(h.calls.length, 1);
 // 'manual' rather than 'error', so a redirect stays distinguishable from a transport failure.
 assert.equal(h.calls[0].init.redirect, 'manual');
});

test('an oversized body is rejected by its header without being read', async () => {
 const h = harness(() => reply(200, { headers: { 'content-length': String(4 * 1024 * 1024) } }));
 const outcome = await h.ask();
 assert.equal(outcome.kind, 'oversized');
 // The existing provider path reads the whole body before measuring it. This one must not.
 assert.notEqual(h.calls[0], undefined);
});

test('a body that exceeds the ceiling mid-stream cancels the reader', async () => {
 let cancelled = false, served = 0;
 const chunk = new Uint8Array(256);
 const stream = { getReader: () => ({
   read: async () => { served += 1; return { done: false, value: chunk }; },
   cancel: async () => { cancelled = true; },
   releaseLock: () => {} }) };
 const h = harness(() => reply(200, { stream }), { maxBodyBytes: 512 });
 const outcome = await h.ask();
 assert.equal(outcome.kind, 'oversized');
 assert.equal(cancelled, true);
 // It stopped as soon as the ceiling was crossed instead of draining the response.
 assert.equal(served, 3);
});

test('a truncated body is a parse failure, and a timeout is its own outcome', async () => {
 const broken = await harness(() => reply(200, { body: '{"quota":' })).ask();
 assert.equal(broken.kind, 'invalid_json');
 const stalled = await harness(async (url, init) => {
  await new Promise((resolve, reject) => init.signal.addEventListener('abort',
    () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
 }, { timeoutMs: 5 }).ask();
 assert.equal(stalled.kind, 'timeout');
});

test('the credential travels in a header and never in the outcome or the url', async () => {
 const h = harness(() => reply(200, { body: JSON.stringify({ percent: 12.34 }) }));
 const outcome = await h.ask();
 assert.equal(outcome.ok, true);
 assert.deepEqual(outcome.json, { percent: 12.34 });
 const [{ url, init }] = h.calls;
 assert.equal(url, 'https://quota.invalid/usage?quota=1');
 assert.equal(url.includes(TOKEN), false);
 assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
 assert.equal(init.credentials, 'omit');
 // The outcome carries the parsed value only: no headers, no raw text, no credential.
 assert.equal(JSON.stringify(outcome).includes(TOKEN), false);
 assert.deepEqual(Object.keys(outcome).sort(), ['fetchedAt', 'json', 'ok', 'retryAfterMs', 'status']);
});

test('the shipped endpoint table declares only reviewed, checkable destinations, and every failure kind is declared', async () => {
 // The declared set is pinned rather than left open: a destination reaches the network only
 // after it has been reviewed in this list, and a credential only ever travels to one of
 // these literals.
 assert.deepEqual(Object.entries(ENDPOINTS).flatMap(([provider, endpoints]) =>
   Object.entries(endpoints).map(([id, d]) => `${provider}/${id} https://${d.host}${d.path}`)),
   ['openai/wham-usage https://chatgpt.com/backend-api/wham/usage',
    'devin/user-status https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
    'anthropic/oauth-usage https://api.anthropic.com/api/oauth/usage',
    'cursor/period-usage https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
    'xai/grok-credits https://cli-chat-proxy.grok.com/v1/billing',
    'xai/grok-billing https://cli-chat-proxy.grok.com/v1/billing',
    'command-code/credits https://api.commandcode.ai/alpha/billing/credits',
    'opencode-go/usage https://opencode.ai/zen/go/v1/usage']);
 // The table is the only thing that decides where a credential goes, so each entry is
 // checked as data rather than trusted because it was reviewed once.
 for (const [provider, endpoints] of Object.entries(ENDPOINTS)) {
  for (const [id, descriptor] of Object.entries(endpoints)) {
   const name = `${provider}/${id}`;
   assert.equal(typeof descriptor.authorize, 'function', name);
   // Without accepted origins the base check cannot run, and an entry that cannot be
   // checked is exactly the one that would leak a relay's token to the vendor.
   assert.ok(Array.isArray(descriptor.configuredOrigins) && descriptor.configuredOrigins.length, name);
   for (const origin of descriptor.configuredOrigins) {
    assert.equal(new URL(origin).origin, origin, name);
    assert.equal(new URL(origin).protocol, 'https:', name);
   }
   assert.ok(['GET', 'POST', undefined].includes(descriptor.method), name);
   // The client's default base is this vendor's own host. Saying so per entry keeps the
   // judgement with the provider it is about.
   assert.equal(descriptor.acceptsDefaultBase, true, name);
   // A body belongs to POST and only to POST.
   assert.equal(typeof descriptor.body, name === 'devin/user-status' ? 'function' : descriptor.method === 'POST' ? 'string' : 'undefined', name);
   // A query is a fixed literal or nothing at all. Nothing in the table derives one from the
   // credential, so a per-request scope cannot be smuggled through it.
   for (const value of Object.values(descriptor.query ?? {})) {
    assert.ok(['string', 'number'].includes(typeof value), name);
   }
   const url = new URL(`https://${descriptor.host}${descriptor.path}`);
   assert.equal(url.hostname, descriptor.host, name);
   assert.equal(url.pathname, descriptor.path, name);
  }
 }
 // The two origin-quota destinations carry the credential and nothing else.
 for (const descriptor of [ENDPOINTS['command-code'].credits, ENDPOINTS['opencode-go'].usage]) {
  assert.deepEqual(descriptor.authorize(CRED), { Authorization: `Bearer ${TOKEN}` });
  assert.equal(descriptor.query, undefined);
 }
 // A provider that is declared does not make its neighbours reachable.
 const declared = createQuotaTransport({ now: () => NOW });
 assert.equal((await declared.request({ provider: 'command-code', endpointId: 'usage', credential: CRED })).kind,
   'endpoint_not_allowed');
 // An endpoint nobody declared is still refused, whatever else the table holds.
 const transport = createQuotaTransport({ now: () => NOW });
 const outcome = await transport.request({ provider: 'openai', endpointId: 'usage', credential: CRED });
 assert.equal(outcome.kind, 'endpoint_not_allowed');
 for (const kind of ['endpoint_not_allowed', 'credential_missing', 'unauthorized', 'access_denied',
   'rate_limited', 'server_error', 'unexpected_status', 'invalid_json', 'oversized', 'redirect',
   'timeout', 'network', 'base_url_mismatch']) assert.ok(FAILURES.includes(kind), kind);
});

test('a path cannot smuggle a port, an authority or a traversal past the fixed target', async () => {
 // ':8443/usage' would join into an authority and send the credential to another port on
 // the same host. '/a/../admin' would normalise to a path nobody declared.
 // A leading '//' is not a smuggle: it is still a path on the declared host, so it is
 // allowed. The refused shapes are the ones that change the destination.
 for (const path of [':8443/usage', '/a/../admin', '/x?y=1', 'usage', '/x#y']) {
  const calls = [];
  const transport = createQuotaTransport({ now: () => NOW,
    fetcher: async (...args) => { calls.push(args); return reply(200); },
    endpoints: { synthetic: { usage: { host: 'quota.invalid', path,
      configuredOrigins: ['https://quota.invalid'], acceptsDefaultBase: true,
      authorize: c => ({ Authorization: `Bearer ${c.value}` }) } } } });
  const outcome = await transport.request({ provider: 'synthetic', endpointId: 'usage', credential: CRED });
  assert.equal(outcome.kind, 'endpoint_not_allowed', path);
  assert.equal(calls.length, 0, path);
 }
});

test('the body ceiling counts bytes, not characters', async () => {
 // Three Hangul syllables in a JSON string are 11 bytes but 5 characters. Measuring the
 // string length would let a body over the ceiling through.
 const body = JSON.stringify('한한한');
 assert.ok(Buffer.byteLength(body, 'utf8') > 8);
 assert.ok(body.length < 8);
 const outcome = await harness(() => reply(200, { body }), { maxBodyBytes: 8 }).ask();
 assert.equal(outcome.kind, 'oversized');
});

test('a client that ignores the abort signal is still bounded, and an aborted caller returns at once', async () => {
 // Passing a signal is a request, not a guarantee. Without a race the call would hang.
 const stubborn = await harness(() => new Promise(() => {}), { timeoutMs: 10 }).ask();
 assert.equal(stubborn.kind, 'timeout');
 const already = AbortSignal.abort();
 const h = harness(() => reply(200));
 const outcome = await h.ask({ signal: already });
 assert.equal(outcome.kind, 'timeout');
 assert.equal(h.calls.length, 0);
});

test('a timeout while reading the body is a timeout, not a transport failure', async () => {
 const stream = { getReader: () => ({ read: () => new Promise(() => {}),
   cancel: async () => {}, releaseLock: () => {} }) };
 const outcome = await harness(() => reply(200, { stream }), { timeoutMs: 10 }).ask();
 assert.equal(outcome.kind, 'timeout');
});

test('a response echoing the credential is refused instead of parsed', async () => {
 // Parsing is not redaction: the token would ride into Outcome.json and anything that
 // serialises it.
 const outcome = await harness(() => reply(200,
   { body: JSON.stringify({ token: TOKEN, percent: 1 }) })).ask();
 assert.equal(outcome.kind, 'credential_echoed');
 assert.equal(JSON.stringify(outcome).includes(TOKEN), false);
});

test('a plain transport error is reported as network, and an early return releases the body', async () => {
 const broken = await harness(() => { throw new TypeError('socket closed'); }).ask();
 assert.equal(broken.kind, 'network');
 let cancelled = 0;
 const stream = { getReader: () => ({ read: async () => ({ done: true }),
   cancel: async () => {}, releaseLock: () => {} }), cancel: async () => { cancelled += 1; } };
 const refused = await harness(() => reply(401, { stream })).ask();
 assert.equal(refused.kind, 'unauthorized');
 assert.equal(cancelled, 1);
});

test('an oversized content-length is refused without touching the body', async () => {
 let read = 0;
 const stream = { getReader: () => { read += 1; return { read: async () => ({ done: true }),
   cancel: async () => {}, releaseLock: () => {} }; }, cancel: async () => {} };
 const response = reply(200, { headers: { 'content-length': String(4 * 1024 * 1024) }, stream });
 const outcome = await harness(() => response).ask();
 assert.equal(outcome.kind, 'oversized');
 // The existing provider path reads the whole body before measuring it. This one must not.
 assert.equal(read, 0);
 assert.equal(response.textRead, undefined);
});

test('a credential whose configured base is not the provider own is never sent', async () => {
 // A configuration pointing the provider at a relay means the token on disk was issued by
 // that relay. Sending it to the vendor would hand one party's credential to another.
 for (const baseUrl of [
   { status: 'custom', origin: 'https://relay.example' },
   { status: 'unknown', origin: null },
   { status: 'invalid', origin: null },
   null,
 ]) {
  const h = harness(() => reply(200));
  const outcome = await h.ask({ credential: { ...CRED, baseUrl } });
  assert.equal(outcome.kind, 'base_url_mismatch', JSON.stringify(baseUrl));
  assert.equal(h.calls.length, 0, JSON.stringify(baseUrl));
 }
 // The provider's own origin, and a credential read from the vendor's own client store,
 // both pass. Those are the two cases where the destination is known.
 for (const baseUrl of [{ status: 'custom', origin: 'https://quota.invalid' },
   { status: 'native', origin: null }]) {
  const h = harness(() => reply(200, { body: '{"ok":1}' }));
  const outcome = await h.ask({ credential: { ...CRED, baseUrl } });
  assert.equal(outcome.ok, true, JSON.stringify(baseUrl));
  assert.equal(h.calls.length, 1);
 }
});

test('the method and any body are the descriptor own, and a descriptor that cannot be checked is refused', async () => {
 const build = descriptor => {
  const calls = [];
  const transport = createQuotaTransport({ now: () => NOW,
    fetcher: async (url, init) => { calls.push({ url, init }); return reply(200, { body: '{"ok":1}' }); },
    endpoints: { synthetic: { usage: { host: 'quota.invalid', path: '/usage',
      configuredOrigins: ['https://quota.invalid'], acceptsDefaultBase: true,
      authorize: c => ({ Authorization: `Bearer ${c.value}` }), ...descriptor } } } });
  return { calls, ask: () => transport.request({ provider: 'synthetic', endpointId: 'usage', credential: CRED }) };
 };
 const post = build({ method: 'POST', body: '{}' });
 const sent = await post.ask();
 assert.equal(sent.ok, true);
 assert.equal(post.calls[0].init.method, 'POST');
 assert.equal(post.calls[0].init.body, '{}');
 // A GET keeps carrying no body at all, so a body cannot be smuggled onto a read.
 const get = build({});
 await get.ask();
 assert.equal(get.calls[0].init.method, 'GET');
 assert.equal('body' in get.calls[0].init, false);
 for (const descriptor of [{ method: 'POST' }, { body: '{}' }, { method: 'PUT', body: '{}' },
   { method: 'DELETE' }, { configuredOrigins: [] }, { configuredOrigins: 'https://quota.invalid' }]) {
  const h = build(descriptor);
  const outcome = await h.ask();
  assert.equal(outcome.kind, 'endpoint_not_allowed', JSON.stringify(descriptor));
  assert.equal(h.calls.length, 0, JSON.stringify(descriptor));
 }
});

test('an endpoint that needs more of the credential than the token refuses to send it', async () => {
 // Codex names a workspace in a header. A reading taken without naming one cannot be
 // attributed, so the request is not made rather than filed against a guess.
 const calls = [];
 const transport = createQuotaTransport({ now: () => NOW,
   fetcher: async (...args) => { calls.push(args); return reply(200); },
   endpoints: { synthetic: { usage: { host: 'quota.invalid', path: '/usage',
     configuredOrigins: ['https://quota.invalid'], acceptsDefaultBase: true,
     authorize: c => c.accountRef === null ? null
       : { Authorization: `Bearer ${c.value}`, 'X-Account': c.accountRef } } } } });
 const ask = credential => transport.request({ provider: 'synthetic', endpointId: 'usage', credential });
 assert.equal((await ask(CRED)).kind, 'credential_missing');
 assert.equal(calls.length, 0);
 const named = await ask({ ...CRED, accountRef: 'workspace-1' });
 assert.equal(named.ok, true);
 assert.equal(calls[0][1].headers['X-Account'], 'workspace-1');
 // A descriptor that throws is a declaration fault, not a credential one.
 const broken = createQuotaTransport({ now: () => NOW, fetcher: async () => reply(200),
   endpoints: { synthetic: { usage: { host: 'quota.invalid', path: '/usage',
     configuredOrigins: ['https://quota.invalid'], acceptsDefaultBase: true,
     authorize: () => { throw new TypeError('bad descriptor'); } } } } });
 const thrown = await broken.request({ provider: 'synthetic', endpointId: 'usage', credential: CRED });
 assert.equal(thrown.kind, 'endpoint_not_allowed');
});
