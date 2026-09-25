import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MINUTE, HOUR, iso, expired } from './time.mjs';
import { projectMeasurement } from './quota-measurement.mjs';
import { USAGE_PERIODS, usageAnchor } from './analytics.mjs';
const WINDOWS = { session: ['five-hour', '5시간'], weekly: ['weekly', '주간'], monthly: ['monthly', '월간'] };
const MAX_OBSERVATION_GAP = 3 * MINUTE;
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
// What this provider's own number is: a fraction of the window, which is why a reading of
// 0.4237 must stay 42.37 rather than becoming 42. The percentage is derived here and the
// fraction is kept beside it as the evidence for that derivation.
const SOURCE = 'ollama-cloud/api-usage';
const SOURCE_VERSION = 'ollama-usage-v1';
// Why a lookup produced no reading, kept apart from the fact that it produced none. An
// expired key and an unreachable provider both stop the reading; only one of them is
// something the user can fix.
const REASONS = { credential: 'credential_rejected', provider: 'provider_unavailable',
  observation: 'observation_unavailable', configuration: 'configuration_unavailable' };

export function parseOllamaUsage(body) {
  const result = {};
  for (const name of Object.keys(WINDOWS)) {
    const value = body?.limits?.[name];
    if (!finite(value?.usage)) continue;
    const models = Object.create(null);
    for (const m of Array.isArray(value.models) ? value.models : []) {
      if (typeof m.name === 'string' && m.name.length <= 200 && Number.isSafeInteger(m.request_count) && m.request_count >= 0) models[m.name] = m.request_count;
    }
    // The fraction is stored beside the percentage rather than recovered from it later:
    // 0.07 * 100 / 100 is not 0.07, so a round trip would publish a number the provider
    // never sent.
    result[name] = { used: value.usage * 100, fraction: value.usage, models };
  }
  if (!Object.keys(result).length) throw new Error('Ollama usage unavailable');
  return result;
}

// The evidence for one window of one reading. Returns null for an observation recorded
// before the fraction was kept, because a basis that was never read cannot be reconstructed.
function measurementOf(name, value, at) {
  if (typeof value.fraction !== 'number' || !Number.isFinite(value.fraction)) return null;
  const measurement = projectMeasurement({
    source: SOURCE, sourceVersion: SOURCE_VERSION, method: 'reported_fraction',
    fraction: value.fraction, scopeKey: `${SOURCE}/${name}`, observedAt: at,
    // Evidence about this reading, not a claim about the provider: a whole number here is
    // not proof that the next reading cannot carry decimals.
    precisionEvidence: Number.isInteger(value.fraction * 100) ? 'unknown' : 'observed_fraction',
  }, { fetchedAt: at });
  // A fraction outside 0..1 is not a share of a window, and the contract refuses it. The
  // window still publishes the number that was read; attaching an empty basis beside it
  // would claim evidence nobody has.
  return measurement !== null && measurement.reportedPercent !== null ? measurement : null;
}

// Calibrate only isolated, counter-matched model runs. Input/output ratios describe
// the observed workload mix; they are not separately identified GPU coefficients.
export function calibrateOllama(observations, usageRows, window) {
  const totals = new Map();
  let start = observations[0];
  for (let i = 1; i < observations.length; i++) {
    const end = observations[i], previous = observations[i - 1];
    const a = start?.limits[window], b = end.limits[window], prev = previous.limits[window];
    if (!a || !b || !prev || (end.at <= previous.at || end.at - previous.at > MAX_OBSERVATION_GAP) || b.used < prev.used ||
      Object.entries(prev.models).some(([m, n]) => (b.models[m] ?? 0) < n)) { start = end; continue; }
    const delta = b.used - a.used;
    if (end.at - start.at < 5 * MINUTE || delta < .2) continue;
    const changes = Object.entries(b.models).map(([model, n]) => [model, n - (a.models[model] ?? 0)]).filter(([, n]) => n > 0);
    const rows = usageRows.filter(r => r.at > start.at && r.at <= end.at);
    if (changes.length === 1) {
      const [model, count] = changes[0];
      const matches = rows.filter(r => r.model === model && r.tokensReported !== 0 && finite(r.input) && finite(r.output));
      if (rows.length === count && matches.length === count && matches.every(r => r.input + r.output > 0)) {
        const t = totals.get(model) ?? { model, intervals: 0, requests: 0, deltaPp: 0, inputTokens: 0, outputTokens: 0, apiUsd: 0, priced: true };
        t.intervals++; t.requests += count; t.deltaPp += delta;
        t.observedAt = iso(end.at);
        for (const r of matches) { t.inputTokens += r.input; t.outputTokens += r.output; t.priced &&= finite(r.usd); t.apiUsd += r.usd ?? 0; }
        totals.set(model, t);
        start = end;
      }
    }
    // The provider counter can trail the log across a polling boundary. Retain an
    // unmatched single-model prefix until its whole count agrees. A mixed workload
    // cannot identify one model's coefficient, so let a later isolated run start.
    if (changes.length > 1 || new Set(rows.map(r => r.model)).size > 1) start = end;
  }
  return [...totals.values()].map(t => ({ ...t, inputTokensPerPp: t.inputTokens / t.deltaPp,
    outputTokensPerPp: t.outputTokens / t.deltaPp, apiUsdPerPp: t.priced ? t.apiUsd / t.deltaPp : null }));
}

// This source has no reset/cycle evidence. Only adjacent, nondecreasing observations
// are a usable increase estimate; declines and counter rollovers are NOT proven resets.
// Do not run the fixed-cycle 1pp correction, recover gaps, or invent a reset timestamp.
function consumptionPeriods(observations, window, now) {
  const intervals = [];
  for (let i = 1; i < observations.length; i++) {
    const before = observations[i - 1], after = observations[i];
    const a = before.limits[window], b = after.limits[window], gap = after.at - before.at;
    if (!a || !b || !finite(a.fraction) || !finite(b.fraction) || a.fraction > 1 || b.fraction > 1 ||
        gap <= 0 || gap > MAX_OBSERVATION_GAP || after.at > now || b.used < a.used ||
        Object.entries(a.models).some(([model, count]) => (b.models[model] ?? 0) < count)) continue;
    intervals.push({ from: before.at, to: after.at, delta: b.used - a.used });
  }
  return Object.fromEntries(USAGE_PERIODS.map(([key, ms]) => {
    const from = now - ms;
    let deltaPp = 0, observedMs = 0, first = null, last = null;
    for (const interval of intervals) {
      const start = Math.max(from, interval.from), elapsed = interval.to - start;
      if (elapsed <= 0) continue;
      observedMs += elapsed;
      deltaPp += interval.delta * elapsed / (interval.to - interval.from);
      first ??= start; last = interval.to;
    }
    return [key, { deltaPp: observedMs >= 5 * MINUTE ? deltaPp : null,
      observedHours: observedMs / HOUR, spanHours: last === null ? 0 : (last - first) / HOUR,
      coverage: last === null ? null : Math.min(1, observedMs / ms),
      observedAt: iso(last), periodEndedAt: iso(now), basis: 'observed-increase',
      recoveredDeltaPp: 0, recoveredHours: 0, resetGapCount: 0, resetGaps: [] }];
  }));
}

export function createOllamaMonitor({ home, store, now = Date.now, fetcher = fetch }) {
  store.db.exec('CREATE TABLE IF NOT EXISTS ollama_observations (source TEXT, at INTEGER, payload TEXT, PRIMARY KEY(source,at))');
  let sources = [], failed = false, lastAttemptAt = null;
  async function collect() {
    lastAttemptAt = now();
    try {
      const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
      const p = config.providers?.['ollama-cloud'];
      sources = [];
      if (!p || p.disabled) return;
      const url = new URL(p.baseUrl ?? 'https://ollama.com');
      if (url.origin !== 'https://ollama.com' || url.username || url.password || !['/', '/v1', '/v1/', '/api', '/api/'].includes(url.pathname)) return;
      const keys = (p.apiKeyPool ?? []).filter(k => typeof k.id === 'string' && typeof k.key === 'string' && k.key);
      if (typeof p.apiKey === 'string' && p.apiKey && !keys.some(k => k.key === p.apiKey)) keys.push({ id: 'default', key: p.apiKey });
      // IDs are aliases, not physical subscriptions. Equal keys prove that two
      // configured rows read the same counters; do not fetch or sum them twice.
      const unique = new Map();
      for (const k of keys) {
        if (!unique.has(k.key)) unique.set(k.key, { ...k, ids: [] });
        unique.get(k.key).ids.push(`key:${k.id}`);
      }
      failed = false;
      await Promise.all([...unique.values()].map(async k => {
        const source = createHash('sha256').update('quota-monitor-ollama\0' + k.key).digest('hex');
        const row = { ids: k.ids, source, isolated: unique.size === 1, failed: false, reason: null };
        sources.push(row);
        const fail = reason => { row.failed = true; row.reason = reason; };
        try {
          const response = await fetcher('https://ollama.com/api/usage', { headers: { Accept: 'application/json', Authorization: `Bearer ${k.key}` }, redirect: 'error', signal: AbortSignal.timeout(8000) });
          // A refused credential is the one failure the user can act on, so it does not
          // disappear into the same word as an unreachable provider.
          if (!response.ok) { fail([401, 403].includes(response.status) ? REASONS.credential : REASONS.provider); return; }
          const body = await response.text();
          if (body.length > 1024 * 1024) { fail(REASONS.provider); return; }
          let payload, limits;
          // A body that is not JSON is a broken answer, not an answer without windows. Folding
          // the two together would report a proxy error page as "nothing to measure yet".
          try { payload = JSON.parse(body); } catch { fail(REASONS.provider); return; }
          // A sound response carrying no limit at all is not a failed lookup: this
          // installation has no window to report yet, or this surface does not report one.
          try { limits = parseOllamaUsage(payload); } catch { fail(REASONS.observation); return; }
          store.db.prepare('INSERT OR IGNORE INTO ollama_observations VALUES (?,?,?)').run(source, now(), JSON.stringify(limits));
        } catch { fail(REASONS.provider); }
      }));
    } catch { failed = true; }
  }
  function enrich(snapshot, time = now()) {
    const provider = snapshot.providers.find(p => p.id === 'ollama-cloud');
    if (!provider) return snapshot;
    for (const { ids, source, isolated, failed: sourceFailed, reason } of sources) {
      const account = ids.map(id => provider.accounts.find(a => a.id === id)).find(Boolean);
      if (!account) continue;
      provider.accounts = provider.accounts.filter(a => !ids.includes(a.id) || a === account);
      account.refresh = { status: failed || sourceFailed ? 'delayed' : 'ok', lastAttemptAt: lastAttemptAt === null ? null : new Date(lastAttemptAt).toISOString(), nextAttemptAt: null,
        // The configuration read fails for every key at once, so it outranks a per-key reason.
        reason: failed ? REASONS.configuration : sourceFailed ? reason ?? REASONS.provider : null };
      const observations = store.db.prepare('SELECT at,payload FROM ollama_observations WHERE source=? AND at>? AND at<=? ORDER BY at').all(source, time - 30 * 86400000 - MAX_OBSERVATION_GAP, time).map(r => ({ at: r.at, limits: JSON.parse(r.payload) }));
      const latest = observations.at(-1);
      if (!latest) continue;
      const stale = expired(latest.at, time);
      account.updatedAt = new Date(latest.at).toISOString(); account.status = stale ? 'stale' : 'ok'; account.quotaMode = 'observed';
      account.windows = Object.entries(latest.limits).map(([name, value]) => {
        const measurement = measurementOf(name, value, latest.at);
        return { id: WINDOWS[name][0], label: WINDOWS[name][1],
          usedPercent: Math.min(100, value.used), remainingPercent: Math.max(0, 100 - value.used), resetAt: null, stale,
          ...(measurement === null ? {} : { measurement }) };
      });
      // Bare-provider historical requests are not assigned to today's key. They
      // can support calibration only during monitoring with a single key and
      // exact provider-side counter agreement.
      const matchedObservations = observations.filter(o => o.at <= usageAnchor(store, time));
      const usage = isolated && matchedObservations.length > 1 ? store.db.prepare("SELECT u.at,u.model,u.input,u.output,u.usd,COALESCE(t.tokensReported,0) AS tokensReported FROM usage u LEFT JOIN usage_timings t ON t.id=u.id WHERE u.provider='ollama-cloud' AND u.at>? AND u.at<=? ORDER BY u.at").all(matchedObservations[0].at, matchedObservations.at(-1).at) : [];
      account.ollama = { status: stale ? 'stale' : 'collecting', windows: Object.keys(latest.limits).map(name => ({
        id: WINDOWS[name][0], label: WINDOWS[name][1],
        consumptionPeriods: consumptionPeriods(observations, name, time),
        models: isolated ? calibrateOllama(matchedObservations, usage, name) : [] })) };
    }
    return snapshot;
  }
  return { collect, enrich };
}
