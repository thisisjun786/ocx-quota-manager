// Command Code publishes its own rolling windows on the billing surface the CLI usage view
// reads. This module turns one GET /alpha/billing/credits response into window rows, and
// decides whether the credential may be spent on that request at all.
//
// Only windowLimits is read. The credit pools beside it (monthly, purchased, free) and the
// lifetime spend summary are a different quantity with a different denominator; mixing one
// into a window limit would publish a percentage of something nobody measured.
const PROVIDER = 'command-code';
const ENDPOINT_ID = 'credits';
export const SOURCE_VERSION = 'command-code-credits-v1';
// The destination this credential belongs to. A configuration pointing anywhere else is a
// different service, so the credential must not travel to the declared host either.
export const CANONICAL_BASE_URLS = ['https://api.commandcode.ai'];
// The window ids and labels the product already publishes for this provider. The menu-bar
// selection key is built from the id, the scope and the label, so renaming either would
// silently drop a user's pinned window.
const WINDOWS = [['fiveHour', 'five-hour', '5시간'], ['weekly', 'weekly', '주간']];

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
// A trailing slash is the only difference a user can introduce without changing the target.
const normalize = value => typeof value === 'string' ? value.trim().replace(/\/+$/, '') : null;
// Unix 0 and negatives are a window that has not opened, not a reset in 1970. Publishing one
// as a reset instant would mark the window permanently past its reset.
const instant = value => {
  const ms = finite(value);
  if (ms === null) return null;
  const scaled = ms > 1e10 ? ms : ms * 1000;
  // A finite number is not a representable date past the ECMAScript time range, and a reset
  // nobody can format would throw when the snapshot renders it, taking the whole response
  // with it. Out of range is treated as no reset at all.
  return scaled > 0 && scaled <= 8.64e15 ? scaled : null;
};

/**
 * Rows for the credit windows in one billing response. Unknown windows are ignored and a
 * known window that is absent is simply missing: neither changes the other's number.
 */
export function parseCommandCodeCredits(json, { fetchedAt = null } = {}) {
  const outer = record(json) ? json : null;
  // The surface answers both bare and wrapped, so read the wrapper first and fall back.
  const body = record(outer?.data) ? outer.data : outer;
  const limits = record(body?.windowLimits) ? body.windowLimits : null;
  if (limits === null) return [];
  const rows = [];
  for (const [key, windowId, label] of WINDOWS) {
    const window = record(limits[key]) ? limits[key] : null;
    if (window === null) continue;
    const used = finite(window.used), cap = finite(window.cap);
    // A reading needs both halves of its own pair. One without the other is not a ratio.
    if (used === null || cap === null || used < 0) continue;
    const resetAt = instant(window.resetAt);
    // Seeing decimals in one reading is evidence about that reading, not a guarantee the
    // provider always reports them, so the opposite is never claimed from a whole number.
    const percent = cap > 0 ? used * 100 / cap : null;
    rows.push({ windowId, label, resetAt, raw: {
      method: 'used_limit', used,
      // The measurement contract reads `limit`. Passing the provider's own field name would
      // record the limit as missing and drop a real reading of 0 percent.
      limit: cap, unit: 'credits',
      scopeKey: `${PROVIDER}/${ENDPOINT_ID}/${key}`,
      cycleKey: resetAt === null ? null : String(resetAt),
      observedAt: fetchedAt,
      precisionEvidence: percent !== null && !Number.isInteger(percent) ? 'observed_fraction' : 'unknown',
    } });
  }
  return rows;
}

/**
 * The adapter for the direct reader. `destination` is the provider's configured destination,
 * supplied by whoever registers this adapter. Without it nothing applies: an adapter that is
 * merely registered must not put a credential on the network.
 */
export function createCommandCodeQuotaAdapter({ destination = null } = {}) {
  return {
    provider: PROVIDER, endpointId: ENDPOINT_ID, sourceVersion: SOURCE_VERSION,
    appliesTo: binding => applies(destination, binding),
    parse: parseCommandCodeCredits,
  };
}

// A destination may be a value or a reader. A reader is consulted at every decision, so a
// registrar that re-reads its configuration each cycle bounds how stale this answer can be.
// It decides only the first applicability of a reading; re-checking between the decision and
// the request itself belongs to the reader that owns the credential contract.
function applies(source, binding) {
  let destination;
  try { destination = typeof source === 'function' ? source() : source; }
  catch { return false; }
  if (!record(destination) || destination.enabled !== true) return false;
  if (!CANONICAL_BASE_URLS.includes(normalize(destination.baseUrl))) return false;
  // An organisation account is read with ?orgId=, which a fixed endpoint table cannot build
  // per request. Reading the unscoped surface instead would publish a different scope's
  // numbers under this account, so nothing is read until the scope can be stated.
  if (destination.orgId !== null && destination.orgId !== undefined) return false;
  // The account that routes requests is the one whose quota is worth showing. A stale login
  // beside an API key configuration is a different account, and a bar for it is a wrong bar.
  return (destination.authMode === 'oauth' ? 'oauth' : 'key') ===
    (binding.kind === 'oauth' ? 'oauth' : 'key');
}
