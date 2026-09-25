import { readSnapshot, modelId, carriesSecret, MODEL_EXCLUSIONS, SOURCE_STATUS } from './snapshot.mjs';
import { readIdentities } from './identity.mjs';
import { openHistory } from './history.mjs';
import { enrichSnapshot, usageAnchor } from './analytics.mjs';
import * as pricing from './pricing.mjs';
import { createProviderRefresh } from './provider-refresh.mjs';
import { readCredentialSource } from './credential-source.mjs';
import { createBindingRegistry } from './account-binding.mjs';
import { createQuotaTransport } from './quota-transport.mjs';
import { createDirectQuota } from './direct-quota.mjs';
import { ADAPTERS as PROVIDER_QUOTA_ADAPTERS } from './provider-quota-adapters.mjs';
import { createOllamaMonitor } from './ollama.mjs';
import { createPricingCatalog } from './pricing-catalog.mjs';
import { createModelRoster } from './model-roster.mjs';
import { createPriceGaps, periodImpact, modelPeriodImpact, readPeriodUsage } from './price-gaps.mjs';
import { compareOllamaUsage } from './ollama-comparison.mjs';
import { iso } from './time.mjs';
import { join } from 'node:path';

// The provider adapters direct collection can register, re-exported so an entry point enables
// the feature by passing this list as directAdapters rather than by assembling its own.
export { PROVIDER_QUOTA_ADAPTERS };

// A strict ISO instant: Date.parse alone accepts RFC-2822 strings like
// "September 1, 2026 GMT+0000" and normalizes calendar overflows such as
// 2026-02-30, neither of which is a valid configured instant.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
function parseIsoInstant(value) {
  if (typeof value !== 'string') return NaN;
  const m = ISO_INSTANT.exec(value);
  if (!m) return NaN;
  const [, Y, M, D, hh, mm, ss, zone] = m;
  const year = +Y, month = +M, day = +D, hour = +hh, minute = +mm, second = +(ss ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return NaN;
  if (zone !== 'Z') { const z = /([+-])(\d{2}):(\d{2})/.exec(zone); if (+z[2] > 23 || +z[3] > 59) return NaN; }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  return Date.parse(value);
}

// Three separate discovery sources, never merged into one claim of support:
// what OCX lists in its configuration, and what the usage log actually recorded.
// The models.dev cache supplies prices to these rows; it does not create them, so a
// catalog of several thousand foreign rows never lands in the response.
// Records are built field by field — no configuration or catalog object is spread.
function describeModelPrices(provider, store, lookupModelPrice, listConditions, from, to, excluded = new Set()) {
  const entries = new Map();
  // A recorded or configured name passes this gate, and so does the canonical name a rate
  // was found under. They are different strings: an Ollama tag whose canonical form is a
  // configured key is itself admitted, because the key is not a whole delimited piece of the
  // tag. Gating only the outer name would publish the key through the canonical one.
  const publishable = name => typeof name === 'string' && modelId(name) !== null && !carriesSecret(name, excluded);
  for (const model of Array.isArray(provider.supportedModels) ? provider.supportedModels : []) {
    entries.set(model, { model, sources: ['ocx-config'], requests: 0, unpricedRequests: 0, tokens: 0, cachedTokens: 0 });
  }
  for (const row of store.observedModels(provider.id, from, to)) {
    // A recorded model name reaches the response through the same shape gate as a
    // configured one. The usage log is another product's file, so a name that is not a
    // model ID is not republished as one.
    if (modelId(row.model) === null || carriesSecret(row.model, excluded)) continue;
    const found = entries.get(row.model);
    entries.set(row.model, { model: row.model, sources: found ? [...found.sources, 'observed'] : ['observed'],
      requests: row.requests, unpricedRequests: row.unpricedRequests,
      tokens: row.tokens, cachedTokens: row.cachedTokens });
  }
  return [...entries.values()].map(entry => {
    // Priced as of this snapshot: peak schedules and published end dates both depend on
    // the instant asked about, so an absent timestamp would quote the wrong tariff.
    const price = lookupModelPrice(provider.id, entry.model, { timestamp: to });
    // Same instant and the same catalog as the quote above, so a listed condition belongs
    // to this row rather than to a differently asked question.
    const variants = listConditions(provider.id, entry.model, { timestamp: to });
    return { model: entry.model, sources: entry.sources, requests: entry.requests,
      unpricedRequests: entry.unpricedRequests,
      // Recorded totals for this model. cachedTokens is the evidence for whether a cache
      // read rate is one this installation actually needs.
      tokens: entry.tokens, cachedTokens: entry.cachedTokens,
      // The stored provider is the attribution key, not proof of the key that priced the
      // original call, and these are current prices rather than a historical tariff.
      providerBasis: 'attributed',
      status: price.status, unit: price.unit,
      // The id the rate was actually found under, so a price borrowed from another name is
      // visible rather than implied. Ollama tag aliases resolve to a canonical name here.
      // Devin's suffix collapsing happens inside the price lookup and its contract does not
      // report it, so an alias of that shape cannot be shown and none is invented.
      // A canonical name the configuration holds as a credential is withheld rather than
      // published, and the borrowing it would have shown is then not named at all.
      pricedModel: publishable(price.model) ? price.model : null,
      rates: { input: price.rates.input, output: price.rates.output,
        cacheRead: price.rates.cacheRead, cacheWrite: price.rates.cacheWrite },
      sourceUrl: price.sourceUrl, checkedAt: price.checkedAt,
      effectiveFrom: price.effectiveFrom, effectiveTo: price.effectiveTo,
      conditions: [...price.conditions], unsupported: [...price.unsupported],
      conflict: price.conflict === null ? null : { status: price.conflict.status,
        rates: { ...price.conflict.rates }, reason: price.conflict.reason },
      // Every billing condition this model prices, each with the input size, service tier,
      // cache option or schedule phase that selects it. Built field by field, like the
      // quote above, so the enumeration contract can grow without widening this response.
      priceConditions: variants.conditions.map(row => ({ id: row.id,
        inputTokensFrom: row.inputTokensFrom, serviceTier: row.serviceTier,
        claudeCacheTtl: row.claudeCacheTtl, peak: row.peak,
        status: row.status,
        rates: { input: row.rates.input, output: row.rates.output,
          cacheRead: row.rates.cacheRead, cacheWrite: row.rates.cacheWrite },
        tierMultiplier: row.tierMultiplier, sourceUrl: row.sourceUrl, checkedAt: row.checkedAt,
        effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo,
        conditions: [...row.conditions], unsupported: [...row.unsupported],
        conflict: row.conflict === null ? null : { status: row.conflict.status,
          rates: { ...row.conflict.rates }, reason: row.conflict.reason },
        reason: row.reason })),
      // Whether that list can be believed to be the whole tariff. A table that keeps its
      // boundaries private can hide one from the search, and a screen that says nothing
      // would present a partial list as a complete one.
      priceConditionsComplete: variants.complete === true,
      reason: price.reason };
  }).sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
}

// Retained price records pass the same shape and secret gates as a configured model name,
// and they pass them on both of the names they carry. A call recorded under an alias can
// have been priced under the canonical id, and that id is exactly what a configuration key
// looks like -- gating only the outer name would publish the key through this new field.
// What the gate recognises is a key the current configuration declares. A rotated key that
// still looks like a model name cannot be identified, and none is claimed to be.
function publishedEvidence(rows, excluded) {
  const publishable = name => typeof name === 'string' && modelId(name) !== null && !carriesSecret(name, excluded);
  return rows.filter(row => publishable(row.model) && (row.evidence === null || publishable(row.evidence.pricedModel)))
    .map(row => ({ model: row.model,
      // Built field by field, and a record that could not be read back is reported as
      // unreadable rather than dereferenced, so one damaged row cannot empty the response.
      evidence: row.evidence === null ? null : {
        status: row.evidence.status, pricingProvider: row.evidence.pricingProvider,
        pricedModel: row.evidence.pricedModel,
        rates: row.evidence.rates === null ? null : { input: row.evidence.rates.input ?? null,
          output: row.evidence.rates.output ?? null, cacheRead: row.evidence.rates.cacheRead ?? null,
          cacheWrite: row.evidence.rates.cacheWrite ?? null },
        tierMultiplier: row.evidence.tierMultiplier, sourceUrl: row.evidence.sourceUrl,
        checkedAt: row.evidence.checkedAt, effectiveFrom: row.evidence.effectiveFrom,
        effectiveTo: row.evidence.effectiveTo,
        conditions: Array.isArray(row.evidence.conditions) ? [...row.evidence.conditions] : null,
        unsupported: Array.isArray(row.evidence.unsupported) ? [...row.evidence.unsupported] : null,
        conflict: row.evidence.conflict === null ? null : { status: row.evidence.conflict.status ?? null,
          rates: { input: row.evidence.conflict.rates?.input ?? null, output: row.evidence.conflict.rates?.output ?? null,
            cacheRead: row.evidence.conflict.rates?.cacheRead ?? null, cacheWrite: row.evidence.conflict.rates?.cacheWrite ?? null },
          reason: row.evidence.conflict.reason ?? null },
        reason: row.evidence.reason, firstRevision: row.evidence.firstRevision },
      requests: row.requests, storedApiUsd: row.storedApiUsd,
      firstAt: iso(row.firstAt), lastAt: iso(row.lastAt),
      firstPricedAt: iso(row.firstPricedAt), lastPricedAt: iso(row.lastPricedAt) }));
}

export async function createCollector({ home, codexHome, claudeHome, claudeProfile, dataDir, storage, catalogPath, managementOrigin = null, intervalMs = 10000, now = Date.now, claudeCacheTtl = '5m', claudeCacheFrom = null, directAdapters = [], directIntervalMs = 120000, directFetcher = null, directEndpoints = null, directPrepare = null, managementFetcher = null, ollamaFetcher = null, quotaIntervalMs = 120000 }) {
  // The cache-write TTL is a user assumption, so it is validated before any state
  // is opened: a bad setting must fail here, not after a database exists.
  if (claudeCacheTtl !== '5m' && claudeCacheTtl !== '1h') throw new Error('claudeCacheTtl must be 5m or 1h');
  let claudeCache = null;
  if (claudeCacheTtl === '1h') {
    const from = parseIsoInstant(claudeCacheFrom);
    if (!Number.isFinite(from)) throw new Error('claudeCacheFrom must be a valid ISO timestamp with a timezone when claudeCacheTtl is 1h');
    claudeCache = { ttl: '1h', from, basis: 'user-assumption' };
  }
  const catalog = await createPricingCatalog({file:catalogPath,now});
  const store = await openHistory(dataDir, storage);
  store.set('claudeCacheAssumption', claudeCache);
  const ollama = createOllamaMonitor({ home, store, now, ...(ollamaFetcher ? {fetcher:ollamaFetcher} : {}) });
  const roster = createModelRoster({ store, now });
  const priceGaps = createPriceGaps({ store, now });
  // The 1-hour cache-write assumption applies only from its configured instant, so a quote
  // is bound to the instant it is asked about rather than to the process.
  const quoteAt = at => (p, m, o) => catalog.lookupModelPrice(p, m,
    { ...o, ...(p === 'anthropic' && claudeCache !== null && at >= claudeCache.from ? { claudeCacheTtl: '1h' } : {}) });
  // The conditions are enumerated through the same catalog and the same cache-write option,
  // so the default condition of a row is the quote standing beside it.
  const conditionsAt = at => (p, m, o) => catalog.listModelPriceConditions(p, m,
    { ...o, ...(p === 'anthropic' && claudeCache !== null && at >= claudeCache.from ? { claudeCacheTtl: '1h' } : {}) });
  const directOwners = new Set(directAdapters.map(a => a.provider));
  const management = new Map();
  const lanes = new Map();
  const managementFor = id => {
    if (!management.has(id)) management.set(id, createProviderRefresh({home, codexHome, store, now,
      origin:managementOrigin, includeProviders:[id], excludeProviders:[...directOwners],
      ...(managementFetcher ? {fetcher:managementFetcher} : {})}));
    return management.get(id);
  };
  const registry = createBindingRegistry({ store, now });
  const transport = createQuotaTransport({ now,
    ...(directFetcher ? { fetcher: directFetcher } : {}),
    ...(directEndpoints ? { endpoints: directEndpoints } : {}) });
  // Direct collection stays off until an adapter list is passed in. The shipped adapters are
  // re-exported below, so enabling it is passing PROVIDER_QUOTA_ADAPTERS; defaulting to them
  // here would instead put every caller that builds a collector on the network, including the
  // tests, which read synthetic credentials out of temporary homes.
  const directs = [...directOwners].map(provider => createDirectQuota({ store, transport, registry, adapters: directAdapters.filter(a => a.provider === provider),
    // An adapter built per destination reads its configuration through this hook. Refreshing
    // here rather than inside the adapter keeps the destination exactly as fresh as the roster
    // it is judged against, because both collection and projection begin with this read, and
    // the adapters' own applicability check is synchronous and so cannot await anything.
    readSource: async () => {
      if (directPrepare) await directPrepare();
      return readCredentialSource({ home, codexHome, claudeHome, now: now() });
    },
    now, intervalMs: directIntervalMs }));
  // Direct last: it compares its own reading against what the earlier sources published.
  const observed = async (snapshot, at) => {
    let value = ollama.enrich(snapshot, at);
    for (const monitor of management.values()) value = monitor.enrich(value);
    for (const direct of directs) value = await direct.project(value, at);
    return value;
  };
  // Each owner has its own in-flight operation and due time. Never put a slow
  // provider in the promise awaited by usage ingestion or another provider.
  function launchLane(key, run, interval) {
    const lane = lanes.get(key) ?? {flight:null, nextAt:0};
    lanes.set(key, lane);
    if (stopped || lane.flight || now() < lane.nextAt) return lane.flight;
    lane.nextAt = now() + interval;
    lane.flight = Promise.resolve().then(run).catch(() => {
      console.error('quota-monitor: quota lane failed', key);
    }).finally(() => { lane.flight = null; });
    return lane.flight;
  }
  async function collectQuota({wait = true} = {}) {
    if (stopped) return;
    const read = await readSnapshot(home, now(), codexHome);
    if (stopped) return;
    const jobs = directs.map((direct, i) => launchLane('direct:' + [...directOwners][i], () => direct.collect(), 0));
    jobs.push(launchLane('ollama-cloud', () => ollama.collect(), quotaIntervalMs));
    for (const p of read.providers) if (p.enabled && p.id !== 'ollama-cloud' && !directOwners.has(p.id) && !['devin','devin-cli','google'].includes(p.id) && managementOrigin) {
      jobs.push(launchLane('management:' + p.id, () => managementFor(p.id).collect(), quotaIntervalMs));
    }
    if (wait) await Promise.allSettled(jobs.filter(Boolean));
  }
  let flight, timer, stopped = false, failure = null, identities = { labels: new Map(), plans: new Map() };
  let nextCacheReadAt = 0;
  let evidenceByProvider = new Map(), evidenceComputedAt = null, nextEvidenceAt = 0;
  let nextPriceGapAt = 0;
  // Per-model period usage is a pure function of the provider, the usage anchor and the rows
  // behind it. Caching on all three turns one indexed thirty-day scan per provider per
  // request into one per change. The anchor alone would not do: ingestion commits batch
  // after batch and yields between them, setting the anchor only once the file is consumed,
  // so a snapshot taken mid-ingest would serve rows the rest of its own response can already
  // see.
  let impactKey = null, impactByProvider = new Map();
  async function collect({waitForQuota = true} = {}) {
    if (stopped) return;
    if (waitForQuota) {
      await collectQuota();
      return collect({waitForQuota:false});
    }
    if (flight) return flight;
    flight = (async () => {
      // Whether this cycle got a model list at all. A list that was read stays read even
      // if the usage log fails afterwards, so the roster is not told the lookup failed.
      let listed = false;
      try {
        store.maintain(now());
        identities = await readIdentities(home, { codexHome, claudeHome, claudeProfile });
        await catalog.refresh();
        const read = await readSnapshot(home, now(), codexHome);
        // The list is settled here, before anything is projected onto it. Deciding after the
        // projection would let an unrelated failure downstream retract a lookup that did
        // succeed. Enrichment never changes the model lists, so this is the same list.
        listed = true;
        // A configuration that cannot be read no longer fails the snapshot, because quota
        // collection does not need one. The list still did not arrive, so the roster hears
        // that explicitly instead of mistaking a withheld list for an empty one.
        const configRead = read[SOURCE_STATUS]?.files?.ocxConfig?.status === 'ok';
        if (configRead) roster.record(read, now());
        else roster.fail(now());
        // observed() is async, because the direct reading reconciles account identity
        // against its own read of the credential files before it projects anything.
        store.capture(await observed(read), now());
        const usageFile = join(home, 'usage.jsonl');
        // A usage log that was never read is the normal state without OpenCodex installed.
        // One that existed and then vanished stays a collection failure, so the gap keeps
        // reading as a gap rather than as idle time.
        const everRead = store.get('usageCursor') !== null;
        const absent = error => error?.code === 'ENOENT' && !everRead;
        let reference = null;
        if (now() >= nextCacheReadAt) {
          try {
            const to = now(), comparison = await compareOllamaUsage(usageFile,{from:to-30*86400000,to});
            reference = {...comparison.cache,from:comparison.from,through:comparison.through,updatedAt:to,invalidLines:comparison.invalidLines};
          } catch (error) { if (!absent(error)) throw error; }
        }
        try { await store.ingest(usageFile, identities, catalog.priceUsage, now()); }
        catch (error) { if (!absent(error)) throw error; }
        if (reference) {store.set('cursorCacheReference',reference);nextCacheReadAt=now()+5*60000;}
        // Read here rather than per snapshot. The query walks the whole retained window and
        // DatabaseSync is synchronous, so its cost would otherwise be paid by every HTTP
        // request: 2240ms across six providers over 840k rows when it was measured. After
        // ingestion, so the calls this cycle just read are included rather than missing for
        // the next five minutes.
        if (now() >= nextEvidenceAt) {
          const at = now(), since = (store.bounds().since ?? 0) - 1;
          const collected = new Map();
          for (const provider of read.providers) collected.set(provider.id, store.priceEvidence(provider.id, since, at));
          // Swapped in only once every provider has answered, so a failure partway through
          // leaves the previous set whole instead of publishing a half-built one.
          evidenceByProvider = collected; evidenceComputedAt = at; nextEvidenceAt = at + 5 * 60000;
        }
        // Which models still need a price check, recorded on the cycle for the same reason
        // the evidence list is. Resolution is only ever decided from a reading that ran: the
        // catalog reports a failed read and merely old rows with the same stale, so anything
        // short of ok leaves every open finding exactly where it was.
        // A configuration that could not be read is the same problem from the other side: a
        // list that never arrived would make every configured model look absent.
        if (now() >= nextPriceGapAt) {
          const at = now(), since = (store.bounds().since ?? 0) - 1;
          const quote = quoteAt(at), excluded = read[MODEL_EXCLUSIONS];
          // Per provider, not per cycle. A model list that did not parse still leaves the
          // default model's price row standing, so a provider-blind reading would stamp that
          // row as a confirmed price on a read that never earned one.
          const listStatus = read[SOURCE_STATUS]?.providers ?? {};
          priceGaps.record(read.providers.map(provider =>
            [provider.id, describeModelPrices(provider, store, quote, conditionsAt(at), since, at, excluded)]),
          at, { clean: configRead && catalog.diagnostics().status === 'ok',
            listed: read.providers.filter(provider => listStatus[provider.id]?.modelListStatus === 'ok')
              .map(provider => provider.id) });
          nextPriceGapAt = at + 5 * 60000;
        }
        failure = null;
      } catch {
        failure = 'collection-failed';
        if (!listed) roster.fail(now());
        priceGaps.fail(now());
        console.error('quota-monitor: analytics collection failed');
      }
    })().finally(() => { flight = null; });
    return flight;
  }
  return {
    async start() {
      if (timer || stopped) return;
      void collectQuota({wait:false});
      timer = setInterval(() => { void collectQuota({wait:false}); void collect({waitForQuota:false}); }, intervalMs);
      timer.unref();
      await collect({waitForQuota:false});
    },
    collectQuota,
    collect,
    async snapshot() {
      // One instant for the whole snapshot: observation time, analytics and quoted
      // prices must not straddle a clock tick and disagree with each other.
      const at = now();
      const snapshot = await readSnapshot(home, at, codexHome);
      const enriched = enrichSnapshot(await observed(snapshot, at), store, identities, pricing, at, failure);
      enriched.analytics.pricingCatalog = catalog.diagnostics();
      // Reported only once direct collection is configured, so an install without adapters
      // publishes exactly the fields it published before.
      if (directAdapters.length) {
        const stats = directs.map(d => d.diagnostics());
        enriched.analytics.directQuota = {enabled:true, intervalSeconds:directIntervalMs / 1000,
          requests:stats.reduce((n,s)=>n+s.requests,0), retried:stats.reduce((n,s)=>n+s.retried,0),
          discarded:stats.reduce((n,s)=>n+s.discarded,0), endpoints:stats.flatMap(s=>s.endpoints)};
      }
      enriched.analytics.sampleIntervalSeconds = intervalMs / 1000;
      // The full retained history, not the thirty-day analytics horizon: a model that
      // stopped being called still has a price worth showing.
      const observedSince = store.bounds().since ?? 0;
      // One union for every provider: a key is a secret wherever it appears.
      const excluded = enriched[MODEL_EXCLUSIONS];
      // The 1-hour cache-write assumption applies only from its configured instant:
      // quotes before it keep the 5-minute rate.
      const cacheActive = claudeCache !== null && at >= claudeCache.from;
      const quoteLookup = quoteAt(at);
      const conditionLookup = conditionsAt(at);
      for (const provider of enriched.providers) {
        provider.analytics.modelPrices = describeModelPrices(provider, store, quoteLookup,
          conditionLookup, observedSince - 1, at, excluded);
        // Beside the current price list, what actually priced the calls already recorded.
        // A model the catalog has since dropped keeps its rates here while its modelPrices
        // row reports no current price at all.
        provider.analytics.priceEvidence = publishedEvidence(evidenceByProvider.get(provider.id) ?? [], excluded);
      }
      const anthropic = enriched.providers.find(p => p.id === 'anthropic');
      if (anthropic) anthropic.analytics.cacheWriteAssumption = cacheActive
        ? { ttl: '1h', from: new Date(claudeCache.from).toISOString(), basis: 'user-assumption' } : null;
      enriched.analytics.modelPriceConditions = pricing.PRICE_CONDITIONS;
      // Older than the snapshot by up to the refresh interval, and saying so.
      enriched.analytics.priceEvidenceComputedAt = iso(evidenceComputedAt);
      const reference = store.get('cursorCacheReference');
      const cursor = enriched.providers.find(p=>p.id==='cursor');
      if (cursor) cursor.analytics.cacheAssumption = reference ? {...reference,stale:Boolean(failure)||at-reference.updatedAt>15*60000} : {appliedRate:null,stale:false};
      // What this installation has offered over time, beside what it offers right now.
      roster.enrich(enriched, excluded);
      // After the roster, because a confirmed new model and a cleanly removed one are told
      // apart from a shortage warning by the roster's own transitions. The price rows are
      // the ones already published above, so a finding and the row it judges cannot drift.
      const anchor = usageAnchor(store, at);
      const catalogStatus = enriched.analytics.pricingCatalog.status;
      const modelListStatus = snapshot[SOURCE_STATUS]?.files?.ocxConfig?.status ?? null;
      // The impact rows are read against this response's own anchor, because the periods must
      // end where the rest of the response ends, and cached on the anchor together with the
      // revision of the rows behind it.
      const revision = anchor + '\0' + store.usageRevision();
      if (impactKey !== revision) { impactKey = revision; impactByProvider = new Map(); }
      const impactRows = id => {
        if (!impactByProvider.has(id)) impactByProvider.set(id, readPeriodUsage(store, id, anchor));
        return impactByProvider.get(id);
      };
      priceGaps.enrich(enriched, {
        rows: new Map(enriched.providers.map(provider => [provider.id, provider.analytics.modelPrices])),
        impact: (id, flagged, published) => periodImpact(impactRows(id), anchor, flagged, published),
        // The same cached rows, projected a second way. Per model rather than summed, because
        // the aggregate cannot say which model a period's calls belonged to.
        modelImpact: (id, flagged, published) => modelPeriodImpact(impactRows(id), anchor, flagged, published),
        excluded,
        lookup: { catalogStatus, modelListStatus,
          clean: failure === null && catalogStatus === 'ok' && modelListStatus === 'ok' },
      });
      return enriched;
    },
    async close() { stopped = true; clearInterval(timer); await flight; await Promise.allSettled([...lanes.values()].map(l => l.flight).filter(Boolean)); store.close(); },
  };
}
