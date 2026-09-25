// What a quota reading is actually based on. The point is to keep the provider's own number
// and any number we derived side by side, with the evidence for each, so a later reader can
// tell a reported percentage from a computed one and a real disagreement from a rounding wobble.
export const METHODS = ['reported_percent', 'reported_fraction', 'used_limit'];
export const SEMANTICS = ['fixed_reset', 'sliding', 'unknown'];
export const PRECISION = ['observed_fraction', 'integer_only', 'unknown'];
export const RECONCILIATION = ['matched', 'mismatch', 'unverified'];
export const LIMIT_STATES = ['present', 'missing', 'zero', 'unlimited'];
// What a used quantity counts. 'cumulative' means it runs from the start of the cycle, 'interval'
// that it covers only the span since the last reading. The default is deliberately the useless
// answer: a difference between two used values only means consumption if the number accumulates,
// and watching a number rise is not evidence that it does. An adapter has to say so, and none of
// the shipped ones does yet, which is why existing history stays unverified.
export const ACCUMULATION = ['cumulative', 'interval', 'unknown'];
// Percentage points. Wide enough to absorb a provider rounding its own figure, narrow
// enough that Cursor's 2.53 against a computed 19.6125 is still a disagreement.
export const MISMATCH_TOLERANCE_PP = 0.05;

const text = value => typeof value === 'string' && value.length && value.length <= 200 ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const atLeastZero = value => { const n = finite(value); return n !== null && n >= 0 ? n : null; };
const oneOf = (list, value, fallback) => list.includes(value) ? value : fallback;

// Accepts either epoch milliseconds or an ISO instant, and refuses anything else rather
// than substituting the time we happened to ask.
const instant = value => {
  const ms = finite(value);
  if (ms !== null) return ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/**
 * Project an adapter's raw reading into the published measurement contract. Every field is
 * copied across by name, so a provider response cannot ride along wholesale. Returns null
 * when the reading carries no usable contract at all.
 */
export function projectMeasurement(raw, { fetchedAt } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = text(raw.source), sourceVersion = text(raw.sourceVersion), scopeKey = text(raw.scopeKey);
  if (source === null || sourceVersion === null || scopeKey === null) return null;
  // A method we do not recognise is not silently downgraded: the adapter and this contract
  // disagree, and guessing would publish a basis nobody declared.
  if (raw.method !== undefined && !METHODS.includes(raw.method)) return null;
  const fetched = instant(fetchedAt);
  if (fetched === null) return null;

  // The provider's own figure. A value above 100 is preserved here; only the published
  // percentage is clamped, because the overage is the evidence.
  const percent = atLeastZero(raw.percent);
  const fraction = finite(raw.fraction);
  const usableFraction = fraction !== null && fraction >= 0 && fraction <= 1 ? fraction : null;
  const reportedPercent = percent !== null ? percent
    : usableFraction !== null ? usableFraction * 100 : null;

  const used = atLeastZero(raw.used);
  const limit = finite(raw.limit);
  const limitState = raw.unlimited === true ? 'unlimited'
    : limit === null ? 'missing' : limit === 0 ? 'zero' : limit < 0 ? 'missing' : 'present';
  // Divide only a genuine pair. Multiplying first keeps 123.4 of 1000 at exactly 12.34
  // instead of drifting into binary-floating-point noise, but the product can overflow to
  // Infinity for very large finite inputs, so fall back to dividing first and require a
  // finite result either way.
  const ratio = () => {
    const scaled = used * 100;
    const value = Number.isFinite(scaled) ? scaled / limit : used / limit * 100;
    return Number.isFinite(value) ? value : null;
  };
  const calculatedPercent = used !== null && limitState === 'present' ? ratio() : null;

  const method = raw.method ?? (calculatedPercent !== null ? 'used_limit'
    : usableFraction !== null && percent === null ? 'reported_fraction' : 'reported_percent');

  // A disagreement is recorded, never repaired. The provider's figure stays authoritative
  // and the computed one stays visible next to it.
  const reconciliation = reportedPercent !== null && calculatedPercent !== null
    ? (Math.abs(reportedPercent - calculatedPercent) <= MISMATCH_TOLERANCE_PP ? 'matched' : 'mismatch')
    : 'unverified';

  const resolution = finite(raw.resolutionPp);
  return {
    source, method, reportedPercent,
    used, limit: limitState === 'present' ? limit : null, unit: text(raw.unit), limitState,
    scopeKey, cycleKey: text(raw.cycleKey),
    windowSemantics: oneOf(SEMANTICS, raw.windowSemantics, 'unknown'),
    observedAt: instant(raw.observedAt), fetchedAt: fetched, sourceVersion,
    // Only a resolution the adapter can guarantee. Seeing a decimal once is not a guarantee,
    // so this stays null unless the adapter says otherwise.
    resolutionPp: resolution !== null && resolution > 0 ? resolution : null,
    precisionEvidence: oneOf(PRECISION, raw.precisionEvidence, 'unknown'),
    usedAccumulation: oneOf(ACCUMULATION, raw.usedAccumulation, 'unknown'),
    calculatedPercent, reconciliation,
  };
}

// Which number to publish as the window's used percentage. The provider's own figure wins;
// having more decimal places is not a reason to prefer the computed one.
//
// Returns null when there is nothing to publish. Callers must drop the window rather than
// coerce this: Math.min(100, null) is 0, which would announce a reading nobody observed.
export function publishedPercent(measurement) {
  if (measurement === null || typeof measurement !== 'object') return null;
  return measurement.reportedPercent ?? measurement.calculatedPercent ?? null;
}
