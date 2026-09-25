import { USAGE_PERIODS } from './analytics.mjs';
import { modelId, carriesSecret } from './snapshot.mjs';
import { HOUR, iso } from './time.mjs';

// Why one model still needs a price check. Every reason is decided from fields the price
// quote already publishes, so a reader can re-derive a finding from the same response
// rather than trust a hidden calculation. A model carries as many reasons as apply; the
// published count is models, never reasons.
export const PRICE_GAP_REASONS = Object.freeze({
  'price-missing': '이 모델의 단가를 확인하지 못했습니다.',
  'unpriced-usage': '현재 단가는 확인되는데 기록된 호출 일부가 환산에서 빠졌습니다. 그 호출의 조건을 현재 견적이 설명하지 못합니다.',
  'rate-missing': '실제로 필요한 단가 항목을 확인하지 못했습니다.',
  'source-missing': '이 단가의 출처 링크가 없습니다.',
  'checked-at-missing': '이 단가를 마지막으로 확인한 날짜가 없습니다.',
  'condition-missing': '이 단가에 어떤 조건이 붙는지 함께 확인되지 않았습니다.',
  'alias-unevidenced': '다른 모델 이름의 단가를 쓰는데 그 연결을 제공자 문서로 확인하지 못했습니다.',
  'price-conflict': '같은 조건에서 서로 다른 단가가 확인됩니다.',
});
const REASONS = Object.keys(PRICE_GAP_REASONS);

// The four billable slots and the id `unsupported` uses for each. A slot named there is a
// published statement that this source bills nothing for it, so it is declared rather than
// missing. Only an undeclared null is an unconfirmed item.
const RATE_ITEMS = [['input', 'input'], ['output', 'output'],
  ['cacheRead', 'cache-read'], ['cacheWrite', 'cache-write']];

const count = value => Number.isFinite(value) && value > 0 ? value : 0;
// Model names come from another product's files and "toString" is a valid model id, so
// every name-keyed map is prototype-free.
const bare = () => Object.create(null);
export const priceGapKey = (provider, model, reason) => `${provider}\0${model}\0${reason}`;
// The same gate the price list and the roster apply, and it is applied again here at
// publication: a name admitted when it was recorded is withheld once the configuration
// holds it as a credential.
const publishable = (name, excluded) =>
  typeof name === 'string' && modelId(name) !== null && !carriesSecret(name, excluded);

// Whether the recorded usage proves a slot is needed. Usage that never happened needs
// nothing, so a configured model nobody has called yet acquires no item at all. A usage row
// keeps input, output, cache-read and total tokens and no cache-write count, so cache-write
// need can never be observed and is reported as unknown rather than assumed either way.
function rateNeed(field, row) {
  if (row.requests <= 0) return 'none';
  if (field === 'cacheWrite') return 'unknown';
  if (field === 'cacheRead') return row.cachedTokens > 0 ? 'observed' : 'none';
  return 'observed';
}

/**
 * Judge one `modelPrices` row. Returns every reason this model's price is not fully
 * confirmed, in a stable order, with no reason invented for information the quote never
 * claimed to carry.
 */
export function judgeModelPrice(row) {
  if (!row || typeof row.model !== 'string') return [];
  const findings = [];
  const conditions = Array.isArray(row.conditions) ? row.conditions : [];
  // An unpriced quote has no rates, no source, no check date and no conditions. Reporting
  // each absence separately would multiply one fact into five, so the missing price is the
  // whole finding and the fields it necessarily lacks are not restated.
  if (row.status === 'unpriced') return [{ reason: 'price-missing', detail: row.reason ?? null }];
  // A confirmed current price does not explain a call that was already excluded. The
  // valuation asks questions this quote is not asked -- the input size, the service tier
  // that was actually applied, the instant -- so a priced model with excluded calls is a
  // real gap and the calls behind it belong in the impact below.
  if (count(row.unpricedRequests) > 0) findings.push({ reason: 'unpriced-usage', detail: null });
  const unsupported = new Set(Array.isArray(row.unsupported) ? row.unsupported : []);
  const usage = { requests: count(row.requests), cachedTokens: count(row.cachedTokens) };
  const items = RATE_ITEMS
    .filter(([field, id]) => (row.rates?.[field] ?? null) === null && !unsupported.has(id))
    .map(([field]) => ({ item: field, need: rateNeed(field, usage) }))
    .filter(item => item.need !== 'none');
  // At least one item the recorded usage actually reaches. An item whose need cannot be
  // observed rides along as context but never raises the finding by itself: counting it
  // would report every model that has no published cache-write rate, used or not. When such
  // an item does bite, the call it could not price is excluded and reported above.
  if (items.some(item => item.need === 'observed')) findings.push({ reason: 'rate-missing', detail: null, items });
  if ((row.sourceUrl ?? null) === null) findings.push({ reason: 'source-missing', detail: null });
  if ((row.checkedAt ?? null) === null) findings.push({ reason: 'checked-at-missing', detail: null });
  // An anonymous catalog row states four numbers and nothing about what changes them, so
  // every condition-dependent charge on it is unconfirmed. A row that does declare its
  // conditions is not flagged for the ones it truthfully has none of.
  if (row.status === 'local-catalog' && !conditions.length) findings.push({ reason: 'condition-missing', detail: null });
  // The rate came from another model id, either by alias resolution or by a derivation the
  // quote declares. That is only a gap while the provider's own page has not confirmed it.
  // A canonical name the configuration holds as a credential is withheld upstream and
  // arrives as null, so the borrowing it would have shown cannot be named here either.
  const pricedModel = typeof row.pricedModel === 'string' ? row.pricedModel : null;
  const aliased = (pricedModel !== null && pricedModel !== row.model) || conditions.includes('alias-derived');
  if (aliased && row.status !== 'official') findings.push({ reason: 'alias-unevidenced', detail: null, pricedModel });
  if (row.conflict) findings.push({ reason: 'price-conflict', detail: row.conflict.reason ?? null });
  return findings;
}

// Per-model usage bucketed into the five periods. Kept here so the period table is read in
// one place; the caller may cache the result, which is a pure function of provider and
// anchor.
export const readPeriodUsage = (store, provider, anchor) =>
  store.modelPeriodUsage(provider, anchor, USAGE_PERIODS);

/**
 * Calls and tokens the flagged models account for in each of the five usage periods, on the
 * same anchor and the same half-open boundary the usage periods already use. Amounts are
 * deliberately absent: what a missing price would have cost is not estimated.
 *
 * published names every model that reached the price list at all. A recorded name that did
 * not -- because its shape is not a model id, or because the configuration now holds it as a
 * credential -- can carry no finding and cannot be named, so its calls are counted under
 * withheldModel* rather than disappearing between the two.
 */
export function periodImpact(rows, anchor, flagged, published = null) {
  const periods = {};
  for (const [key, ms] of USAGE_PERIODS) {
    const bucket = { activeModels: 0, requests: 0, tokens: 0, unpricedRequests: 0, unpricedTokens: 0,
      unpricedUnsizedRequests: 0, unnamedModelRequests: 0, unnamedModelUnpricedRequests: 0,
      unnamedModelUnpricedTokens: 0, withheldModelRequests: 0, withheldModelUnpricedRequests: 0,
      withheldModelUnpricedTokens: 0, startedAt: iso(anchor - ms), endedAt: iso(anchor), hours: ms / HOUR };
    for (const row of rows) {
      const requests = row[`${key}Requests`] ?? 0;
      // A call with no recorded model name cannot be attributed to a model, so it can carry
      // no finding. It is reported on its own rather than dropped, because an unexplained
      // call is exactly what this field exists to surface.
      if (row.model === null) {
        bucket.unnamedModelRequests += requests;
        bucket.unnamedModelUnpricedRequests += row[`${key}UnpricedRequests`] ?? 0;
        bucket.unnamedModelUnpricedTokens += row[`${key}UnpricedTokens`] ?? 0;
        continue;
      }
      // Named, but under a name this response may not repeat. Counted without being named.
      if (published !== null && !published.has(row.model)) {
        bucket.withheldModelRequests += requests;
        bucket.withheldModelUnpricedRequests += row[`${key}UnpricedRequests`] ?? 0;
        bucket.withheldModelUnpricedTokens += row[`${key}UnpricedTokens`] ?? 0;
        continue;
      }
      if (!flagged.has(row.model) || requests <= 0) continue;
      bucket.activeModels += 1;
      bucket.requests += requests;
      bucket.tokens += row[`${key}Tokens`] ?? 0;
      bucket.unpricedRequests += row[`${key}UnpricedRequests`] ?? 0;
      bucket.unpricedTokens += row[`${key}UnpricedTokens`] ?? 0;
      bucket.unpricedUnsizedRequests += row[`${key}UnsizedRequests`] ?? 0;
    }
    periods[key] = bucket;
  }
  return periods;
}

/**
 * The same rows the aggregate above sums, kept per model instead. Neither existing field
 * answers this question: `models[].requests` counts the whole retained window and cannot
 * say which period a call fell in, while `periods` sums every flagged model together and
 * cannot say which model a period's calls belonged to. Amounts stay absent for the same
 * reason they are absent above -- what a missing price would have cost is not estimated.
 *
 * A flagged model with no row at all is reported as five zeroed periods rather than left
 * out, because the query behind these rows walks the longest period in full: absence is a
 * recorded zero over that span, not an unknown. It is still only a statement about the
 * retained log, which is what the screen says.
 */
export function modelPeriodImpact(rows, anchor, flagged, published = null) {
  const blank = () => Object.fromEntries(USAGE_PERIODS.map(([key, ms]) => [key,
    { requests: 0, tokens: 0, unpricedRequests: 0, unpricedTokens: 0, unpricedUnsizedRequests: 0,
      startedAt: iso(anchor - ms), endedAt: iso(anchor), hours: ms / HOUR }]));
  const byModel = bare();
  for (const model of flagged) {
    if (published !== null && !published.has(model)) continue;
    byModel[model] = blank();
  }
  for (const row of rows) {
    // A call with no recorded model name can carry no finding, so it reaches no bucket here.
    // The aggregate above is where it is still counted rather than dropped.
    if (row.model === null) continue;
    const periods = byModel[row.model];
    if (periods === undefined) continue;
    for (const [key] of USAGE_PERIODS) {
      const bucket = periods[key];
      bucket.requests = row[`${key}Requests`] ?? 0;
      bucket.tokens = row[`${key}Tokens`] ?? 0;
      bucket.unpricedRequests = row[`${key}UnpricedRequests`] ?? 0;
      bucket.unpricedTokens = row[`${key}UnpricedTokens`] ?? 0;
      bucket.unpricedUnsizedRequests = row[`${key}UnsizedRequests`] ?? 0;
    }
  }
  return byModel;
}

// One durable record of which price gaps are open, kept in the same meta store the model
// roster uses. Resolution and recurrence cannot be reconstructed from existing data: a
// price record only ever attaches to a call whose amount was settled, so nothing already
// stored says when a model stopped being unconfirmed.
const KEY = 'priceGapsV1';
const CHANGE_LIMIT = 100;
const PUBLISHED_CHANGES = 20;
const PUBLISHED_RESOLVED = 20;
const CHANGES = ['opened', 'resolved', 'recurred'];

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = value => Number.isFinite(value) && value > 0 ? value : null;
const counter = value => Number.isInteger(value) && value >= 0 ? value : 0;

function normalizeFinding(value) {
  if (!plain(value)) return null;
  const firstSeenAt = instant(value.firstSeenAt);
  if (firstSeenAt === null || typeof value.model !== 'string' || !REASONS.includes(value.reason)) return null;
  return { model: value.model, reason: value.reason, firstSeenAt,
    lastSeenAt: instant(value.lastSeenAt) ?? firstSeenAt, resolvedAt: instant(value.resolvedAt),
    occurrences: Math.max(1, counter(value.occurrences)), recurrences: counter(value.recurrences) };
}

function normalizeProvider(value) {
  if (!plain(value)) return null;
  const since = instant(value.since);
  if (since === null) return null;
  const findings = bare();
  if (plain(value.findings)) {
    for (const [key, finding] of Object.entries(value.findings)) {
      const next = normalizeFinding(finding);
      if (next) findings[key] = next;
    }
  }
  const changes = (Array.isArray(value.changes) ? value.changes : []).flatMap(change =>
    plain(change) && instant(change.at) !== null && typeof change.model === 'string' &&
    REASONS.includes(change.reason) && CHANGES.includes(change.change)
      ? [{ at: change.at, model: change.model, reason: change.reason, change: change.change }] : [])
    .slice(-CHANGE_LIMIT);
  // When a model was last judged and found to need nothing. A stored value that is not a
  // real instant is dropped rather than repaired, like every other field here.
  const confirmed = bare();
  if (plain(value.confirmed)) {
    for (const [model, at] of Object.entries(value.confirmed)) {
      const stamp = instant(at);
      if (stamp !== null) confirmed[model] = stamp;
    }
  }
  return { since, readings: counter(value.readings), seenAt: instant(value.seenAt), findings,
    confirmed, changes };
}

function normalizeState(value) {
  const providers = bare();
  if (plain(value) && plain(value.providers)) {
    for (const [id, provider] of Object.entries(value.providers)) {
      const next = normalizeProvider(provider);
      if (next) providers[id] = next;
    }
  }
  return { lastAttemptAt: instant(value?.lastAttemptAt), lastSuccessAt: instant(value?.lastSuccessAt),
    failureSince: instant(value?.failureSince), providers };
}

const emptyProvider = () => ({ status: 'collecting', since: null, readings: 0,
  modelsNeedingPriceCheck: 0, models: [], carriedModels: [], resolved: [], changes: [],
  confirmedNewModels: [], retiredModels: [], periods: null });

const rosterStateOf = (roster, model) =>
  (Array.isArray(roster?.models) ? roster.models : []).find(entry => entry.model === model)?.state ?? null;

export function createPriceGaps({ store, now = Date.now, changeLimit = CHANGE_LIMIT } = {}) {
  // Like the roster, this never breaks collection: its own failures are reported as its own
  // status rather than raised, because one unreadable stored value here must not take the
  // quota readings down with it.
  let broken = false;
  const load = () => { try { return normalizeState(store.get(KEY)); } catch { broken = true; return normalizeState(null); } };
  const save = state => { try { store.set(KEY, state); } catch { broken = true; } };
  // The oldest instant history still holds complete records for. Only past it can anything
  // be forgotten; what either source could still rediscover would come back as new and
  // repeat the same change forever.
  const forgetBefore = () => { try { return instant(store.get('usageExcludedBefore')) ?? 0; } catch { broken = true; return 0; } };

  const note = (entry, at, model, reason, change) => {
    entry.changes.push({ at, model, reason, change });
    if (entry.changes.length > changeLimit) entry.changes = entry.changes.slice(-changeLimit);
  };

  // One rule for forgetting: a finding nothing has seen since the completeness boundary is
  // dropped whether it was resolved or not. A finding still being seen carries a current
  // lastSeenAt and is never reached, so this never mistakes silence for a fix.
  function prune(entry, before) {
    if (!before) return;
    for (const [key, finding] of Object.entries(entry.findings)) {
      if (finding.lastSeenAt >= before) continue;
      delete entry.findings[key];
    }
    // The confirmation instants follow the same boundary. Without this the map only grows,
    // and a restart would read back a confirmation older than anything history still holds.
    for (const [model, at] of Object.entries(entry.confirmed)) {
      if (at >= before) continue;
      delete entry.confirmed[model];
    }
  }

  function applyProvider(state, id, rows, at, before, trusted) {
    const entry = state.providers[id] ??= { since: at, readings: 0, seenAt: null,
      findings: bare(), confirmed: bare(), changes: [] };
    // A record written before this field existed loads without it.
    entry.confirmed ??= bare();
    // A provider's first reading settles what is already open. Naming those as newly opened
    // would report the whole installation as freshly broken on its first run, and nothing
    // before that reading may be called resolved either: since reports where the recorded
    // history actually starts.
    const baseline = entry.readings === 0;
    entry.seenAt = at;
    entry.readings += 1;
    const current = new Set();
    const listed = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.model !== 'string') continue;
      listed.add(row.model);
      const judged = judgeModelPrice(row);
      // This reading judged the model and found nothing to confirm. Recorded only when the
      // cycle was trustworthy AND this provider's own model list parsed: a list that did not
      // parse still leaves a default model's row standing, and stamping that as a
      // confirmation would publish a success the read never earned.
      if (trusted && !judged.length) entry.confirmed[row.model] = at;
      for (const finding of judged) {
        const key = priceGapKey(id, row.model, finding.reason);
        current.add(key);
        const known = entry.findings[key];
        if (!known) {
          entry.findings[key] = { model: row.model, reason: finding.reason, firstSeenAt: at,
            lastSeenAt: at, resolvedAt: null, occurrences: 1, recurrences: 0 };
          if (!baseline) note(entry, at, row.model, finding.reason, 'opened');
          continue;
        }
        known.lastSeenAt = at;
        known.occurrences += 1;
        if (known.resolvedAt !== null) {
          known.resolvedAt = null;
          known.recurrences += 1;
          note(entry, at, row.model, finding.reason, 'recurred');
        }
      }
    }
    for (const [key, finding] of Object.entries(entry.findings)) {
      if (current.has(key) || finding.resolvedAt !== null) continue;
      // A model missing from this reading is not evidence that its price was confirmed. A
      // configuration that failed to parse projects to the same absence, and so does a model
      // simply taken out of the list. Only a model still in the reading can show that a
      // reason stopped applying; the rest keep their findings until retention forgets them.
      if (!listed.has(finding.model)) continue;
      finding.resolvedAt = at;
      note(entry, at, finding.model, finding.reason, 'resolved');
    }
    prune(entry, before);
  }

  function describe(state, id, rows, impact, roster, excluded, modelImpact, blocked) {
    const entry = state.providers[id] ?? null;
    const models = [];
    const flagged = new Set();
    const openKeys = new Set();
    const quotes = new Map();
    for (const row of rows) {
      // The same gate the price list applies, applied again here. These rows arrive already
      // filtered, and this keeps the module safe on its own terms rather than by trust.
      if (!publishable(row?.model, excluded)) continue;
      quotes.set(row.model, row);
      const judged = judgeModelPrice(row);
      if (!judged.length) continue;
      flagged.add(row.model);
      models.push({ model: row.model, sources: [...(Array.isArray(row.sources) ? row.sources : [])],
        priceStatus: row.status ?? null,
        pricedModel: publishable(row.pricedModel, excluded) ? row.pricedModel : null,
        requests: count(row.requests), unpricedRequests: count(row.unpricedRequests),
        tokens: count(row.tokens), rosterState: rosterStateOf(roster, row.model),
        // When this model last came through a trustworthy reading with nothing to confirm.
        // Not the same fact as the provider-wide lookup instant or the source's own printed
        // date, so it is published under its own name rather than folded into either.
        lastConfirmedAt: iso(entry?.confirmed?.[row.model] ?? null),
        // Filled below, once every flagged name is known, so the projection is read once per
        // provider instead of once per model.
        periods: null, carriedFindings: [],
        findings: judged.map(finding => {
          const key = priceGapKey(id, row.model, finding.reason);
          const known = entry?.findings?.[key] ?? null;
          openKeys.add(key);
          return { key, reason: finding.reason, note: PRICE_GAP_REASONS[finding.reason],
            detail: finding.detail ?? null, items: finding.items ?? null,
            pricedModel: publishable(finding.pricedModel, excluded) ? finding.pricedModel : null,
            // untracked is a finding the stored state has not recorded yet, which is what a
            // read before the first recording cycle honestly is. It does not mean new.
            state: known === null ? 'untracked' : 'open', recurred: (known?.recurrences ?? 0) > 0,
            firstSeenAt: iso(known?.firstSeenAt ?? null), lastSeenAt: iso(known?.lastSeenAt ?? null),
            occurrences: known?.occurrences ?? 0, recurrences: known?.recurrences ?? 0 };
        }) });
    }
    models.sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
    const perModel = typeof modelImpact === 'function' ? modelImpact(id, flagged, new Set(quotes.keys())) : null;
    if (perModel !== null) for (const row of models) row.periods = perModel[row.model] ?? null;
    // Findings the stored state still holds open that this reading did not raise again. Two
    // situations produce that without anything being confirmed: a recording cycle whose
    // sources could not be trusted, and a model that left the current rows altogether. A
    // clean cycle that still lists the model does resolve its finding, and applyProvider has
    // already stamped resolvedAt there, so nothing resolved can reach this.
    const carriedByModel = new Map();
    for (const [key, finding] of Object.entries(entry?.findings ?? {})) {
      if (finding.resolvedAt !== null || openKeys.has(key)) continue;
      if (!publishable(finding.model, excluded)) continue;
      if (!blocked && quotes.has(finding.model)) continue;
      if (!carriedByModel.has(finding.model)) carriedByModel.set(finding.model, []);
      // Only what the record actually holds. The items a rate finding listed, a conflict's
      // reason and the roster state at the time were never stored, so none is reconstructed.
      carriedByModel.get(finding.model).push({ key, reason: finding.reason,
        note: PRICE_GAP_REASONS[finding.reason], firstSeenAt: iso(finding.firstSeenAt),
        lastSeenAt: iso(finding.lastSeenAt), occurrences: finding.occurrences,
        recurrences: finding.recurrences });
    }
    const byReason = list => list.sort((a, b) => a.reason.localeCompare(b.reason));
    // Where a carried finding lands depends only on whether this reading already published
    // its model, so one model can never reach both lists and be counted twice.
    for (const row of models) row.carriedFindings = byReason(carriedByModel.get(row.model) ?? []);
    const named = new Set(models.map(row => row.model));
    const carriedModels = [...carriedByModel.entries()].filter(([model]) => !named.has(model))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([model, findings]) => ({ model, rosterState: rosterStateOf(roster, model),
        lastConfirmedAt: iso(entry?.confirmed?.[model] ?? null), findings: byReason(findings) }));
    const resolved = Object.entries(entry?.findings ?? {})
      // A finding the live quote still shows is not resolved, whatever the stored state last
      // managed to record. That happens when a reading could not be trusted enough to update
      // anything, and publishing both at once would contradict the same response. Stored
      // names pass the gate again, because a name admitted when it was recorded can be a
      // configured credential by the time it is read back.
      .filter(([key, finding]) => finding.resolvedAt !== null && !openKeys.has(key) &&
        publishable(finding.model, excluded))
      .sort((a, b) => b[1].resolvedAt - a[1].resolvedAt || a[0].localeCompare(b[0]))
      .slice(0, PUBLISHED_RESOLVED)
      .map(([key, finding]) => ({ key, model: finding.model, reason: finding.reason,
        note: PRICE_GAP_REASONS[finding.reason], firstSeenAt: iso(finding.firstSeenAt),
        lastSeenAt: iso(finding.lastSeenAt), resolvedAt: iso(finding.resolvedAt),
        occurrences: finding.occurrences, recurrences: finding.recurrences }));
    const changes = (entry?.changes ?? []).filter(change => publishable(change.model, excluded))
      .slice(-PUBLISHED_CHANGES).reverse()
      .map(change => ({ at: iso(change.at), model: change.model, reason: change.reason, change: change.change }));
    // A model whose price is confirmed is not a warning, however new it is, and neither is a
    // model that left the configuration cleanly. Both are named here so the distinction is
    // visible rather than implied by an absence.
    const seen = new Set();
    const confirmedNewModels = [];
    for (const change of Array.isArray(roster?.changes) ? roster.changes : []) {
      if (!['added', 'returned', 'observed'].includes(change.change)) continue;
      if (flagged.has(change.model) || !quotes.has(change.model) || seen.has(change.model)) continue;
      seen.add(change.model);
      confirmedNewModels.push({ model: change.model, change: change.change, at: change.at,
        priceStatus: quotes.get(change.model).status ?? null });
    }
    const retiredModels = (Array.isArray(roster?.models) ? roster.models : [])
      .filter(model => model.state === 'removed' && !flagged.has(model.model))
      .map(model => ({ model: model.model, removedAt: model.removedAt,
        priceStatus: quotes.get(model.model)?.status ?? null }));
    return { status: entry === null ? 'collecting' : state.failureSince !== null ? 'lookup-failed' : 'ok',
      since: iso(entry?.since ?? null), readings: entry?.readings ?? 0,
      // Derived from the list rather than counted alongside it, so the headline number and
      // the list cannot disagree.
      modelsNeedingPriceCheck: models.length,
      models, carriedModels, resolved, changes, confirmedNewModels, retiredModels,
      periods: typeof impact === 'function' ? impact(id, flagged, new Set(quotes.keys())) : null };
  }

  return {
    // One reading of the current price quotes. clean is the caller's statement that both the
    // model list and the price source actually answered: the catalog reports a failed read
    // and merely old rows with the same stale, so a gap is never closed on a reading that
    // may not have run.
    // listed names the providers whose own model list parsed on this read. It is separate
    // from clean because they fail separately: one provider's unreadable list leaves the
    // configuration file, the catalog and every other provider perfectly readable.
    record(entries, at = now(), { clean = true, listed = null } = {}) {
      broken = false;
      try {
        const state = load();
        const stamp = instant(at) ?? now();
        state.lastAttemptAt = stamp;
        if (!clean) { state.failureSince ??= stamp; save(state); return; }
        state.lastSuccessAt = stamp;
        state.failureSince = null;
        const before = forgetBefore();
        const trusted = listed instanceof Set ? listed : new Set(Array.isArray(listed) ? listed : []);
        for (const [id, rows] of Array.isArray(entries) ? entries : []) {
          if (typeof id !== 'string' || !id.length) continue;
          applyProvider(state, id, rows, stamp, before, trusted.has(id));
        }
        // A provider that left the configuration keeps its findings until retention passes
        // them, and is then forgotten whole. Its disappearance is never read as a price
        // being confirmed, and its state does not accumulate forever either.
        if (before) {
          for (const [id, entry] of Object.entries(state.providers)) {
            if ((entry.seenAt ?? entry.since) >= before) continue;
            delete state.providers[id];
          }
        }
        save(state);
      } catch { broken = true; }
    },
    // A cycle that produced no usable price reading. Every open finding stays exactly as it
    // was, resolves nothing, and only the failure is new.
    fail(at = now()) {
      broken = false;
      try {
        const state = load();
        const stamp = instant(at) ?? now();
        state.lastAttemptAt = stamp;
        state.failureSince ??= stamp;
        save(state);
      } catch { broken = true; }
    },
    enrich(snapshot, { rows = new Map(), impact = null, modelImpact = null, lookup = null, excluded = undefined } = {}) {
      const state = load();
      // Two different instants can say the lookup cannot be trusted, and using only the
      // stored one loses a window. The catalog and the model list are re-read every
      // collection while the gap state is recorded every five minutes, so a source that
      // fails right after a recording leaves failureSince null until the next one. Reading
      // both means a finding is carried from the moment its lookup breaks rather than from
      // the next recording cycle.
      const blocked = state.failureSince !== null || (lookup ? lookup.clean !== true : false);
      for (const provider of snapshot.providers) {
        try {
          provider.analytics.priceGaps = describe(state, provider.id,
            rows.get(provider.id) ?? [], impact, provider.analytics.modelRoster ?? null, excluded,
            modelImpact, blocked);
        } catch { broken = true; provider.analytics.priceGaps = emptyProvider(); }
      }
      // A provider this response carries no object for cannot publish its own gaps, and a
      // configuration that failed to parse projects to exactly that. Inventing the provider
      // would be worse than the silence, so its id is named and nothing else is claimed.
      const reported = new Set(snapshot.providers.map(provider => provider.id));
      const unreportedProviders = Object.entries(state.providers)
        .filter(([id, provider]) => !reported.has(id) &&
          Object.values(provider.findings).some(finding => finding.resolvedAt === null &&
            publishable(finding.model, excluded)))
        .map(([id]) => id).sort();
      snapshot.analytics.priceGaps = {
        status: broken ? 'error' : state.failureSince !== null ? 'lookup-failed'
          : state.lastSuccessAt === null ? 'collecting' : 'ok',
        lastAttemptAt: iso(state.lastAttemptAt), lastSuccessAt: iso(state.lastSuccessAt),
        failureSince: iso(state.failureSince),
        // Reported as they stand and never read as proof either way: the catalog marks a read
        // failure and stale rows identically, and a model list that did not arrive is its own
        // separate signal.
        catalogStatus: lookup?.catalogStatus ?? null,
        modelListStatus: lookup?.modelListStatus ?? null,
        resolutionBlocked: lookup ? lookup.clean !== true : false,
        unreportedProviders,
      };
      return snapshot;
    },
  };
}
