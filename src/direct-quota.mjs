import { DIRECT_QUOTA_PREFIX } from './account-binding.mjs';
import { SOURCE_STATUS } from './snapshot.mjs';
import { projectMeasurement, publishedPercent } from './quota-measurement.mjs';
import { MINUTE, MEASURED_AT, IDENTITY_EPOCH, HISTORY_READING, expired } from './time.mjs';

export const DIRECT_KEY_PREFIX = DIRECT_QUOTA_PREFIX;
const ROSTER_PREFIX = 'directQuotaRosterV1';
const STALE_MS = 15 * MINUTE;
// The order the probe path (projectQuotaAccount in snapshot.mjs) publishes the standard
// windows in. The merge below sorts by it so a window's position is decided by what it
// measures, not by which source happened to refresh it last.
const WINDOW_ORDER = ['five-hour', 'short', 'weekly', 'monthly'];
  const key = (provider, account) => `${DIRECT_KEY_PREFIX}:${provider}:${account}`;
  const rosterKey = provider => `${ROSTER_PREFIX}:${provider}`;
  // One slot per endpoint per physical account. Defined once because two places need it --
  // the scheduler that decides when to ask again, and the projection that publishes when that
  // will be. Deriving the same string twice is how they drift apart.
  const slotOf = (binding, adapter) =>
    `${binding.provider}\0${binding.physical.digest ?? binding.accountId}\0${adapter.endpointId}`;
// A file that is absent is a settled answer; one that is mid-replacement is not, and only
// the latter may briefly reuse the last good roster.
const settled = status => status === 'ok' || status === 'empty';

/**
 * Reads a provider's own quota endpoint using a credential another client owns.
 *
 * Reconciliation and projection are one operation on purpose. Splitting them let a newer
 * snapshot apply an older reconciliation's verdict, so a replaced account inherited the
 * previous account's numbers. A projection now decides only from the roster it read itself,
 * and applies nothing when its own two reads disagree.
 */
export function createDirectQuota({ store, transport, registry, readSource, adapters = [],
  now = Date.now, intervalMs = 120000, maxConcurrent = 4,
  // An unchanged reading stretches its own interval up to idleMaxMs, which must stay under
  // the twenty-minute observation-gap threshold so idle time still reads as watched rather
  // than as a collection gap. A window inside resetLeadMs of its reset never stretches:
  // the reading just before the boundary is what bounds the pre-reset tail.
  idleMaxMs = 10 * MINUTE, resetLeadMs = 15 * MINUTE,
  backoff = { baseMs: MINUTE, maxMs: 8 * MINUTE, rateLimitedMaxMs: 30 * MINUTE, jitter: 0.2 },
  random = Math.random } = {}) {
  const owned = new Set(adapters.map(a => a.provider));
  const schedule = new Map();
  const flights = new Map();
  const lastGood = new Map();
  const counters = { requests: 0, retried: 0, discarded: 0 };
  let active = 0;
  const waiting = [];

  const applicable = binding => adapters.filter(adapter =>
    adapter.provider === binding.provider &&
    (typeof adapter.appliesTo !== 'function' || adapter.appliesTo(binding)));

  // Providers whose accounts came from a file being replaced keep their previous roster for
  // a short while. A provider whose file is simply gone does not: the accounts are settled.
  function rosterOf(source) {
    const result = new Map();
    for (const [provider, entry] of Object.entries(source.providers)) {
      if (entry.rosterStatus === 'unavailable') {
        const previous = lastGood.get(provider);
        if (previous && now() - previous.at <= STALE_MS) { result.set(provider, previous.entry); continue; }
      } else {
        lastGood.set(provider, { at: now(), entry });
      }
      result.set(provider, entry);
    }
    return result;
  }

  // Set reconciliation, not iteration. Iterating the accounts that still exist would never
  // retire one that disappeared, leaving its epoch open and its reading attributable.
  function reconcile(source) {
    const roster = rosterOf(source);
    const bindings = new Map();
    const seen = [];
    const sweep = (provider, present) => {
      const previous = store.get(rosterKey(provider)) ?? [];
      for (const accountId of previous) {
        if (present.includes(accountId)) continue;
        registry.retire({ key: provider + String.fromCharCode(0) + accountId, provider, accountId }, 'removed');
      }
      if (previous.join(',') !== present.join(',')) store.set(rosterKey(provider), present);
    };
    for (const [provider, entry] of roster) {
      if (!owned.has(provider)) continue;
      // A provider the user turned off is not read and not published. Its boundary is left
      // open on purpose: disabling is not replacing an account, so turning it back on must
      // return to the same epoch rather than start a new one. Counting it as seen keeps the
      // provider-set sweep below from retiring every account it owns.
      if (entry.enabled === false) { seen.push(provider); continue; }
      const tracked = entry.bindings.filter(binding => applicable(binding).length);
      const present = [];
      for (const binding of tracked) {
        if (binding.deleted) { registry.retire(binding, 'deleted'); continue; }
        const resolved = registry.resolve(binding);
        if (resolved === null) continue;
        present.push(binding.accountId);
        bindings.set(binding.key, { binding, epoch: resolved.epoch });
        const saved = store.get(key(provider, binding.accountId));
        if (saved?.epoch === resolved.epoch) for (const adapter of applicable(binding)) {
          const persisted = saved.endpoints?.[adapter.endpointId]?.schedule;
          const slot = slotOf(binding, adapter);
          if (!schedule.has(slot) && Number.isFinite(persisted?.nextAttemptAt)) {
            schedule.set(slot, {failures:persisted.failures ?? 0, nextAttemptAt:persisted.nextAttemptAt});
          }
        }
      }
      // Only a settled roster may declare an account gone. While a file is unreadable the
      // previous set is kept, so a transient parse failure does not retire everything.
      // A settled but empty set is an answer too: it must retire what it no longer lists.
      if (!settled(entry.rosterStatus)) continue;
      seen.push(provider);
      sweep(provider, present);
    }
    // A provider that vanished from a healthy read never enters the loop above, so its
    // accounts would keep their epoch and their cached reading forever. Compare the provider
    // set too, and only when the read itself was sound.
    const sound = Object.values(source.files).every(file => file.status !== 'unreadable');
    if (sound) {
      const before = store.get(rosterKey('__providers__')) ?? [];
      for (const provider of before) if (owned.has(provider) && !seen.includes(provider)) sweep(provider, []);
      const combined = [...before.filter(p => !owned.has(p)), ...seen].sort();
      if (before.join(',') !== combined.join(',')) store.set(rosterKey('__providers__'), combined);
    }
    return { roster, bindings };
  }

  async function withSlot(run) {
    if (active >= maxConcurrent) await new Promise(resolve => waiting.push(resolve));
    active += 1;
    try { return await run(); }
    finally { active -= 1; waiting.shift()?.(); }
  }

  function delay(failures, retryAfterMs, maxMs = backoff.maxMs) {
    const base = Math.min(maxMs, backoff.baseMs * 2 ** Math.max(0, failures - 1));
    const spread = base * backoff.jitter * (random() * 2 - 1);
    return Math.max(Math.round(base + spread), retryAfterMs ?? 0);
  }

  // Two readings are the same observation when every window keeps its id, its published
  // percentage and its reset within the minute the rest of the pipeline already tolerates.
  // Only the deadline/failure count survive restart. The signature is not stored,
  // so after that deadline the next successful reading starts at the base interval.
  const signatureOf = windows => (windows ?? [])
    .map(window => [window.id, window.usedPercent, Math.round((window.resetAt ?? 0) / 60000)].join('\0'))
    .sort().join('\0');

  // When the next attempt happens after a usable answer. An identical reading means the
  // provider has nothing new to say, so the slot backs off toward idleMaxMs instead of
  // asking every two minutes forever; any change drops it straight back to the base
  // interval. The jitter on the routine path keeps slots that were scheduled together
  // from staying synchronized and bursting the same endpoint at the same instant.
  function routineDelay(due, outcome) {
    const signature = signatureOf(outcome.windows);
    const idle = due?.signature === signature ? Math.min((due.idle ?? 0) + 1, 8) : 0;
    const nearReset = (outcome.windows ?? []).some(window =>
      Number.isFinite(window.resetAt) && window.resetAt - now() <= resetLeadMs);
    const stretch = nearReset ? intervalMs : Math.min(idleMaxMs, intervalMs * 2 ** idle);
    const wait = Math.round(stretch * (1 + backoff.jitter * (random() * 2 - 1)));
    return { idle, signature, wait };
  }

  // The write is guarded by equality against what was captured at dispatch: the epoch, the
  // physical digest and the deleted flag. The digest is compared in memory and never stored,
  // because for an API key it is derived from the key itself.
  //
  // Each endpoint owns its own slot. One account can be read by more than one endpoint, and a
  // single slot made the last reply to arrive the only one kept, so which reading survived was
  // decided by network timing rather than by what was measured.
  function commit(binding, captured, adapter, outcome, confirming) {
    const confirmed = confirming.providers[binding.provider]
      ?.bindings.find(entry => entry.accountId === binding.accountId);
    store.transact(() => {
      const current = store.epochs.current(binding.provider, binding.accountId);
      if (current?.epoch !== captured.epoch || confirmed === undefined ||
          confirmed.physical.digest !== captured.digest || confirmed.deleted !== false) {
        counters.discarded += 1;
        return;
      }
      const previous = store.get(key(binding.provider, binding.accountId));
      // Only slots from this same boundary are carried forward. A value written before this
      // shape existed cannot be attributed to an endpoint, so it is left behind rather than
      // guessed at; no released build could write one, because none registered an adapter.
      const slots = previous?.epoch === captured.epoch && previous?.endpoints !== null &&
        typeof previous?.endpoints === 'object' ? { ...previous.endpoints } : {};
      const prior = slots[adapter.endpointId]?.observation ?? null;
      const hidden = new Set(outcome.hidden ?? []);
      const retained = prior && hidden.size
        ? { ...prior, windows: prior.windows.filter(window => !hidden.has(window.id)) } : prior;
      store.set(key(binding.provider, binding.accountId), {
        epoch: captured.epoch,
        endpoints: { ...slots, [adapter.endpointId]: {
          schedule: {failures:outcome.schedule.failures, nextAttemptAt:outcome.schedule.nextAttemptAt},
          // A failed lookup never erases a good reading. Only a usable one replaces it, and
          // only in the slot belonging to the endpoint that made it.
          observation: outcome.windows?.length
            ? { measuredAt: outcome.measuredAt, windows: outcome.windows }
            : retained,
          // Evidence is replaced per window rather than per endpoint. A response that spoke
          // about one window of two has said nothing about the other, and clearing it would
          // throw away a reading that nothing replaced -- the same loss this field exists to
          // prevent. A window that regains a real denominator is named by the response that
          // rates it, so its stale evidence row still goes away.
          unrated: unratedFor(slots[adapter.endpointId], outcome),
          lastAttempt: { status: outcome.status, fetchedAt: outcome.fetchedAt,
            reason: outcome.reason ?? null },
        } },
      });
    });
  }

  // Which evidence rows survive this outcome. A lookup or parse that never produced a row set
  // leaves the previous rows untouched; otherwise each window the response named is replaced
  // by whatever that response now says about it, which may be nothing.
  function unratedFor(slot, outcome) {
    const retained = Array.isArray(slot?.unrated) ? slot.unrated : [];
    if (!Array.isArray(outcome.covered)) return retained.length ? retained : null;
    const spoken = new Set(outcome.covered);
    const rows = [...retained.filter(row => !spoken.has(row.id)), ...outcome.unrated];
    return rows.length ? rows : null;
  }

  function buildWindows(adapter, json, fetchedAt, binding) {
    const windows = [];
    // A reading the contract accepted but could not turn into a percentage. The evidence is
    // kept beside the windows rather than dropped: used/limit with a zero, missing or
    // unlimited denominator is still what the provider said, and the limit state is the point.
    const unrated = [];
    // Which windows this response actually spoke about. Only these may replace retained
    // evidence: a response that omits a window has said nothing about it, and clearing it
    // would discard a reading nothing replaced. A row the contract refused is not in here
    // either, because it supplies no replacement.
    const covered = [];
    const hidden = [];
    let measuredAt = fetchedAt;
    // The binding travels with the response so an adapter can check that the answer names the
    // account that was asked. The roster holds the digest; the adapter compares against it.
    for (const row of adapter.parse(json, { fetchedAt, binding }) ?? []) {
      // Only an explicit provider instruction suppresses a window. Missing data
      // still retains last-known evidence; suppression never advances its timestamp.
      if (row.hidden === true && typeof row.windowId === 'string') {
        hidden.push(row.windowId); covered.push(row.windowId); continue;
      }
      const measurement = projectMeasurement({ ...row.raw, source: adapter.provider + '/' + adapter.endpointId,
        sourceVersion: adapter.sourceVersion, scopeKey: row.raw?.scopeKey ?? row.windowId }, { fetchedAt });
      if (measurement === null) continue;
      covered.push(row.windowId);
      const percent = publishedPercent(measurement);
      const observed = Date.parse(measurement.observedAt);
      const resetAt = Number.isFinite(row.resetAt) ? row.resetAt : null;
      // Never coerce: Math.min(100, null) is 0, which would announce a reading nobody made.
      // The window cannot be published, so the reading is filed as evidence instead. Its own
      // instant travels with it: the block timestamp below only advances for published rows.
      if (percent === null) {
        unrated.push({ id: row.windowId, label: row.label ?? row.windowId, resetAt,
          measuredAt: Number.isFinite(observed) ? observed : fetchedAt, measurement });
        continue;
      }
      const usedPercent = Math.min(100, percent);
      if (Number.isFinite(observed)) measuredAt = observed;
      windows.push({ id: row.windowId, label: row.label ?? row.windowId, usedPercent,
        remainingPercent: 100 - usedPercent, resetAt, measurement });
    }
    return { windows, unrated, covered, hidden, measuredAt };
  }

  async function attempt(binding, captured, adapter, source) {
    counters.requests += 1;
    let credential = source.token(binding.key);
    let result = await transport.request({ provider: adapter.provider, endpointId: adapter.endpointId, credential });
    let current = source;
    if (!result.ok && result.kind === 'unauthorized') {
      // Re-read before deciding. An expired token and a replaced account look identical
      // from a 401, and retrying into a new account would file its answer under the old one.
      current = await readSource();
      const confirmed = current.providers[binding.provider]
        ?.bindings.find(entry => entry.accountId === binding.accountId);
      if (confirmed === undefined || confirmed.deleted || confirmed.physical.digest !== captured.digest) {
        return { source: current, status: 'discarded', fetchedAt: result.fetchedAt, reason: 'identity_changed' };
      }
      const fresh = current.token(binding.key);
      if (fresh === null) {
        return { source: current, status: 'credential_missing', fetchedAt: result.fetchedAt, reason: null };
      }
      if (fresh.value === credential?.value) {
        return { source: current, status: 'credential_expired', fetchedAt: result.fetchedAt,
          reason: binding.expiresAt !== null && binding.expiresAt <= now() ? 'expired_at' : null };
      }
      counters.retried += 1;
      credential = fresh;
      result = await transport.request({ provider: adapter.provider, endpointId: adapter.endpointId, credential });
    }
    if (!result.ok) {
      return { source: current, status: result.kind, fetchedAt: result.fetchedAt,
        reason: null, retryAfterMs: result.retryAfterMs };
    }
    let built;
    // A parser that throws must still produce a recorded failure and a backoff, or the same
    // malformed response is fetched again on the very next tick.
    try { built = buildWindows(adapter, result.json, result.fetchedAt, binding); }
    catch { return { source: current, status: 'invalid_json', fetchedAt: result.fetchedAt, reason: null }; }
    return { source: current, status: built.windows.length ? 'ok' : 'observation_unavailable',
      fetchedAt: result.fetchedAt, measuredAt: built.measuredAt, windows: built.windows,
      // Both travel to the commit: the rows themselves and the scope they may replace.
      unrated: built.unrated, covered: built.covered, hidden: built.hidden, reason: null };
  }

  // Never rejects. The collector turns any throw into one collection-wide failure, which
  // would hide the other sources that succeeded.
  async function collect() {
    if (!adapters.length) return;
    try {
      const source = await readSource();
      const { bindings } = reconcile(source);
      await Promise.allSettled([...bindings.values()].flatMap(({ binding, epoch }) =>
        applicable(binding).map(async adapter => {
          const slot = slotOf(binding, adapter);
          const due = schedule.get(slot);
          if (due && now() < due.nextAttemptAt) return;
          const captured = { epoch, digest: binding.physical.digest };
          // One HTTP call per slot, but each binding that shares it commits through its own
          // guard. Sharing the write too would leave every other account unrecorded.
          const shared = flights.get(slot)
            ?? withSlot(() => attempt(binding, captured, adapter, source)).finally(() => flights.delete(slot));
          flights.set(slot, shared);
          const outcome = await shared;
          if (outcome.status === 'discarded') { counters.discarded += 1; return; }
          // Re-read before writing. The source captured before the request cannot reveal a
          // replacement that happened while it was in flight, so comparing it with itself
          // would pass every time.
          const confirming = await readSource();
          if (outcome.status === 'ok') {
            const routine = routineDelay(due, outcome);
            schedule.set(slot, { failures: 0, idle: routine.idle, signature: routine.signature,
              nextAttemptAt: now() + routine.wait });
          } else {
            const failures = (due?.failures ?? 0) + 1;
            // A 429 cools longer than an ordinary failure: the provider has already said it
            // is throttling, and Retry-After still floors the wait when it says more.
            const cap = outcome.status === 'rate_limited' && Number.isFinite(backoff.rateLimitedMaxMs)
              ? backoff.rateLimitedMaxMs : backoff.maxMs;
            schedule.set(slot, { failures, idle: due?.idle ?? 0, signature: due?.signature,
              nextAttemptAt: now() + delay(failures, outcome.retryAfterMs, cap) });
          }
          commit(binding, captured, adapter, {...outcome, schedule:schedule.get(slot)}, confirming);
        })));
    } catch (error) {
      console.error('quota-monitor: direct quota collection failed', error?.message ?? 'unknown');
    }
  }

  // The upper bound is the one Date itself enforces. A credential file in the wild carries
  // expires: 9007199254740991, and formatting that throws rather than returning null, which
  // inside a projection would fail the whole snapshot instead of one field.
  const iso = ms => Number.isFinite(ms) && ms > 0 && ms < 8.64e15
    ? new Date(ms).toISOString() : null;

  // One account's endpoints, read in the order the adapters were registered rather than the
  // order their replies arrived, so the merged reading does not depend on network timing.
  function merge(binding, value, at) {
    const slots = value.endpoints !== null && typeof value.endpoints === 'object' ? value.endpoints : {};
    const attempts = [];
    for (const adapter of applicable(binding)) {
      const slot = slots[adapter.endpointId];
      // The adapter travels with the slot so the schedule can be read under the same key the
      // collector wrote it under.
      if (slot) attempts.push({ id: adapter.endpointId, slot, adapter });
    }
    const windows = [];
    const claimed = new Set();
    for (const { slot } of attempts) {
      const observation = slot.observation;
      if (!observation?.windows?.length) continue;
      for (const window of observation.windows) {
        // Two endpoints can measure the same limit. The earlier adapter wins, so the winner
        // is a declared precedence rather than whichever reply landed last.
        if (claimed.has(window.id)) continue;
        claimed.add(window.id);
        // Freshness belongs to the reading that produced this window, not to the account.
        // A stale endpoint beside a fresh one must not borrow the fresh one's age.
        windows.push({ ...window, resetAt: iso(window.resetAt),
          // Which reading produced it. The projection compares on it, and history files the
          // sample at it; JSON.stringify ignores the symbol, so the response is unchanged.
          measuredAt: observation.measuredAt, [MEASURED_AT]: observation.measuredAt,
          // And which account produced it. This is the epoch the reading was committed under,
          // taken from the slot rather than looked up now: the public account id outlives a
          // physical replacement, so a later lookup would hand this measurement whichever
          // account currently holds the id. History stores it beside the observation.
          [IDENTITY_EPOCH]: value.epoch,
          stale: expired(observation.measuredAt, at) ||
            (window.resetAt !== null && (!Number.isFinite(window.resetAt) || window.resetAt <= at)) });
      }
    }
    // Readings the contract accepted but could not rate. They are not windows and must never
    // be mistaken for one, so they carry no usedPercent or remainingPercent at all -- a null
    // there reads as a measured zero. Same precedence as the windows above: the earlier
    // adapter wins, by declaration rather than by which reply landed last.
    const evidence = [];
    const evidenced = new Set();
    for (const entry of attempts) {
      const rows = Array.isArray(entry.slot.unrated) ? entry.slot.unrated : [];
      for (const row of rows) {
        if (evidenced.has(row.id)) continue;
        evidenced.add(row.id);
        // Freshness belongs to the reading that produced this row, not to the account: these
        // rows never enter account.windows and so never inherit account.updatedAt.
        evidence.push({ id: row.id, label: row.label, endpointId: entry.id,
          resetAt: iso(row.resetAt), measuredAt: iso(row.measuredAt),
          stale: expired(row.measuredAt, at) ||
            (row.resetAt !== null && (!Number.isFinite(row.resetAt) || row.resetAt <= at)),
          measurement: row.measurement });
      }
    }
    const schedules = attempts
      .map(entry => schedule.get(slotOf(binding, entry.adapter))?.nextAttemptAt)
      .filter(value => Number.isFinite(value));
    const statuses = attempts.map(entry => entry.slot.lastAttempt?.status ?? 'unknown');
    const succeeded = statuses.filter(status => status === 'ok').length;
    const failed = attempts.find(entry => (entry.slot.lastAttempt?.status ?? 'unknown') !== 'ok');
    return {
      windows, evidence,
      // The soonest instant any of this account's endpoints may change its answer. Unlike
      // provider-refresh, which publishes this only while a retry is pending, the routine
      // interval is published too: the point is to tell the user when to look again.
      nextAttemptAt: schedules.length ? Math.min(...schedules) : null,
      // Partial is its own answer. Reporting the failure alone would hide a reading that was
      // taken, and reporting ok alone would hide an endpoint that never answered.
      status: !statuses.length ? 'unknown'
        : succeeded === statuses.length ? 'ok'
          : succeeded ? 'partial' : statuses[0],
      reason: failed ? failed.slot.lastAttempt?.reason ?? null : null,
      lastAttemptAt: attempts.reduce((latest, entry) =>
        Math.max(latest, entry.slot.lastAttempt?.fetchedAt ?? 0), 0),
      endpoints: attempts.map(entry => ({ id: entry.id,
        status: entry.slot.lastAttempt?.status ?? 'unknown',
        lastAttemptAt: iso(entry.slot.lastAttempt?.fetchedAt),
        nextAttemptAt: iso(schedule.get(slotOf(binding, entry.adapter))?.nextAttemptAt),
        reason: entry.slot.lastAttempt?.reason ?? null })),
    };
  }

  /** Reconcile and project in one step, using only this call's own read. */
  async function project(snapshot, at = now()) {
    if (!adapters.length) return snapshot;
    const source = await readSource();
    const { roster } = reconcile(source);
    const published = snapshot[SOURCE_STATUS]?.providers ?? {};
    for (const provider of snapshot.providers) {
      if (!owned.has(provider.id)) continue;
      // A provider the user turned off publishes nothing here, exactly as the other
      // enrichment paths already skip it.
      if (roster.get(provider.id)?.enabled === false) continue;
      for (const account of provider.accounts) {
        const binding = roster.get(provider.id)?.bindings.find(entry => entry.accountId === account.id);
        // The snapshot and this read disagree about who exists. Apply nothing.
        if (binding === undefined) continue;
        // They may also disagree about WHO this account is. The public id survives a
        // physical replacement, so matching on it alone would attach one account's reading
        // to its successor. Compare the evidence each read recorded.
        const seen = published[provider.id]?.accounts?.[account.id];
        if (seen !== undefined && seen !== null && binding.physical.digest !== null &&
            seen !== binding.physical.digest) continue;
        const value = store.get(key(provider.id, account.id));
        const current = store.epochs.current(provider.id, account.id);
        if (!value || !current || value.epoch !== current.epoch) continue;
        const merged = merge(binding, value, at);
        if (!merged.endpoints.length) continue;
        account.directQuota = { status: merged.status,
          lastAttemptAt: iso(merged.lastAttemptAt), nextAttemptAt: iso(merged.nextAttemptAt),
          reason: merged.reason, expiresAt: iso(binding.expiresAt),
          endpoints: merged.endpoints,
          ...(merged.evidence.length ? { evidence: merged.evidence } : {}) };
        // A source that declares the account unusable still wins, and it wins where it always
        // did: nothing here is promoted into account.windows, account.status, updatedAt or
        // quotaMode, so every consumer that refuses a reauth or paused account keeps refusing
        // it. What changes is that the reading is no longer thrown away -- it is published
        // where a screen can show it as a past observation rather than as current headroom.
        // The identity checks above ran first, so a physically replaced account brings nothing
        // forward.
        if (['reauth', 'paused'].includes(account.status)) {
          account.directQuota.lastKnown = { accountStatus: account.status,
            windows: merged.windows.map(({ measuredAt, ...window }) =>
              ({ ...window, measuredAt: iso(measuredAt) })) };
          continue;
        }
        if (!merged.windows.length) continue;
        // Display may prefer a newer cache reading, but its missing epoch must not switch
        // the account's consumption to a different stream. These readings were committed
        // under the matching physical identity above; no identity is assigned to the cache.
        const historyById = new Map(merged.windows.map(window => [window.id, window]));
        account.windows = account.windows.map(window => historyById.has(window.id)
          ? {...window, [HISTORY_READING]:historyById.get(window.id)} : window);
        const existing = Date.parse(account.updatedAt) || 0;
        // Each window is judged by the reading behind it, not by the account. Judging the set
        // by its newest endpoint let a fresh endpoint carry another endpoint's older window
        // over a newer reading the snapshot already had; judging it by its oldest let one
        // endpoint that had fallen behind withhold every other endpoint's fresh reading for
        // as long as it kept failing. Neither is necessary: a window is published when its
        // own reading is at least as new as what is already there.
        //
        // "What is already there" is that window's own instant — its measured time when one
        // was recorded, the account's otherwise. And a newer timestamp is not a newer reading:
        // when the published window says the same percent under the same cycle, the retained
        // measurement keeps its claim. Without this, every cache refresh that restated the
        // same reading under a newer account timestamp displaced the measured window, the
        // evidence shape flapped between transports, and history stored a bare echo with a
        // fresh basis break on every poll.
        const resetMs = value => value === null || value === undefined ? null : Date.parse(value);
        const samePublishedReading = window => {
          const published = account.windows.find(w => w.id === window.id);
          if (!published || published.usedPercent !== window.usedPercent) return false;
          const a = resetMs(published.resetAt), b = resetMs(window.resetAt);
          return a === null || b === null ? a === b : Math.abs(a - b) <= 60000;
        };
        const fresh = merged.windows.filter(window => {
          const published = account.windows.find(w => w.id === window.id);
          const publishedAt = published && Number.isFinite(published[MEASURED_AT])
            ? published[MEASURED_AT] : existing;
          return window.measuredAt >= publishedAt || samePublishedReading(window);
        });
        if (!fresh.length) continue;
        // A window this reading does not cover keeps whatever the earlier source published,
        // with the freshness that source gave it, instead of disappearing because another
        // window was refreshed.
        const covered = new Set(fresh.map(window => window.id));
        const newest = fresh.reduce((latest, window) => Math.max(latest, window.measuredAt), 0);
        // A window this reading does not cover keeps what the earlier source published, and
        // keeps that source's instant with it. Holding the account's timestamp back to suit it
        // instead would tell both clients the whole account is old, and they judge every
        // window's freshness by that one timestamp: a reading taken seconds ago would read as
        // fifteen minutes stale. The account is dated by the newest reading it has, and each
        // window says for itself when it was measured.
        // A window that already says when it was measured keeps that answer. Only one that
        // says nothing is told the account's previous instant, which is the one the source it
        // came from published it at.
        const kept = account.windows.filter(window => !covered.has(window.id))
          .map(window => Number.isFinite(window[MEASURED_AT])
            ? window : { ...window, [MEASURED_AT]: existing });
        // Position is decided by what a window measures, not by which reading refreshed it
        // last. The standard windows hold the probe path's order, every other window keeps
        // the spot it first appeared in, and credits stay last. Prepending whichever
        // windows this reading happened to cover let a partial answer reshuffle the card:
        // an account whose five-hour reading had moved on while the weekly one had not
        // published 'weekly' first until the next full refresh.
        const freshById = new Map(fresh.map(({ measuredAt, ...window }) => [window.id, window]));
        const keptById = new Map(kept.map(window => [window.id, window]));
        const firstSeen = new Map([...account.windows, ...fresh]
          .map((window, index) => [window.id, index]));
        const rank = id => {
          const standard = WINDOW_ORDER.indexOf(id);
          if (standard !== -1) return standard;
          return id === 'credits' ? 1000 : 100 + firstSeen.get(id);
        };
        const ids = [...new Set([...account.windows, ...fresh].map(window => window.id))]
          .sort((a, b) => rank(a) - rank(b));
        account.updatedAt = iso(Math.max(newest, existing));
        account.windows = ids.map(id => freshById.get(id) ?? keptById.get(id));
        account.status = account.windows.some(window => window.stale) ? 'stale' : 'ok';
        account.quotaMode = 'observed';
      }
    }
    return snapshot;
  }

  function diagnostics() {
    return { enabled: adapters.length > 0, intervalSeconds: intervalMs / 1000,
      requests: counters.requests, retried: counters.retried, discarded: counters.discarded,
      endpoints: adapters.map(adapter => `${adapter.provider}/${adapter.endpointId}`) };
  }

  return { collect, project, diagnostics };
}
