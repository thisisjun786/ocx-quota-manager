// OpenCode Go reports three window percentages on its own usage surface. This module turns
// one GET /zen/go/v1/usage response into window rows and decides whether the credential may
// be spent on that request at all.
//
// The response carries percentages and nothing else. No used or limit is derived from plan
// prices or from locally priced calls: an estimate in the place of a measurement reads as a
// measurement.
const PROVIDER = 'opencode-go';
const ENDPOINT_ID = 'usage';
export const SOURCE_VERSION = 'opencode-go-usage-v1';
// The built-in Go destination. A key configured against any other base URL belongs to that
// other destination and is never sent here.
export const CANONICAL_BASE_URLS = ['https://opencode.ai/zen/go/v1'];
// Window ids and labels follow what this provider already publishes, so a pinned window and
// its menu-bar key survive. The provider's own key stays in scopeKey as the evidence.
// Only `rolling` is named a rolling window by the provider itself; the other two say nothing
// about how they reset, and a reset instant is published separately either way.
const WINDOWS = [['rolling', 'five-hour', '5시간', 'sliding'],
  ['weekly', 'weekly', '주간', 'unknown'], ['monthly', 'monthly', '월간', 'unknown']];

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const normalize = value => typeof value === 'string' ? value.trim().replace(/\/+$/, '') : null;
// This surface times its resets as an ISO instant; a numeric epoch is accepted rather than
// guessed at, and anything else is absent rather than a reset at the beginning of time.
const instant = value => {
  const ms = finite(value);
  if (ms !== null) {
    const scaled = ms > 1e10 ? ms : ms * 1000;
    // Past the ECMAScript time range a finite number is not a date, and formatting it later
    // would throw and take the whole snapshot with it.
    return scaled > 0 && scaled <= 8.64e15 ? scaled : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** Rows for the usage windows in one response. */
export function parseOpenCodeGoUsage(json, { fetchedAt = null } = {}) {
  const usage = record(json) && record(json.usage) ? json.usage : null;
  if (usage === null) return [];
  const rows = [];
  for (const [key, windowId, label, windowSemantics] of WINDOWS) {
    const window = record(usage[key]) ? usage[key] : null;
    if (window === null) continue;
    // A window the provider does not call ok is one it is not reporting, not a window at
    // zero. Publishing its percentage would make an unsupported limit look measured.
    if (typeof window.status === 'string' && window.status !== 'ok') continue;
    const percent = finite(window.percent);
    if (percent === null || percent < 0) continue;
    const resetAt = instant(window.resetsAt);
    rows.push({ windowId, label, resetAt, raw: {
      method: 'reported_percent', percent,
      scopeKey: `${PROVIDER}/${ENDPOINT_ID}/${key}`,
      cycleKey: resetAt === null ? null : String(resetAt),
      windowSemantics, observedAt: fetchedAt,
      precisionEvidence: Number.isInteger(percent) ? 'unknown' : 'observed_fraction',
    } });
  }
  return rows;
}

/**
 * The adapter for the direct reader. Without a configured destination nothing applies, so a
 * registered adapter alone never puts a key on the network.
 */
export function createOpenCodeGoQuotaAdapter({ destination = null } = {}) {
  return {
    provider: PROVIDER, endpointId: ENDPOINT_ID, sourceVersion: SOURCE_VERSION,
    appliesTo: binding => applies(destination, binding),
    parse: parseOpenCodeGoUsage,
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
  // This surface is read with the provider API key. Each pooled key keeps its own account id
  // and its own reading; no key stands in for another.
  return binding.kind === 'key';
}
