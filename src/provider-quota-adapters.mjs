import { devinAdapter } from './devin-quota.mjs';
import { identityDigest } from './credential-source.mjs';
import { scopedWindowId } from './snapshot.mjs';

// The provider adapters direct collection registers. Each one turns a single provider
// response into rows the measurement contract can project, and nothing else: no request is
// made here, no credential is read here, and no number is rounded here.
//
// Window identifiers are the ones the product already publishes (src/snapshot.mjs:163-168),
// because history separates windows by window.id (src/history.mjs:399-406). A limit that
// arrived under one id from the existing path and another from this one would be counted as
// two different limits for the same account. Narrower windows keep the 'custom-' prefix and
// the label the existing path uses, which is what src/window-scope.mjs matches on, but they
// are named after the limit rather than numbered by position so the id survives a response
// whose order changed.

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' && value.length && value.length <= 200 ? value : null;
// ECMAScript caps a time value at 8.64e15 ms. Past that, formatting throws rather than
// rendering something wrong, so a bogus reset is treated as absent.
const MAX_INSTANT = 8.64e15;
// Providers report a reset as epoch seconds (Codex), epoch milliseconds in a decimal string
// (Cursor) or an ISO instant (Claude, Grok). Ten digits cannot be a millisecond timestamp in
// any year this product will see, so the smaller value is seconds.
const SECONDS_CEILING = 10000000000;
function instant(value) {
  const numeric = finite(value) ?? (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())
    ? Number(value.trim()) : null);
  if (numeric !== null) {
    const ms = numeric > SECONDS_CEILING ? numeric : numeric * 1000;
    return ms > 0 && ms < MAX_INSTANT ? ms : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < MAX_INSTANT ? parsed : null;
}

// What this sample shows about the provider's resolution, and nothing more. Seeing a decimal
// proves decimals are possible; seeing an integer proves nothing at all, so it is recorded as
// unknown rather than as a claim that the provider only ever reports whole numbers.
const precision = (...values) => values.some(value =>
  finite(value) !== null && !Number.isInteger(value)) ? 'observed_fraction' : 'unknown';
// A reset instant is evidence that the window ends at a declared time. Without one there is
// nothing to say, and guessing would publish a shape nobody reported.
const semantics = resetAt => resetAt === null ? 'unknown' : 'fixed_reset';
const cycleKey = resetAt => resetAt === null ? null : new Date(resetAt).toISOString();
// The same identity the cached provider path gives a window with this label, so one limit
// keeps one identity whichever path read it and its history is not split in two.
const scopedId = label => scopedWindowId(label);
const HOURS = seconds => `${Math.round(seconds / 3600 * 10) / 10}시간`;

// An OAuth session, not an API key. These endpoints report what a subscription has consumed,
// which a key account does not have.
const oauthOnly = binding => binding.kind !== 'key';

// Codex reads its account limits from the WHAM usage endpoint. Which window a reading belongs
// to is decided by the duration the response declares and by nothing else: a plan name is not
// a duration, and a window's position in the payload is not one either. A primary window of
// 604800 seconds is the weekly limit, which is what real accounts return today.
const CODEX_BURST_MAX_SECONDS = 24 * 60 * 60;
const CODEX_MONTHLY_MIN_SECONDS = 28 * 24 * 60 * 60;
function codexWindow(seconds) {
  const declared = finite(seconds);
  // An older payload omits the duration. It cannot be read as a burst window, and the weekly
  // limit is what that shape has always meant, so the reading is kept and the uncertainty is
  // recorded rather than resolved.
  if (declared === null || declared <= 0) return { id: 'weekly', label: '주간', declared: false };
  if (declared < CODEX_BURST_MAX_SECONDS) return { id: 'short', label: HOURS(declared), declared: true };
  if (declared >= CODEX_MONTHLY_MIN_SECONDS) return { id: 'monthly', label: '월간', declared: true };
  return { id: 'weekly', label: '주간', declared: true };
}

// The request names an account in a header. The response names one back, and the roster
// already holds the digest of the account this binding is. Comparing those two is what makes
// a reading attributable; without it one login's answer could be filed under another of its
// workspaces. A response that names no account cannot be attributed at all, so it is refused
// rather than assumed to be the right one.
function codexBelongsTo(claimed, binding) {
  const physical = binding?.physical;
  if (!physical || physical.storable !== true || physical.digest === null) return true;
  const value = text(claimed);
  return value !== null && identityDigest(value) === physical.digest;
}

const codexAdapter = {
  provider: 'openai', endpointId: 'wham-usage', sourceVersion: 'chatgpt-wham-1',
  appliesTo: oauthOnly,
  parse(json, { binding } = {}) {
    const body = record(json);
    const limits = record(body?.rate_limit);
    if (limits === null || !codexBelongsTo(body.account_id, binding)) return [];
    const rows = [];
    const claimed = new Set();
    const add = (window, forced) => {
      const source = record(window);
      const percent = finite(source?.used_percent);
      if (percent === null) return;
      const mapped = forced ?? codexWindow(source.limit_window_seconds);
      // The primary window may already be the weekly one. A supplementary window must not
      // overwrite it, and must not be published twice under the same id.
      if (claimed.has(mapped.id)) return;
      claimed.add(mapped.id);
      const resetAt = instant(source.reset_at);
      rows.push({ windowId: mapped.id, label: mapped.label, resetAt,
        raw: { percent, method: 'reported_percent', scopeKey: 'all', unit: 'percent',
          windowSemantics: mapped.declared === false ? 'unknown' : semantics(resetAt),
          cycleKey: cycleKey(resetAt), precisionEvidence: precision(percent) } });
    };
    add(limits.primary_window, null);
    add(limits.secondary_window, { id: 'weekly', label: '주간', declared: true });
    add(limits.tertiary_window, { id: 'monthly', label: '월간', declared: true });
    // additional_rate_limits carries per-model limits such as the Spark burst window. The
    // existing path deliberately stopped emitting those, so publishing them here would
    // resurrect windows the rest of the product has no scope for.
    return rows;
  },
};

// Claude reports an overall five-hour window, an overall weekly window, and weekly windows
// scoped to particular models. The scoped ones are a different measurement of a different
// limit, so they keep their own scope key and are never filled in from the overall figure.
const CLAUDE_OVERALL = [
  { field: 'five_hour', id: 'five-hour', label: '5시간' },
  { field: 'seven_day', id: 'weekly', label: '주간' },
];
// The model-scoped buckets the endpoint names directly. The same limits also appear in the
// limits array, and an account may carry either or both.
const CLAUDE_SCOPED = [
  { field: 'seven_day_fable', label: 'Fable' },
  { field: 'seven_day_opus', label: 'Opus' },
  { field: 'seven_day_sonnet', label: 'Sonnet' },
];

const claudeAdapter = {
  provider: 'anthropic', endpointId: 'oauth-usage', sourceVersion: 'anthropic-oauth-usage-1',
  appliesTo: oauthOnly,
  parse(json) {
    const body = record(json);
    if (body === null) return [];
    const rows = [];
    const claimed = new Set();
    const add = (windowId, label, scopeKey, percent, resetValue) => {
      const value = finite(percent);
      if (value === null || claimed.has(windowId)) return;
      claimed.add(windowId);
      const resetAt = instant(resetValue);
      rows.push({ windowId, label, resetAt,
        raw: { percent: value, method: 'reported_percent', scopeKey, unit: 'percent',
          windowSemantics: semantics(resetAt), cycleKey: cycleKey(resetAt),
          precisionEvidence: precision(value) } });
    };
    for (const { field, id, label } of CLAUDE_OVERALL) {
      const bucket = record(body[field]);
      if (bucket !== null) add(id, label, 'all', bucket.utilization, bucket.resets_at);
    }
    for (const { field, label } of CLAUDE_SCOPED) {
      const bucket = record(body[field]);
      const id = scopedId(label);
      if (bucket !== null && id !== null) {
        add(id, label, id.slice('custom-'.length), bucket.utilization, bucket.resets_at);
      }
    }
    // The limits array repeats the two overall windows under 'session' and 'weekly_all'. Only
    // a model-scoped entry describes a limit the buckets above do not already carry, and the
    // claimed set keeps a model that appears in both from being collected twice.
    for (const entry of Array.isArray(body.limits) ? body.limits : []) {
      const limit = record(entry);
      if (text(limit?.kind)?.trim().toLowerCase() !== 'weekly_scoped') continue;
      const label = text(record(record(limit.scope)?.model)?.display_name)?.trim();
      if (!label) continue;
      // A display name that carries no letter or digit cannot name a window. Publishing it
      // under a bare prefix would merge it with the next such window.
      const id = scopedId(label);
      if (id === null) continue;
      add(id, label, id.slice('custom-'.length), limit.percent, limit.resets_at);
    }
    return rows;
  },
};

// Cursor's own meter reports a percentage and the spend it was computed from. The two do not
// agree: an account showing includedSpend 7845 of limit 40000 computes to 19.6125% while the
// endpoint reports 2.5306451612903227, and the vendor's own display message says 19%. Both
// numbers are kept, the reported one is published, and the disagreement is recorded rather
// than resolved, because which of the two the provider means is not ours to decide.
const cursorAdapter = {
  provider: 'cursor', endpointId: 'period-usage', sourceVersion: 'cursor-period-usage-1',
  appliesTo: oauthOnly,
  parse(json) {
    const body = record(json);
    const plan = record(body?.planUsage);
    if (plan === null) return [];
    const resetAt = instant(body.billingCycleEnd ?? plan.billingCycleEnd ?? body.periodEnd);
    const shared = { unit: 'usd-cents', windowSemantics: semantics(resetAt), cycleKey: cycleKey(resetAt) };
    const rows = [];
    const reported = finite(plan.totalPercentUsed ?? plan.percentUsed);
    const used = finite(plan.includedSpend ?? plan.usedCents ?? plan.used);
    const limit = finite(plan.limit ?? plan.limitCents ?? plan.totalLimitCents);
    if (reported !== null || used !== null) {
      rows.push({ windowId: 'monthly', label: '월간', resetAt,
        raw: { ...shared, scopeKey: 'all', used, limit,
          // Declared rather than inferred. Left to the contract's own default, a reading that
          // carries both a reported percentage and a spend pair would be labelled as computed
          // from the pair while publishing the reported number.
          ...(reported === null ? {} : { percent: reported, method: 'reported_percent' }),
          precisionEvidence: precision(reported, used, limit) } });
    }
    // The two secondary pools. They measure part of the plan, never the whole of it, so they
    // are separate windows rather than a replacement for the total above.
    for (const [field, label] of [['autoPercentUsed', 'First-party models'], ['apiPercentUsed', 'API usage']]) {
      const percent = finite(plan[field]);
      const id = scopedId(label);
      if (percent === null || id === null) continue;
      rows.push({ windowId: id, label, resetAt,
        raw: { ...shared, unit: 'percent', scopeKey: id.slice('custom-'.length),
          percent, method: 'reported_percent', precisionEvidence: precision(percent) } });
    }
    return rows;
  },
};

// Grok reports two different things from two different endpoints. The weekly credit window is
// what actually gates prompting; the legacy monthly pool is a dollar allowance. They are
// separate windows on purpose: substituting one for the other when its own endpoint fails
// would publish a number nobody measured for that period.
const grokCreditsAdapter = {
  provider: 'xai', endpointId: 'grok-credits', sourceVersion: 'xai-grok-credits-1',
  appliesTo: oauthOnly,
  parse(json) {
    const config = record(record(json)?.config);
    const period = record(config?.currentPeriod);
    if (config === null || period === null || period.type !== 'USAGE_PERIOD_TYPE_WEEKLY') return [];
    const percent = finite(config.creditUsagePercent);
    // The wire format omits a zero-valued field, so an absent percentage and a measured zero
    // look identical. Reading the absence as zero would report usage nobody observed, so an
    // unreported window is left unreported.
    if (percent === null) return [];
    const resetAt = instant(period.end);
    return [{ windowId: 'weekly', label: '주간', resetAt,
      raw: { percent, method: 'reported_percent', scopeKey: 'all', unit: 'percent',
        windowSemantics: semantics(resetAt), cycleKey: cycleKey(resetAt),
        precisionEvidence: precision(percent) } }];
  },
};

const grokBillingAdapter = {
  provider: 'xai', endpointId: 'grok-billing', sourceVersion: 'xai-grok-billing-1',
  appliesTo: oauthOnly,
  parse(json) {
    const config = record(record(json)?.config);
    if (config === null) return [];
    const used = finite(record(config.used)?.val);
    const limit = finite(record(config.monthlyLimit)?.val);
    if (used === null && limit === null) return [];
    const resetAt = instant(config.billingPeriodEnd);
    // A limit of zero is not a limit of nothing used. The measurement contract records it as a
    // zero limit, which publishes no percentage, rather than dividing into it.
    return [{ windowId: 'monthly', label: '월간', resetAt,
      raw: { used, limit, unit: 'usd-cents', scopeKey: 'all',
        windowSemantics: semantics(resetAt), cycleKey: cycleKey(resetAt),
        precisionEvidence: precision(used, limit) } }];
  },
};

// Registration order is the merge precedence direct collection uses when two endpoints report
// the same window for one account, so it is a declaration rather than a race. A provider may
// appear more than once; adding one is adding an entry here.
export const ADAPTERS = [codexAdapter, claudeAdapter, cursorAdapter,
  grokCreditsAdapter, grokBillingAdapter, devinAdapter];
