import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ADAPTERS as PROVIDER_QUOTA_ADAPTERS } from './provider-quota-adapters.mjs';
import { createCommandCodeQuotaAdapter,
  CANONICAL_BASE_URLS as COMMAND_CODE_BASES } from './command-code-quota.mjs';
import { createOpenCodeGoQuotaAdapter,
  CANONICAL_BASE_URLS as OPENCODE_GO_BASES } from './opencode-go-quota.mjs';

// Which providers a service entry point may turn direct collection on for, and how it builds
// the readers that need to know where their provider actually lives.
//
// This is deliberately a registrar rather than a default. src/collector.mjs keeps its empty
// adapter list so that building a collector never puts anything on the network by itself;
// enabling the path is an explicit act by whoever owns the process.
const MAX_FILE_BYTES = 8 * 1024 * 1024;

// The two readers that are constructed per destination. Everything else in
// PROVIDER_QUOTA_ADAPTERS already declares its own provider and needs nothing from the
// configuration beyond what the credential source already checked.
// Each reader, with the base its own client uses when the configuration names none. A
// provider entry that declares no base is not a provider with no destination: the credential
// contract calls that state 'default' and says the client's own default applies, and for
// these two that default is the vendor's own host. Reading it as "unknown" instead would let
// a normal install turn the feature on and quietly fetch nothing.
const BUILT_PER_DESTINATION = new Map([
  ['command-code', { create: createCommandCodeQuotaAdapter, base: COMMAND_CODE_BASES[0] }],
  ['opencode-go', { create: createOpenCodeGoQuotaAdapter, base: OPENCODE_GO_BASES[0] }],
]);

export const DIRECT_PROVIDERS = [...new Set([...PROVIDER_QUOTA_ADAPTERS.map(a => a.provider),
  ...BUILT_PER_DESTINATION.keys()])];

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The same three-way reading src/credential-source.mjs applies to a configured base, so the
// registrar and the transport cannot disagree about what a configuration means. An absent
// base is the client's default; a present but unusable one is a broken configuration and
// stays refused rather than being quietly replaced by the default.
const baseOf = (entry, fallback) => {
  const raw = entry.baseUrl;
  if (raw === undefined || raw === null) return fallback ?? null;
  if (typeof raw !== 'string' || !raw.length) return null;
  // Parsed the same way, not merely shaped the same way. The readers compare a trimmed
  // string, and String.trim strips characters the URL parser rejects outright -- a canonical
  // address padded with a non-breaking space would look applicable here while the transport
  // refused it as base_url_mismatch. Nothing escaped, but the two would have disagreed about
  // what the configuration says, which is the disagreement this function exists to prevent.
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  } catch { return null; }
  return raw;
};

/**
 * Where each provider's requests are configured to go, cached and re-read on demand.
 *
 * The two per-destination readers ask this synchronously, inside appliesTo, so it cannot be a
 * promise. Freshness therefore comes from refresh() being awaited before each credential
 * source read rather than from the lookup itself. A configuration that cannot be read leaves
 * every destination null, which both readers treat as "do not send anything".
 */
export function createDestinationReader({ home, read = readFile, defaults = new Map() } = {}) {
  let destinations = new Map();
  // Reads overlap: collection, projection and the re-read a 401 triggers each begin with the
  // credential source, so refresh() can be called again while one is still running. Letting
  // them run in parallel means a slower earlier read can land last and reinstate a credential
  // mode the configuration has already moved away from. Discarding the overtaken result is
  // not enough either -- its caller would then go on using a value older than the one it just
  // read. So there is only ever one read in flight and everyone waiting joins it, which is
  // the same single-flight shape src/server.mjs uses for the snapshot itself.
  let inFlight = null;
  async function load() {
    let next = new Map();
    try {
      // Bytes, not UTF-16 code units: reading as text first would measure the wrong quantity.
      const raw = await read(join(home, 'config.json'));
      const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
      if (bytes <= MAX_FILE_BYTES) {
        const parsed = JSON.parse(raw.toString());
        const providers = record(parsed) && record(parsed.providers) ? parsed.providers : {};
        for (const [id, entry] of Object.entries(providers)) {
          if (!record(entry)) continue;
          next.set(id, {
            enabled: entry.disabled !== true,
            baseUrl: baseOf(entry, defaults.get(id)),
            authMode: typeof entry.authMode === 'string' ? entry.authMode : null,
            // An organisation the configuration states. Command Code refuses an
            // organisation-scoped account because a fixed endpoint table cannot build its
            // query; that refusal is the reader's and is left intact here.
            orgId: typeof entry.organization === 'string' ? entry.organization : null,
          });
        }
      }
    } catch { next = new Map(); }
    destinations = next;
  }
  function refresh() {
    // Never rejects: a configuration that cannot be read is an answer, not an error, and
    // throwing here would take a whole snapshot down with it.
    if (!inFlight) inFlight = load().finally(() => { inFlight = null; });
    return inFlight;
  }
  return { refresh, of: provider => () => destinations.get(provider) ?? null };
}

/**
 * The collector options a service entry point should pass, derived from its environment.
 *
 * QUOTA_DIRECT_PROVIDERS is a comma-separated list of provider ids. Unset or blank means the
 * feature is off and the returned options are the literal defaults createCollector already
 * uses, so an existing install's behaviour and response are unchanged.
 *
 * A list rather than a boolean because the question worth answering is which providers are
 * being read, not merely whether the feature is on.
 */
export function directOptions(env = {}, { home, read = readFile, warn = console.warn } = {}) {
  const off = { directAdapters: [], directPrepare: null };
  // Deduplicated, because a repeated token is a typo rather than a request to read a provider
  // twice. The fixed list below is filtered and so ignores repeats on its own; the readers
  // built per destination are constructed per entry, and two of the same adapter would
  // publish the endpoint twice in directQuota.endpoints and in the diagnostics.
  const requested = [...new Set(String(env.QUOTA_DIRECT_PROVIDERS ?? '').split(',')
    .map(value => value.trim()).filter(Boolean))];
  if (!requested.length) return off;
  const known = requested.filter(id => {
    if (DIRECT_PROVIDERS.includes(id)) return true;
    warn(`quota-monitor: unknown direct quota provider ignored: ${id}`);
    return false;
  });
  if (!known.length) return off;
  const defaults = new Map([...BUILT_PER_DESTINATION].map(([id, entry]) => [id, entry.base]));
  const reader = createDestinationReader({ home, read, defaults });
  const adapters = [
    ...PROVIDER_QUOTA_ADAPTERS.filter(adapter => known.includes(adapter.provider)),
    ...known.filter(id => BUILT_PER_DESTINATION.has(id))
      .map(id => BUILT_PER_DESTINATION.get(id).create({ destination: reader.of(id) })),
  ];
  if (!adapters.length) return off;
  return { directAdapters: adapters, directPrepare: () => reader.refresh() };
}
