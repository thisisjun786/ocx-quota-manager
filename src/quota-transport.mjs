// A deliberately small HTTP surface for reading a provider's own quota endpoint. Hosts and
// paths come from this fixed table, never from a user-supplied base URL, and the credential
// travels only in headers or a read-only RPC body the descriptor builds.
//
// Each descriptor also declares which CONFIGURED base origins it accepts. A fixed table
// already stops a request going to an arbitrary host, but it cannot tell whether the stored
// credential belongs to this provider at all: when a configuration points a provider at a
// relay, the token on disk was issued by that relay, and sending it to the vendor would hand
// one party's credential to another. The origins below are the ones that prove otherwise.
const bearer = credential => ({ Authorization: `Bearer ${credential.value}` });
// Sent by the client that owns each credential. The endpoints answer the client they were
// built for, so the identifying headers travel with the token rather than being invented.
const CLAUDE_USER_AGENT = 'claude-cli/2.1.63 (external, cli)';
const CLAUDE_BETA = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,' +
  'context-management-2025-06-27,prompt-caching-scope-2026-01-05';
const GROK_CLIENT_VERSION = '0.2.93';

export const ENDPOINTS = Object.freeze({
  openai: {
    // The account header is not optional: one login can reach several workspaces, and a
    // reading filed without naming the workspace cannot be attributed to an account.
    'wham-usage': { host: 'chatgpt.com', path: '/backend-api/wham/usage',
      configuredOrigins: ['https://chatgpt.com'], acceptsDefaultBase: true,
      authorize: credential => credential.accountRef === null ? null
        : { ...bearer(credential), 'ChatGPT-Account-Id': credential.accountRef } },
  },
  devin: {
    // The vendor's Connect RPC uses metadata.apiKey in its JSON request. This is
    // a read, with no login, token exchange or inference. Versions are required.
    'user-status': { host: 'server.codeium.com',
      path: '/exa.seat_management_pb.SeatManagementService/GetUserStatus', method: 'POST',
      configuredOrigins: ['https://server.codeium.com'], acceptsDefaultBase: true,
      authorize: () => ({ 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }),
      body: credential => JSON.stringify({ metadata: { apiKey: credential.value,
        ideName: 'windsurf', ideVersion: '0.0.0', extensionName: 'windsurf', extensionVersion: '1.0.0' } }),
    },
  },
  anthropic: {
    'oauth-usage': { host: 'api.anthropic.com', path: '/api/oauth/usage',
      configuredOrigins: ['https://api.anthropic.com'], acceptsDefaultBase: true,
      authorize: credential => ({ ...bearer(credential),
        'anthropic-beta': CLAUDE_BETA, 'User-Agent': CLAUDE_USER_AGENT }) },
  },
  cursor: {
    // Cursor's own meter is a Connect RPC, which is a POST with a fixed empty body. It reads
    // a period's usage and creates nothing; the method is the protocol's, not a write.
    'period-usage': { host: 'api2.cursor.sh',
      path: '/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
      method: 'POST', body: '{}', configuredOrigins: ['https://api2.cursor.sh'],
      acceptsDefaultBase: true,
      authorize: credential => ({ ...bearer(credential),
        'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }) },
    // /api/usage/summary is the other reader the vendor's own client falls back to. A live
    // read of it returns 404 for the account this was verified against, so registering it
    // would make every cycle record a failure that is not one. It belongs here once there is
    // an account it actually answers for.
  },
  xai: {
    // Grok's billing service is a different host from the inference base. Both are xAI's, so
    // the accepted configured origin is the inference base the account was set up with.
    'grok-credits': { host: 'cli-chat-proxy.grok.com', path: '/v1/billing',
      query: { format: 'credits' }, configuredOrigins: ['https://api.x.ai'],
      acceptsDefaultBase: true,
      authorize: credential => credential.accountRef === null ? null
        : { ...bearer(credential), 'x-userid': credential.accountRef,
          'x-xai-token-auth': 'xai-grok-cli', 'x-authenticateresponse': 'authenticate-response',
          'x-grok-client-version': GROK_CLIENT_VERSION } },
    'grok-billing': { host: 'cli-chat-proxy.grok.com', path: '/v1/billing',
      configuredOrigins: ['https://api.x.ai'], acceptsDefaultBase: true, authorize: bearer },
  },
  // Declared by the origin-quota work. The fields below are this reader's: a descriptor that
  // does not say which configured origins it accepts cannot be checked, and an unchecked
  // descriptor is the one that would carry a relay's token to the vendor. Both accepted
  // origins are the client's own registry default for the provider, so a configuration that
  // declares nothing is still pointing at the vendor.
  'command-code': Object.freeze({
    credits: Object.freeze({ host: 'api.commandcode.ai', path: '/alpha/billing/credits',
      configuredOrigins: ['https://api.commandcode.ai'], acceptsDefaultBase: true,
      authorize: credential => ({ Authorization: `Bearer ${credential.value}` }) }),
  }),
  'opencode-go': Object.freeze({
    usage: Object.freeze({ host: 'opencode.ai', path: '/zen/go/v1/usage',
      configuredOrigins: ['https://opencode.ai'], acceptsDefaultBase: true,
      authorize: credential => ({ Authorization: `Bearer ${credential.value}` }) }),
  }),
});

export const FAILURES = ['endpoint_not_allowed', 'credential_missing', 'unauthorized',
  'access_denied', 'rate_limited', 'server_error', 'unexpected_status', 'invalid_json',
  'oversized', 'redirect', 'timeout', 'network', 'credential_echoed', 'base_url_mismatch'];

// A configured base that is the provider's own, or none at all. 'unknown' is refused rather
// than assumed: a configuration we could not read is not evidence that the default applies.
// 'native' is accepted by every descriptor because the credential came from the vendor's own
// client store, which no configuration can contradict. 'default' is accepted only where the
// descriptor says so: the client's default base is the vendor's own host for these providers,
// but that is a fact about each provider rather than a rule, and a descriptor that forgets to
// claim it refuses the request instead of assuming it.
const baseAccepted = (descriptor, credential) => {
  const base = credential.baseUrl;
  if (base === null || typeof base !== 'object') return false;
  if (base.status === 'native') return true;
  if (base.status === 'default') return descriptor.acceptsDefaultBase === true;
  return base.status === 'custom' && descriptor.configuredOrigins.includes(base.origin);
};

const DAY_MS = 86400000;
// A path is a fixed literal, not a template. Anything that could add a port, an authority
// or a traversal segment is rejected before assembly rather than normalised afterwards.
const SAFE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const traversal = path => path.split('/').includes('..');

// Retry-After is either a delay in seconds or an HTTP date. Anything else, including a
// negative or absurd value, is treated as absent rather than guessed at.
function retryAfterMs(header, now) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const seconds = Number(header.trim());
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, DAY_MS) : null;
}

// Read at most maxBodyBytes, measured in bytes. The existing provider path checks
// content-length and then reads the whole body anyway, so an oversized response still lands
// in memory; streaming with a ceiling is what makes the limit real. Comparing string length
// instead would let a multi-byte body over the ceiling through.
async function readBody(response, maxBodyBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBodyBytes ? null : text;
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBodyBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

export function createQuotaTransport({ fetcher = fetch, now = Date.now,
  timeoutMs = 20000, maxBodyBytes = 1024 * 1024, endpoints = ENDPOINTS } = {}) {
  const fail = (kind, fetchedAt, status = null, retry = null) =>
    ({ ok: false, kind, status, retryAfterMs: retry, fetchedAt });

  async function request({ provider, endpointId, credential = null, signal = null }) {
    const fetchedAt = now();
    const descriptor = endpoints?.[provider]?.[endpointId];
    // A descriptor that does not say which configured origins it accepts cannot be checked,
    // and an unchecked descriptor is exactly the hole this table exists to close.
    if (!descriptor || typeof descriptor.authorize !== 'function' ||
        !Array.isArray(descriptor.configuredOrigins) || !descriptor.configuredOrigins.length) {
      return fail('endpoint_not_allowed', fetchedAt);
    }
    // Two methods, both fixed by the descriptor. A body belongs to POST and only to POST, so
    // neither can be supplied by a caller and neither can be omitted where it is required.
    const method = descriptor.method ?? 'GET';
    const bodySource = descriptor.body ?? null;
    if (!['GET', 'POST'].includes(method) ||
        (method === 'GET' ? bodySource !== null : !['string', 'function'].includes(typeof bodySource))) {
      return fail('endpoint_not_allowed', fetchedAt);
    }
    let url;
    try {
      // Check the parts before joining them. A path of ':8443/usage' would otherwise become
      // an authority and send the credential to a different port on the same host.
      if (typeof descriptor.host !== 'string' || typeof descriptor.path !== 'string' ||
          !SAFE_PATH.test(descriptor.path) || traversal(descriptor.path)) {
        return fail('endpoint_not_allowed', fetchedAt);
      }
      url = new URL(`https://${descriptor.host}${descriptor.path}`);
      for (const [key, value] of Object.entries(descriptor.query ?? {})) {
        url.searchParams.set(key, String(value));
      }
      // Re-check the assembled URL rather than trusting the table: a host carrying a port,
      // credentials or a scheme would otherwise pass straight through. The pathname must
      // still be the literal that was declared, so no normalisation changed the target.
      if (url.protocol !== 'https:' || url.hostname !== descriptor.host || url.port !== '' ||
          url.pathname !== descriptor.path || url.username || url.password) {
        return fail('endpoint_not_allowed', fetchedAt);
      }
    } catch { return fail('endpoint_not_allowed', fetchedAt); }
    if (!credential || typeof credential.value !== 'string' || !credential.value) {
      return fail('credential_missing', fetchedAt);
    }
    if (!baseAccepted(descriptor, credential)) return fail('base_url_mismatch', fetchedAt);
    // An endpoint that needs more of the credential than the token says so by refusing to
    // build its headers. Sending the request anyway would file an unattributable answer.
    let authorization;
    try { authorization = descriptor.authorize(credential); }
    catch { return fail('endpoint_not_allowed', fetchedAt); }
    if (authorization === null || typeof authorization !== 'object') {
      return fail('credential_missing', fetchedAt);
    }

    // Resolve descriptor-owned bodies only after the destination and credential guards.
    // A caller can neither choose a body nor send its credential to a configured relay.
    let body;
    try { body = typeof bodySource === 'function' ? bodySource(credential) : bodySource; }
    catch { return fail('endpoint_not_allowed', fetchedAt); }
    if (method === 'POST' && typeof body !== 'string') return fail('endpoint_not_allowed', fetchedAt);

    if (signal?.aborted) return fail('timeout', fetchedAt);
    const timeout = AbortSignal.timeout(timeoutMs);
    const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;
    // Passing the signal is a request, not a guarantee: a client that ignores it would keep
    // this pending forever. Racing the deadline makes the bound ours to enforce.
    const deadline = new Promise((resolve, reject) => {
      if (abort.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      abort.addEventListener('abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    const bounded = promise => Promise.race([promise, deadline]);
    const aborted = error => abort.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError';
    let response;
    try {
      response = await bounded(fetcher(url.toString(), {
        method,
        ...(body === null ? {} : { body }),
        headers: { Accept: 'application/json', ...authorization },
        // Manual, not 'error': rejecting the promise would make a redirect
        // indistinguishable from a transport failure.
        redirect: 'manual',
        credentials: 'omit',
        signal: abort,
      }));
    } catch (error) {
      return fail(aborted(error) ? 'timeout' : 'network', fetchedAt);
    }

    const status = Number(response?.status);
    const header = key => response?.headers?.get?.(key) ?? null;
    // Nothing below reads the body, so release it instead of leaving the response open.
    const discard = kind => { void response.body?.cancel?.().catch?.(() => {}); return kind; };
    if (status >= 300 && status < 400) return discard(fail('redirect', fetchedAt, status));
    if (status === 401) return discard(fail('unauthorized', fetchedAt, status));
    // A refused request is not an expired one. Treating every 403 as expiry would send the
    // caller looking for a new token that was never the problem.
    if (status === 403) return discard(fail('access_denied', fetchedAt, status));
    if (status === 429) {
      return discard(fail('rate_limited', fetchedAt, status,
        retryAfterMs(header('retry-after'), fetchedAt)));
    }
    if (status >= 500) return discard(fail('server_error', fetchedAt, status));
    if (!(status >= 200 && status < 300)) return discard(fail('unexpected_status', fetchedAt, status));
    if (Number(header('content-length')) > maxBodyBytes) {
      return discard(fail('oversized', fetchedAt, status));
    }

    let raw;
    try { raw = await bounded(readBody(response, maxBodyBytes)); }
    catch (error) { return fail(aborted(error) ? 'timeout' : 'network', fetchedAt, status); }
    if (raw === null) return fail('oversized', fetchedAt, status);
    // A response that echoes the credential back would carry it into the parsed value, and
    // parsing is not redaction. Refuse the body rather than hand a token to the caller.
    if (raw.includes(credential.value)) return fail('credential_echoed', fetchedAt, status);
    try {
      // Only the parsed value crosses this boundary. Headers and the raw text stay here so
      // they cannot reach a log, the database or the public response.
      return { ok: true, status, json: JSON.parse(raw), fetchedAt, retryAfterMs: null };
    } catch { return fail('invalid_json', fetchedAt, status); }
  }

  return { request };
}
