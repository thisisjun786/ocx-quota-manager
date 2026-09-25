import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openHistory } from '../src/history.mjs';
import { createCollector } from '../src/collector.mjs';
import { USAGE_PERIODS, usageAnchor, enrichSnapshot } from '../src/analytics.mjs';
import { judgeModelPrice, periodImpact, modelPeriodImpact, readPeriodUsage, createPriceGaps, priceGapKey, PRICE_GAP_REASONS } from '../src/price-gaps.mjs';

const HOUR = 3600000, DAY = 24 * HOUR, NOW = 1800000000000;
const iso = ms => new Date(ms).toISOString();
const identities = { labels: new Map([['openai\0pabcdef', 'a1']]), plans: new Map() };
const pricing = { pricingSources: [], lookupSubscription: () => ({ monthlyUsd: null }) };

// One modelPrices row exactly as the collector publishes it, fully confirmed by default so
// that each test changes only the one fact it is about.
const baseRow = (over = {}) => ({
  model: 'priced', sources: ['ocx-config'], requests: 10, unpricedRequests: 0, tokens: 2000,
  cachedTokens: 0, providerBasis: 'attributed', status: 'official', unit: 'usd-per-million-tokens',
  pricedModel: 'priced', rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  sourceUrl: 'https://provider.invalid/pricing', checkedAt: '2026-09-17',
  effectiveFrom: null, effectiveTo: null, conditions: ['long-context'], unsupported: [],
  conflict: null, reason: null, ...over });
// A renamed model prices under its own id unless the test says otherwise. Leaving the
// default behind would make every renamed fixture look like a borrowed price.
const priceRow = (over = {}) => {
  const row = baseRow(over);
  return { ...row, pricedModel: 'pricedModel' in over ? over.pricedModel : row.model };
};
const reasonsOf = row => judgeModelPrice(row).map(finding => finding.reason);

// The meta store as history exposes it, including the JSON round trip: state that survives
// a restart is the only state worth testing, and a prototype-free map has to come back.
const memoryStore = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { get: key => map.has(key) ? JSON.parse(map.get(key)) : null,
    set: (key, value) => map.set(key, JSON.stringify(value)) };
};
const snapshotOf = providers => ({ analytics: {},
  providers: providers.map(entry => ({ id: entry.id, analytics: { modelRoster: entry.roster ?? null } })) });
const impactOf = (store, provider, anchor, flagged, published = null) =>
  periodImpact(readPeriodUsage(store, provider, anchor), anchor, flagged, published);
const publish = (gaps, id, rows, lookup = { catalogStatus: 'ok', clean: true }, roster = null, excluded = undefined) => {
  const snapshot = snapshotOf([{ id, roster }]);
  gaps.enrich(snapshot, { rows: new Map([[id, rows]]), lookup, excluded });
  return snapshot.providers[0].analytics.priceGaps;
};

const flatPrice = row => ({ usd: row.model === 'unknown' ? null : 1, basis: 'official' });
const call = (id, at, model, over = {}) => ({ requestId: id, timestamp: at, provider: 'openai-pabcdef',
  model, usageStatus: 'reported', usage: { inputTokens: 100, outputTokens: 100 }, ...over });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quota-price-gaps-'));
  const store = await openHistory(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'usage.jsonl');
  return { dir, file, store,
    async ingest(rows, price = flatPrice, at = NOW) {
      await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      await store.ingest(file, identities, price, at);
    } };
}

test('an unsupported cache item is not a missing one, and a rate nothing reaches is not needed', () => {
  // A source that publishes no cache-write rate and says so has answered the question.
  // Counting its declaration as a gap is exactly the false positive this rule prevents.
  assert.deepEqual(reasonsOf(priceRow({ rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: null },
    unsupported: ['cache-write'] })), []);
  assert.deepEqual(reasonsOf(priceRow({ rates: { input: 1, output: 2, cacheRead: null, cacheWrite: null },
    unsupported: ['cache-read', 'cache-write'], cachedTokens: 900 })), []);
  // An undeclared null whose need cannot be observed does not raise the finding on its own.
  // A usage row never records cache-write tokens, so counting it would warn about every
  // model with no published cache-write rate, used or not.
  assert.deepEqual(reasonsOf(priceRow({ rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: null } })), []);
  // A configured model nobody has called needs nothing at all.
  assert.deepEqual(reasonsOf(priceRow({ requests: 0, unpricedRequests: 0, tokens: 0,
    rates: { input: 1, output: 2, cacheRead: null, cacheWrite: null } })), []);
  // A cache-read rate this installation never reaches is not something to confirm...
  assert.deepEqual(reasonsOf(priceRow({ rates: { input: 1, output: 2, cacheRead: null, cacheWrite: 1.25 },
    cachedTokens: 0 })), []);
  // ...and the same absence becomes one the moment cache reads are actually recorded. The
  // item whose need cannot be observed rides along as context once the finding exists.
  const reached = judgeModelPrice(priceRow({ rates: { input: 1, output: 2, cacheRead: null, cacheWrite: null },
    cachedTokens: 900 }));
  assert.deepEqual(reached.map(finding => finding.reason), ['rate-missing']);
  assert.deepEqual(reached[0].items, [{ item: 'cacheRead', need: 'observed' }, { item: 'cacheWrite', need: 'unknown' }]);
});

test('a confirmed current price does not explain a call that was already excluded', () => {
  // The valuation asks questions this quote is not asked: the input size, the service tier
  // that was actually applied, the instant. A model whose current price looks complete can
  // still have calls nobody could value, and those calls are the impact.
  const judged = judgeModelPrice(priceRow({ requests: 10, unpricedRequests: 1 }));
  assert.deepEqual(judged.map(finding => finding.reason), ['unpriced-usage']);
  assert.deepEqual(reasonsOf(priceRow({ requests: 10, unpricedRequests: 0 })), []);
  // An unpriced model says so once and does not restate it as a second reason.
  assert.deepEqual(reasonsOf(priceRow({ status: 'unpriced', unpricedRequests: 4, sourceUrl: null,
    checkedAt: null, rates: { input: null, output: null, cacheRead: null, cacheWrite: null } })), ['price-missing']);
});

test('the price-check count is models rather than reasons and matches the published list', () => {
  const gaps = createPriceGaps({ store: memoryStore(), now: () => NOW });
  // An anonymous catalog row: four numbers, no source, no check date, and nothing said
  // about what changes them.
  const rows = [priceRow({ model: 'catalog-only', status: 'local-catalog', sourceUrl: null,
    checkedAt: null, conditions: [] }), priceRow({ model: 'confirmed' })];
  gaps.record([['openai', rows]], NOW);
  const published = publish(gaps, 'openai', rows);
  assert.equal(published.models.length, 1);
  assert.equal(published.modelsNeedingPriceCheck, published.models.length);
  // Three reasons on one model. A count of reasons would say three and disagree with a
  // list of one, which is the whole point of defining the number as models.
  assert.deepEqual(published.models[0].findings.map(finding => finding.reason).sort(),
    ['checked-at-missing', 'condition-missing', 'source-missing']);
  for (const finding of published.models[0].findings) {
    assert.equal(finding.note, PRICE_GAP_REASONS[finding.reason]);
    assert.equal(finding.key, priceGapKey('openai', 'catalog-only', finding.reason));
  }
  // The same reading twice adds nothing: the key is what dedupes, not the order.
  gaps.record([['openai', rows]], NOW + 60000);
  const again = publish(gaps, 'openai', rows);
  assert.equal(again.modelsNeedingPriceCheck, 1);
  assert.equal(again.models[0].findings.length, 3);
  assert.equal(again.models[0].findings[0].occurrences, 2);
});

test('an unpriced model reports the missing price once rather than every field it lacks', () => {
  const judged = judgeModelPrice(priceRow({ status: 'unpriced', reason: '모델 단가 미확인',
    rates: { input: null, output: null, cacheRead: null, cacheWrite: null },
    sourceUrl: null, checkedAt: null, conditions: [] }));
  assert.deepEqual(judged.map(finding => finding.reason), ['price-missing']);
  assert.equal(judged[0].detail, '모델 단가 미확인');
});

test('a price borrowed from another model name is flagged only while nobody has confirmed it', () => {
  // A tag resolving to its canonical row under the provider's own published price is a
  // confirmed alias, not a gap.
  assert.deepEqual(reasonsOf(priceRow({ model: 'deepseek-v4-flash:0731', pricedModel: 'deepseek-v4-flash' })), []);
  // A derivation the quote itself declares, carrying a weaker grade than the provider page.
  const derived = judgeModelPrice(priceRow({ model: 'gpt-daybreak-blue-latest',
    pricedModel: 'gpt-daybreak-blue-latest', status: 'ocx-provided', conditions: ['alias-derived'] }));
  assert.deepEqual(derived.map(finding => finding.reason), ['alias-unevidenced']);
  const renamed = judgeModelPrice(priceRow({ model: 'glm-5.3:cloud', pricedModel: 'glm-5.3', status: 'local-catalog' }));
  assert.deepEqual(renamed.map(finding => finding.reason), ['alias-unevidenced']);
  assert.equal(renamed[0].pricedModel, 'glm-5.3');
});

test('a disagreeing catalog price is its own reason rather than folded into the others', () => {
  const judged = judgeModelPrice(priceRow({ conflict: { status: 'local-catalog',
    rates: { input: 2, output: 2, cacheRead: null, cacheWrite: null },
    reason: '로컬 카탈로그가 다른 단가를 제시합니다. 우선순위가 높은 근거를 사용했습니다.' } }));
  assert.deepEqual(judged.map(finding => finding.reason), ['price-conflict']);
  assert.match(judged[0].detail, /로컬 카탈로그/);
});

test('resolution, recurrence and a lookup that did not run are three different states', () => {
  let clock = NOW;
  const gaps = createPriceGaps({ store: memoryStore(), now: () => clock });
  const open = [priceRow({ model: 'watched', sourceUrl: null })];
  const fixed = [priceRow({ model: 'watched' })];
  const key = priceGapKey('openai', 'watched', 'source-missing');
  // A provider's first reading settles what is already open. Announcing all of it as newly
  // opened would report the installation as freshly broken on its first run.
  gaps.record([['openai', open]], clock);
  let view = publish(gaps, 'openai', open);
  assert.deepEqual(view.changes, []);
  assert.equal(view.models[0].findings[0].state, 'open');
  assert.equal(view.models[0].findings[0].recurred, false);
  assert.equal(view.since, iso(NOW));
  // The source arrives and the finding closes.
  clock = NOW + HOUR;
  gaps.record([['openai', fixed]], clock);
  view = publish(gaps, 'openai', fixed);
  assert.equal(view.models.length, 0);
  assert.deepEqual(view.resolved.map(finding => finding.key), [key]);
  assert.equal(view.resolved[0].resolvedAt, iso(NOW + HOUR));
  assert.ok(view.changes.some(change => change.change === 'resolved' && change.model === 'watched'));
  // A reading that cannot be trusted closes nothing and opens nothing. The catalog reports
  // a failed read and merely old rows with the same stale, so it is not evidence either way.
  clock = NOW + 2 * HOUR;
  gaps.record([['openai', open]], clock, { clean: false });
  view = publish(gaps, 'openai', open, { catalogStatus: 'stale', clean: false });
  assert.equal(view.status, 'lookup-failed');
  assert.equal(view.resolved.length, 0, 'a finding the live quote still shows is not resolved');
  assert.deepEqual(view.changes.map(change => change.change), ['resolved']);
  // A clean reading that sees it again records the recurrence and keeps the first sighting.
  clock = NOW + 3 * HOUR;
  gaps.record([['openai', open]], clock);
  view = publish(gaps, 'openai', open);
  assert.equal(view.status, 'ok');
  const finding = view.models[0].findings.find(entry => entry.key === key);
  assert.equal(finding.recurred, true);
  assert.equal(finding.recurrences, 1);
  assert.equal(finding.firstSeenAt, iso(NOW));
  assert.equal(finding.lastSeenAt, iso(NOW + 3 * HOUR));
  assert.deepEqual(view.changes.map(change => change.change), ['recurred', 'resolved']);
});

test('a priced new model and a cleanly removed one are not shortage warnings', () => {
  const gaps = createPriceGaps({ store: memoryStore(), now: () => NOW });
  const rows = [priceRow({ model: 'fresh' }), priceRow({ model: 'gone' }),
    priceRow({ model: 'unclear', status: 'unpriced', sourceUrl: null, checkedAt: null,
      rates: { input: null, output: null, cacheRead: null, cacheWrite: null }, conditions: [] })];
  const roster = { models: [{ model: 'fresh', state: 'listed' },
    { model: 'gone', state: 'removed', removedAt: iso(NOW - HOUR) }, { model: 'unclear', state: 'listed' }],
    changes: [{ at: iso(NOW - HOUR), model: 'fresh', change: 'added' },
      { at: iso(NOW - HOUR), model: 'unclear', change: 'added' }] };
  gaps.record([['openai', rows]], NOW);
  const view = publish(gaps, 'openai', rows, { catalogStatus: 'ok', clean: true }, roster);
  assert.deepEqual(view.models.map(model => model.model), ['unclear']);
  assert.deepEqual(view.confirmedNewModels.map(model => model.model), ['fresh']);
  assert.deepEqual(view.retiredModels.map(model => model.model), ['gone']);
  // A model added with no confirmed price stays a warning and is not announced as an arrival.
  assert.equal(view.confirmedNewModels.some(model => model.model === 'unclear'), false);
  assert.equal(view.models[0].rosterState, 'listed');
});

test('a hand-edited state costs a baseline rather than an exception', () => {
  const store = memoryStore({ priceGapsV1: JSON.stringify({ providers: {
    openai: { since: 'not an instant', findings: 'not a map' },
    google: { since: NOW, readings: 2, findings: { bad: { model: 5, reason: 'invented' } }, changes: 'no' } } }) });
  const gaps = createPriceGaps({ store, now: () => NOW });
  const rows = [priceRow({ model: 'watched', sourceUrl: null })];
  const openai = publish(gaps, 'openai', rows);
  assert.equal(openai.status, 'collecting');
  assert.equal(openai.modelsNeedingPriceCheck, 1);
  const google = publish(gaps, 'google', rows);
  assert.equal(google.readings, 2);
  assert.deepEqual(google.resolved, []);
  assert.deepEqual(google.changes, []);
});

test('period impact counts calls and tokens on the same boundary the usage periods publish', async t => {
  const f = await fixture(t);
  await f.ingest([
    call('half-hour', NOW - 30 * 60000, 'unknown'),
    call('three-hours', NOW - 3 * HOUR, 'unknown'),
    call('ten-hours', NOW - 10 * HOUR, 'unknown'),
    call('three-days', NOW - 3 * DAY, 'unknown'),
    call('ten-days', NOW - 10 * DAY, 'unknown'),
    // Exactly on the one-hour start, which is outside it, and exactly on the end, inside.
    call('on-the-hour-start', NOW - HOUR, 'unknown'),
    call('on-the-end', NOW, 'unknown'),
  ]);
  const anchor = usageAnchor(f.store, NOW);
  assert.equal(anchor, NOW);
  const periods = impactOf(f.store, 'openai', anchor, new Set(['unknown']));
  // The call exactly on the one-hour start is outside it and the one exactly on the end is
  // inside, so the shortest period holds two of the seven and each longer one nests.
  assert.deepEqual(USAGE_PERIODS.map(([key]) => periods[key].requests), [2, 4, 5, 6, 7]);
  assert.deepEqual(USAGE_PERIODS.map(([key]) => periods[key].tokens), [400, 800, 1000, 1200, 1400]);
  assert.deepEqual(USAGE_PERIODS.map(([key]) => periods[key].unpricedRequests), [2, 4, 5, 6, 7]);
  assert.deepEqual(USAGE_PERIODS.map(([key]) => periods[key].activeModels), [1, 1, 1, 1, 1]);
  for (const [key, ms] of USAGE_PERIODS) {
    assert.equal(periods[key].startedAt, iso(anchor - ms), key);
    assert.equal(periods[key].endedAt, iso(anchor), key);
    assert.equal(periods[key].hours, ms / HOUR, key);
  }
  // The same five boundaries the account periods already publish, not a second definition.
  const account = enrichSnapshot({ schemaVersion: 1, observedAt: iso(NOW), warnings: [], providers: [{ id: 'openai',
    accounts: [{ id: 'a1', label: 'A', status: 'ok', updatedAt: iso(NOW), windows: [] }] }] },
    f.store, identities, pricing, NOW).providers[0].accounts[0].analytics.periods;
  for (const [key] of USAGE_PERIODS) {
    assert.equal(periods[key].startedAt, account[key].startedAt, key);
    assert.equal(periods[key].endedAt, account[key].endedAt, key);
  }
  // A model nothing flagged contributes nothing, so the impact is the flagged set's own.
  const none = impactOf(f.store, 'openai', anchor, new Set());
  assert.deepEqual(USAGE_PERIODS.map(([key]) => none[key].requests), [0, 0, 0, 0, 0]);
});

test('when nothing in a period is priced the total stays unconfirmed rather than zero', async t => {
  const f = await fixture(t);
  await f.ingest([call('one', NOW - 1000, 'unknown'), call('two', NOW - 2000, 'unknown')],
    () => ({ usd: null, basis: 'unknown' }));
  const stats = f.store.stats('openai', 'a1', 0, NOW);
  // Zero would claim the calls cost nothing. There is no amount, and that is the answer.
  assert.equal(stats.apiUsd, null);
  assert.equal(stats.unknownPriceRequests, 2);
  const periods = impactOf(f.store, 'openai', usageAnchor(f.store, NOW), new Set(['unknown']));
  assert.equal(periods.oneHour.requests, 2);
  assert.equal(periods.oneHour.unpricedRequests, 2);
  assert.equal(periods.oneHour.unpricedTokens, 400);
  // The impact reports calls and tokens and no amount at all: what a missing price would
  // have cost is never estimated here.
  assert.deepEqual(Object.keys(periods.oneHour).filter(key => /usd/i.test(key)), []);
});

test('a call with no recorded model name is reported apart instead of dropped', async t => {
  const f = await fixture(t);
  await f.ingest([call('named', NOW - 1000, 'unknown'), call('nameless', NOW - 2000, undefined),
    { requestId: 'sizeless', timestamp: NOW - 3000, provider: 'openai-pabcdef', usageStatus: 'reported' }],
    () => ({ usd: null, basis: 'unknown' }));
  const periods = impactOf(f.store, 'openai', usageAnchor(f.store, NOW), new Set(['unknown']));
  assert.equal(periods.oneHour.requests, 1);
  assert.equal(periods.oneHour.unnamedModelRequests, 2);
  assert.equal(periods.oneHour.unnamedModelUnpricedRequests, 2);
  assert.equal(periods.oneHour.unnamedModelUnpricedTokens, 200);
  // A call whose token total cannot size it is still counted, never silently sized at zero.
  assert.equal(f.store.stats('openai', undefined, 0, NOW).unknownPriceUnsizedRequests, 1);
});

test('per-model period counts add up to the provider totals the usage periods publish', async t => {
  const f = await fixture(t);
  await f.ingest([call('a', NOW - 1000, 'priced'), call('b', NOW - 2 * HOUR, 'unknown'),
    call('c', NOW - 3 * DAY, 'unknown'), call('d', NOW - 10 * DAY, 'priced'),
    call('e', NOW - 4000, undefined), call('f', NOW - 5000, 'other')]);
  const anchor = usageAnchor(f.store, NOW);
  const rows = f.store.modelPeriodUsage('openai', anchor, USAGE_PERIODS);
  for (const [key, ms] of USAGE_PERIODS) {
    const total = f.store.stats('openai', undefined, anchor - ms, anchor);
    const sum = field => rows.reduce((carried, row) => carried + row[key + field], 0);
    assert.equal(sum('Requests'), total.requests, key);
    assert.equal(sum('Tokens'), total.tokens, key);
    assert.equal(sum('UnpricedRequests'), total.unknownPriceRequests, key);
    assert.equal(sum('UnpricedTokens'), total.unknownPriceTokens, key);
    assert.equal(sum('UnsizedRequests'), total.unknownPriceUnsizedRequests, key);
  }
  // A model recorded only in the usage log is in there too: nothing is dropped for being
  // absent from a configuration or a catalog.
  assert.ok(rows.some(row => row.model === 'other'));
  assert.ok(rows.some(row => row.model === null));
  assert.deepEqual(f.store.modelPeriodUsage('openai', anchor, []), []);
  assert.deepEqual(f.store.modelPeriodUsage('openai', anchor, [['drop table x', HOUR]]), []);
});

test('an observed model absent from the catalog keeps its usage and its cache evidence', async t => {
  const f = await fixture(t);
  await f.ingest([call('cached', NOW - 1000, 'observed-only',
    { usage: { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 300 } })],
    () => ({ usd: null, basis: 'unknown' }));
  const [observed] = f.store.observedModels('openai', 0, NOW);
  assert.equal(observed.model, 'observed-only');
  assert.equal(observed.requests, 1);
  assert.equal(observed.unpricedRequests, 1);
  assert.equal(observed.cachedTokens, 300);
  assert.equal(observed.tokens, 600);
  // That recorded cache read is what turns an absent cache-read rate into a real item.
  const judged = judgeModelPrice(priceRow({ model: observed.model, requests: observed.requests,
    cachedTokens: observed.cachedTokens, rates: { input: 1, output: 2, cacheRead: null, cacheWrite: 1.25 } }));
  assert.deepEqual(judged[0].items, [{ item: 'cacheRead', need: 'observed' }]);
});

test('a collector run publishes gaps beside the price rows it judged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-price-gaps-collector-'));
  const catalogPath = join(dir, 'models.json');
  // The catalog read decides whether a gap may be closed, and its freshness is measured
  // against the file on disk, so this run uses the real clock.
  const at = Date.now();
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ providers: {
    openai: { models: ['gpt-6-astra', 'gpt-5.6-terra', 'mystery-model'], defaultModel: 'gpt-5.6-terra' } } }));
  await writeFile(join(dir, 'auth.json'), '{}');
  // A catalog row that states a different input rate for a model with an official price.
  await writeFile(catalogPath, JSON.stringify({ openai: { models: { 'gpt-6-astra': {
    cost: { input: 9, output: 50, cache_read: 1, cache_write: 12.5 } } } } }));
  const usage = (id, model, over = {}) => JSON.stringify({ requestId: id, timestamp: at - 60000,
    provider: 'openai', model, usageStatus: 'reported', usage: { inputTokens: 100, outputTokens: 100 }, ...over });
  await writeFile(join(dir, 'usage.jsonl'), [usage('confirmed', 'gpt-5.6-terra'),
    usage('unknown-one', 'mystery-model'), usage('unknown-two', 'mystery-model'),
    // Recorded but never configured, and absent from the catalog. It must not fall out.
    usage('ghost', 'ghost-model')].join('\n') + '\n');
  const collector = await createCollector({ home: dir, codexHome: dir, dataDir: join(dir, 'state'),
    catalogPath, now: () => at });
  t.after(async () => { await collector.close(); });
  await collector.collect();
  const snapshot = await collector.snapshot();
  const provider = snapshot.providers.find(entry => entry.id === 'openai');
  const gaps = provider.analytics.priceGaps;
  assert.equal(snapshot.analytics.priceGaps.catalogStatus, 'ok');
  assert.equal(snapshot.analytics.priceGaps.resolutionBlocked, false);
  assert.equal(gaps.status, 'ok');
  // Three models need a check and the headline number is the length of that list.
  assert.deepEqual(gaps.models.map(model => model.model).sort(), ['ghost-model', 'gpt-6-astra', 'mystery-model']);
  assert.equal(gaps.modelsNeedingPriceCheck, gaps.models.length);
  const reasonsFor = name => gaps.models.find(model => model.model === name)
    .findings.map(finding => finding.reason).sort();
  assert.deepEqual(reasonsFor('gpt-6-astra'), ['price-conflict']);
  assert.deepEqual(reasonsFor('mystery-model'), ['price-missing']);
  assert.deepEqual(reasonsFor('ghost-model'), ['price-missing']);
  // A model whose official price is complete is not on the list at all.
  assert.equal(gaps.models.some(model => model.model === 'gpt-5.6-terra'), false);
  // The rows judged are the rows published, carrying the id the rate was found under.
  const rows = new Map(provider.analytics.modelPrices.map(row => [row.model, row]));
  assert.equal(rows.get('gpt-6-astra').pricedModel, 'gpt-6-astra');
  assert.ok(rows.get('gpt-6-astra').conflict);
  assert.equal(rows.get('mystery-model').status, 'unpriced');
  assert.equal(rows.get('ghost-model').tokens, 200);
  assert.equal(rows.get('ghost-model').cachedTokens, 0);
  // Three unpriced calls on two flagged models in the last hour; the confirmed model's
  // call is not impact, and the conflicted model was never called.
  assert.equal(gaps.periods.oneHour.activeModels, 2);
  assert.equal(gaps.periods.oneHour.requests, 3);
  assert.equal(gaps.periods.oneHour.unpricedRequests, 3);
  assert.equal(gaps.periods.oneHour.unpricedTokens, 600);
  assert.equal(gaps.periods.oneHour.endedAt, provider.analytics.periods.oneHour.endedAt);
  // The unpriced calls are exactly the provider's own excluded total for the same span.
  assert.equal(gaps.periods.oneHour.unpricedRequests, provider.analytics.periods.oneHour.unknownPriceRequests);
  assert.equal(gaps.periods.oneHour.unpricedTokens, provider.analytics.periods.oneHour.unknownPriceTokens);
});

test('a catalog that could not be read is a blocked lookup rather than a closed gap', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-price-gaps-nocatalog-'));
  const at = Date.now();
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ providers: {
    openai: { models: ['gpt-6-astra', 'mystery-model'], defaultModel: 'gpt-6-astra' } } }));
  await writeFile(join(dir, 'auth.json'), '{}');
  await writeFile(join(dir, 'usage.jsonl'), '');
  const collector = await createCollector({ home: dir, codexHome: dir, dataDir: join(dir, 'state'),
    catalogPath: join(dir, 'absent.json'), now: () => at });
  t.after(async () => { await collector.close(); });
  await collector.collect();
  const snapshot = await collector.snapshot();
  const gaps = snapshot.providers.find(entry => entry.id === 'openai').analytics.priceGaps;
  assert.equal(snapshot.analytics.priceGaps.catalogStatus, 'missing');
  assert.equal(snapshot.analytics.priceGaps.resolutionBlocked, true);
  assert.equal(snapshot.analytics.priceGaps.status, 'lookup-failed');
  // A price source that never answered resolves nothing, and the model with no price is
  // still reported. With no catalog there is also nothing to disagree with, so the model
  // that conflicted under a readable catalog is confirmed here: the two signals are
  // separate and neither stands in for the other.
  assert.deepEqual(gaps.models.map(model => model.model), ['mystery-model']);
  assert.deepEqual(gaps.models[0].findings.map(finding => finding.reason), ['price-missing']);
  assert.deepEqual(gaps.resolved, []);
});

test('a model missing from a reading is not evidence that its price was confirmed', () => {
  let clock = NOW;
  const gaps = createPriceGaps({ store: memoryStore(), now: () => clock });
  const configuredOnly = priceRow({ model: 'configured-only', sourceUrl: null, requests: 0, tokens: 0 });
  const observed = priceRow({ model: 'observed-model', sourceUrl: null });
  gaps.record([['openai', [configuredOnly, observed]]], clock);
  // A configuration that failed to parse projects to an empty list, which is exactly what a
  // model deliberately taken out of the list looks like. Neither says the price was checked.
  clock = NOW + HOUR;
  gaps.record([['openai', [observed]]], clock);
  let view = publish(gaps, 'openai', [observed]);
  assert.deepEqual(view.resolved, [], 'an absent model must not be reported as resolved');
  assert.deepEqual(view.changes, []);
  // The model comes back with its source, and only then does the finding close.
  clock = NOW + 2 * HOUR;
  gaps.record([['openai', [priceRow({ model: 'configured-only', requests: 0, tokens: 0 }), observed]]], clock);
  view = publish(gaps, 'openai', [observed]);
  assert.deepEqual(view.resolved.map(finding => finding.model), ['configured-only']);
  assert.deepEqual(view.changes.map(change => change.change), ['resolved']);
  // Coming back is not a recurrence, because it never closed while it was away.
  assert.equal(view.changes.filter(change => change.change === 'recurred').length, 0);
});

test('a name that became a configured credential is withheld from stored findings too', () => {
  const gaps = createPriceGaps({ store: memoryStore(), now: () => NOW });
  const rows = [priceRow({ model: 'later-a-key', sourceUrl: null }), priceRow({ model: 'ordinary', sourceUrl: null })];
  gaps.record([['openai', rows]], NOW);
  // It closes, so it now lives only in stored state: resolved entries, keys and changes.
  const fixed = [priceRow({ model: 'later-a-key' }), priceRow({ model: 'ordinary' })];
  gaps.record([['openai', fixed]], NOW + HOUR);
  const open = publish(gaps, 'openai', fixed);
  assert.ok(open.resolved.some(finding => finding.model === 'later-a-key'));
  // The configuration now holds that exact value as a credential. Filtering the live rows
  // would not have protected any of the three places it is stored.
  const excluded = new Set(['later-a-key']);
  const guarded = publish(gaps, 'openai', fixed, { catalogStatus: 'ok', clean: true }, null, excluded);
  const body = JSON.stringify(guarded);
  assert.equal(body.includes('later-a-key'), false);
  assert.deepEqual(guarded.models, []);
  assert.deepEqual(guarded.resolved.map(finding => finding.model), ['ordinary']);
  assert.deepEqual(guarded.changes.map(change => change.model), ['ordinary']);
});

test('a provider that left the configuration is forgotten whole once retention passes it', () => {
  let clock = NOW;
  const store = memoryStore();
  const gaps = createPriceGaps({ store, now: () => clock });
  const rows = [priceRow({ model: 'watched', sourceUrl: null })];
  gaps.record([['openai', rows], ['retired-provider', rows]], clock);
  assert.equal(publish(gaps, 'retired-provider', rows).readings, 1);
  // Retention advances past the reading that last saw the departed provider.
  store.set('usageExcludedBefore', NOW + 2 * HOUR);
  clock = NOW + 3 * HOUR;
  gaps.record([['openai', rows]], clock);
  // Forgotten whole rather than resolved: disappearing never stands in for a confirmed price.
  const retired = publish(gaps, 'retired-provider', rows);
  assert.equal(retired.status, 'collecting');
  assert.equal(retired.readings, 0);
  assert.deepEqual(retired.resolved, []);
  // The provider still being read keeps its history, because it was seen after the boundary.
  const live = publish(gaps, 'openai', rows);
  assert.equal(live.readings, 2);
  assert.equal(live.models[0].findings[0].firstSeenAt, iso(NOW));
});

test('every excluded call in a period is attributed, withheld by name, or has no model name', async t => {
  const f = await fixture(t);
  // A model whose current price is fine but whose call could not be valued, one with no
  // price at all, one fully priced, and one call with no model name.
  await f.ingest([call('priced', NOW - 1000, 'priced'), call('conditional', NOW - 2000, 'priced', { usageStatus: 'unreported' }),
    call('nameless', NOW - 3000, undefined, { usageStatus: 'unreported' }),
    call('unpublishable', NOW - 5000, '.opencodex/config.json', { usageStatus: 'unreported' }),
    call('no-price', NOW - 4000, 'unknown'), call('old', NOW - 10 * DAY, 'unknown')],
    row => ({ usd: row.model === 'unknown' || row.usageStatus === 'unreported' ? null : 1, basis: 'official' }));
  const anchor = usageAnchor(f.store, NOW);
  const [priced, unknown] = ['priced', 'unknown'].map(name =>
    f.store.observedModels('openai', 0, NOW).find(row => row.model === name));
  assert.equal(priced.unpricedRequests, 1, 'the priced model really does have an excluded call');
  // The quote for that model is complete, so only the excluded call flags it.
  assert.deepEqual(judgeModelPrice(priceRow({ model: 'priced', requests: priced.requests,
    unpricedRequests: priced.unpricedRequests })).map(finding => finding.reason), ['unpriced-usage']);
  const flagged = new Set(['priced', 'unknown']);
  // Exactly the names that reached the price list. A path-shaped name never does, so it can
  // carry no finding and cannot be named here either.
  const published = new Set(['priced', 'unknown']);
  const periods = impactOf(f.store, 'openai', anchor, flagged, published);
  assert.equal(unknown.requests, 2);
  assert.equal(periods.oneHour.withheldModelUnpricedRequests, 1);
  assert.equal(JSON.stringify(periods).includes('.opencodex'), false);
  for (const [key, ms] of USAGE_PERIODS) {
    const total = f.store.stats('openai', undefined, anchor - ms, anchor);
    // Nothing excluded escapes: it is either attributed to a flagged model or reported as
    // having no model name. A model whose current price looks fine cannot hide its
    // excluded calls by looking confirmed.
    assert.equal(periods[key].unpricedRequests + periods[key].unnamedModelUnpricedRequests +
      periods[key].withheldModelUnpricedRequests, total.unknownPriceRequests, key);
    assert.equal(periods[key].unpricedTokens + periods[key].unnamedModelUnpricedTokens +
      periods[key].withheldModelUnpricedTokens, total.unknownPriceTokens, key);
  }
});

test('a canonical name the configuration holds as a credential is never published', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-price-gaps-secret-'));
  const at = Date.now();
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  // The key is not a whole delimited piece of the tag, so the tag itself is admitted. Its
  // canonical name, which the price is found under, is the key exactly.
  const key = 'gpt-oss:120b';
  await writeFile(join(dir, 'config.json'), JSON.stringify({ providers: {
    'ollama-cloud': { apiKey: key, models: [key + '-cloud', 'glm-5.3'], defaultModel: 'glm-5.3' } } }));
  await writeFile(join(dir, 'auth.json'), '{}');
  await writeFile(join(dir, 'usage.jsonl'), '');
  const collector = await createCollector({ home: dir, codexHome: dir, dataDir: join(dir, 'state'),
    catalogPath: join(dir, 'absent.json'), now: () => at });
  t.after(async () => { await collector.close(); });
  await collector.collect();
  const snapshot = await collector.snapshot();
  // The tag survives; the key it resolves to does not appear as a value anywhere.
  assert.equal(JSON.stringify(snapshot).includes('"' + key + '"'), false);
  const provider = snapshot.providers.find(entry => entry.id === 'ollama-cloud');
  const row = provider.analytics.modelPrices.find(entry => entry.model === key + '-cloud');
  assert.ok(row, 'the admitted tag keeps its place in the price list');
  assert.equal(row.pricedModel, null, 'the canonical name is withheld rather than published');
  assert.equal(provider.analytics.modelPrices.some(entry => entry.pricedModel === key), false);
});

test('a degraded model list neither resolves a finding nor makes its return a recurrence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-price-gaps-degraded-'));
  let clock = Date.now();
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const config = models => JSON.stringify({ providers: { openai: { models, defaultModel: 'gpt-6-astra' } } });
  await writeFile(join(dir, 'config.json'), config(['gpt-6-astra', 'mystery-model']));
  await writeFile(join(dir, 'auth.json'), '{}');
  await writeFile(join(dir, 'usage.jsonl'), '');
  // A readable catalog, so every reading here is a clean one and the state is really
  // recorded. With an unreadable catalog nothing would be written and the assertions below
  // would compare absences rather than a baseline.
  await writeFile(join(dir, 'models.json'), '{}');
  const collector = await createCollector({ home: dir, codexHome: dir, dataDir: join(dir, 'state'),
    catalogPath: join(dir, 'models.json'), now: () => clock });
  t.after(async () => { await collector.close(); });
  const gapsNow = async () => (await collector.snapshot()).providers
    .find(entry => entry.id === 'openai')?.analytics.priceGaps ?? null;
  await collector.collect();
  const first = await gapsNow();
  assert.deepEqual(first.models.map(model => model.model), ['mystery-model']);
  assert.equal(first.models[0].findings[0].reason, 'price-missing');
  assert.equal(first.status, 'ok');
  assert.equal(first.readings, 1, 'the first clean reading is really recorded');
  const openedAt = first.since;
  assert.ok(openedAt, 'a durable baseline exists to compare against');
  // A models field that is not a list projects to an empty list while the file itself still
  // parses, so the configuration reads as ok and the model simply disappears. That absence
  // is not evidence its price was checked.
  await writeFile(join(dir, 'config.json'), config('gpt-6-astra'));
  clock += 6 * 60000;
  await collector.collect();
  const degraded = await gapsNow();
  assert.deepEqual(degraded.models, []);
  assert.deepEqual(degraded.resolved, [], 'a model that vanished with the list is not resolved');
  assert.deepEqual(degraded.changes, []);
  // The list comes back, and the finding is the same one it always was.
  await writeFile(join(dir, 'config.json'), config(['gpt-6-astra', 'mystery-model']));
  clock += 6 * 60000;
  await collector.collect();
  const restored = await gapsNow();
  assert.deepEqual(restored.models.map(model => model.model), ['mystery-model']);
  assert.equal(restored.since, openedAt);
  assert.equal(restored.models[0].findings[0].recurred, false, 'returning is not a recurrence');
  assert.deepEqual(restored.changes, []);
  assert.deepEqual(restored.resolved, []);
});

test('rows committed mid-ingest change the usage revision while the anchor stands still', async t => {
  const f = await fixture(t);
  // More than one batch, so ingestion commits, yields, and continues. The anchor is only set
  // once the whole file is consumed; a reader between batches already sees the committed rows.
  const rows = [];
  for (let i = 0; i < 4000; i++) rows.push(call('row-' + i, NOW - 1000 - i, 'unknown', { note: 'x'.repeat(300) }));
  await writeFile(f.file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const before = f.store.usageRevision();
  assert.equal(f.store.get('usageReadAt'), null);
  const pending = f.store.ingest(f.file, identities, () => ({ usd: null, basis: 'unknown' }), NOW);
  let midRevision = before, midRequests = 0;
  for (let i = 0; i < 50 && midRequests === 0; i++) {
    await new Promise(resolve => setImmediate(resolve));
    midRequests = f.store.stats('openai', undefined, 0, NOW).requests;
    midRevision = f.store.usageRevision();
  }
  // Mid-ingest: rows are visible and the anchor has not moved. Caching on the anchor alone
  // would serve a reader rows its own response can already count.
  assert.ok(midRequests > 0, 'a committed batch is visible before ingestion finishes');
  assert.equal(f.store.get('usageReadAt'), null, 'the anchor has not moved yet');
  assert.notEqual(midRevision, before, 'the revision moved with the rows');
  await pending;
  assert.equal(f.store.get('usageReadAt'), NOW);
  assert.notEqual(f.store.usageRevision(), midRevision, 'the revision moved again as the rest landed');
  assert.equal(f.store.stats('openai', undefined, 0, NOW).requests, 4000);
});

test('a collector response never loses an excluded call between its own figures', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-price-gaps-invariant-'));
  const at = Date.now();
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ providers: {
    openai: { models: ['gpt-6-astra', 'mystery-model'], defaultModel: 'gpt-6-astra' } } }));
  await writeFile(join(dir, 'auth.json'), '{}');
  await writeFile(join(dir, 'models.json'), '{}');
  const usage = (id, model, over = {}) => JSON.stringify({ requestId: id, timestamp: at - 60000,
    provider: 'openai', model, usageStatus: 'reported', usage: { inputTokens: 100, outputTokens: 100 }, ...over });
  await writeFile(join(dir, 'usage.jsonl'), [
    usage('priced', 'gpt-6-astra'),
    // No price for this one.
    usage('unknown', 'mystery-model'),
    // A name whose shape is not a model id, so it never reaches the price list.
    usage('path-shaped', '.opencodex/config.json'),
    // No model name recorded at all.
    usage('nameless', undefined),
    // A known model whose call could not be valued even though its price is complete.
    usage('conditional', 'gpt-6-astra', { usageStatus: 'unreported' })].join('\n') + '\n');
  const collector = await createCollector({ home: dir, codexHome: dir, dataDir: join(dir, 'state'),
    catalogPath: join(dir, 'models.json'), now: () => at });
  t.after(async () => { await collector.close(); });
  await collector.collect();
  const snapshot = await collector.snapshot();
  const provider = snapshot.providers.find(entry => entry.id === 'openai');
  const gaps = provider.analytics.priceGaps;
  const body = JSON.stringify(snapshot);
  assert.equal(body.includes('.opencodex'), false, 'a name that is not a model id is never republished');
  // The model whose price is complete is flagged only because a call of its own was excluded.
  assert.deepEqual(gaps.models.find(model => model.model === 'gpt-6-astra').findings
    .map(finding => finding.reason), ['unpriced-usage']);
  for (const [key] of USAGE_PERIODS) {
    const period = gaps.periods[key], published = provider.analytics.periods[key];
    assert.equal(period.unpricedRequests + period.unnamedModelUnpricedRequests +
      period.withheldModelUnpricedRequests, published.unknownPriceRequests, key);
    assert.equal(period.unpricedTokens + period.unnamedModelUnpricedTokens +
      period.withheldModelUnpricedTokens, published.unknownPriceTokens, key);
  }
  assert.equal(gaps.periods.oneHour.unpricedRequests, 2);
  assert.equal(gaps.periods.oneHour.withheldModelUnpricedRequests, 1);
  assert.equal(gaps.periods.oneHour.unnamedModelUnpricedRequests, 1);
  assert.equal(provider.analytics.periods.oneHour.unknownPriceRequests, 4);
});

test('a replay that lands back on the same cursor offset still moves the usage revision', async t => {
  const f = await fixture(t);
  await f.ingest([call('one', NOW - 1000, 'unknown'), call('two', NOW - 2000, 'unknown')],
    () => ({ usd: null, basis: 'unknown' }));
  const offsetBefore = f.store.get('usageCursor').offset;
  const anchorBefore = usageAnchor(f.store, NOW);
  const revisionBefore = f.store.usageRevision();
  assert.equal(f.store.stats('openai', undefined, 0, NOW).unknownPriceRequests, 2);
  // A pricing revision change replays the same file from the start and fills the amounts it
  // could not settle before. The file has not changed, so the cursor ends exactly where it
  // began, and the read timestamp is the same instant.
  f.store.set('ollamaPricingReplayV1', false);
  await f.store.ingest(f.file, identities, () => ({ usd: 1, basis: 'official' }), NOW);
  assert.equal(f.store.get('usageCursor').offset, offsetBefore, 'the cursor really did land back where it was');
  assert.equal(usageAnchor(f.store, NOW), anchorBefore, 'and the anchor really is the same instant');
  assert.equal(f.store.stats('openai', undefined, 0, NOW).unknownPriceRequests, 0, 'while the rows really did change');
  // Anything keyed on the cursor or the anchor would serve the pre-replay rows here.
  assert.notEqual(f.store.usageRevision(), revisionBefore);
  // Retention deletes rows without touching the cursor at all, and must move it too. Run it
  // past the retention window so the rows really go, rather than only stamping the counter.
  const afterReplay = f.store.usageRevision();
  f.store.maintain(NOW + 91 * DAY);
  assert.equal(f.store.stats('openai', undefined, 0, NOW).requests, 0, 'retention really did delete the rows');
  assert.notEqual(f.store.usageRevision(), afterReplay);
});

// --- JUN-50: per-model period impact, carried findings, confirmation instants ---

// The counterexample an audit used to show the published response could not answer "which
// calls does this model account for in the period I am looking at". Two models, the same
// twenty calls, only their placement in the last hour swapped. Every field that existed
// before comes out identical; the new one has to differ.
test('the per-model impact says which model a period\'s calls belong to', async t => {
  const readWorld = async (alphaRecent, betaRecent) => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-price-gaps-model-periods-'));
    t.after(async () => { await rm(dir, { recursive: true, force: true }); });
    const at = NOW;
    await writeFile(join(dir, 'config.json'), JSON.stringify({ providers: {
      openai: { models: ['alpha-model', 'beta-model'], defaultModel: 'alpha-model' } } }));
    await writeFile(join(dir, 'auth.json'), '{}');
    await writeFile(join(dir, 'models.json'), '{}');
    // Neither model resolves a price, so both are flagged and both reach the projection.
    const rows = [];
    const put = (model, index, ago) => rows.push(JSON.stringify({ requestId: model + '-' + index,
      timestamp: at - ago, provider: 'openai', model, usageStatus: 'reported',
      usage: { inputTokens: 100, outputTokens: 100 } }));
    for (let i = 0; i < 10; i++) put('alpha-model', i, i < alphaRecent ? 60000 + i : 3 * HOUR + i);
    for (let i = 0; i < 10; i++) put('beta-model', i, i < betaRecent ? 60000 + i : 3 * HOUR + i);
    await writeFile(join(dir, 'usage.jsonl'), rows.join('\n') + '\n');
    const collector = await createCollector({ home: dir, codexHome: dir, dataDir: join(dir, 'state'),
      catalogPath: join(dir, 'models.json'), now: () => at });
    t.after(async () => { await collector.close(); });
    await collector.collect();
    const snapshot = await collector.snapshot();
    const gaps = snapshot.providers.find(provider => provider.id === 'openai').analytics.priceGaps;
    return { gaps,
      perModel: Object.fromEntries(gaps.models.map(model => [model.model, model.periods.oneHour.requests])),
      // Everything the response already carried, for the comparison below.
      retained: Object.fromEntries(gaps.models.map(model => [model.model, model.requests])),
      aggregate: gaps.periods.oneHour.requests };
  };
  const original = await readWorld(9, 1);
  const swapped = await readWorld(1, 9);
  assert.deepEqual(original.perModel, { 'alpha-model': 9, 'beta-model': 1 });
  assert.deepEqual(swapped.perModel, { 'alpha-model': 1, 'beta-model': 9 });
  assert.notDeepEqual(original.perModel, swapped.perModel, 'swapping the two models has to change the response');
  // Why the field had to be added: neither existing figure moves at all.
  assert.deepEqual(original.retained, swapped.retained, 'the retention-wide counts cannot tell the two worlds apart');
  assert.equal(original.aggregate, swapped.aggregate, 'and neither can the provider-wide period total');
  // The parts still add up to the whole they are a breakdown of.
  for (const [key] of USAGE_PERIODS) {
    const summed = original.gaps.models.reduce((total, model) => total + model.periods[key].requests, 0);
    assert.equal(summed, original.gaps.periods[key].requests, key);
  }
  // No amount is invented for a call nobody could price.
  assert.equal(Object.hasOwn(original.gaps.models[0].periods.oneHour, 'apiUsd'), false);
});

// A catalog that stops answering makes the same row judge clean. The finding is not raised
// again, and nothing about that says the price was confirmed.
test('a blocked reading carries a finding whose model is still listed', () => {
  const store = memoryStore();
  const gaps = createPriceGaps({ store, now: () => NOW });
  const conflicted = priceRow({ model: 'watched', conflict: { reason: 'two sources disagree' } });
  const settled = priceRow({ model: 'watched' });
  gaps.record([['openai', [conflicted]]], NOW, { clean: true, listed: ['openai'] });
  const open = publish(gaps, 'openai', [conflicted]);
  assert.deepEqual(open.models[0].findings.map(finding => finding.reason), ['price-conflict']);
  assert.deepEqual(open.models[0].carriedFindings, [], 'a finding this reading raised is not carried');
  assert.deepEqual(open.carriedModels, []);
  gaps.record([['openai', [settled]]], NOW + HOUR, { clean: false });
  const blocked = publish(gaps, 'openai', [settled], { catalogStatus: 'stale', clean: false });
  assert.deepEqual(blocked.models, [], 'the live row really does judge clean now');
  assert.deepEqual(blocked.carriedModels.map(model => model.model), ['watched'],
    'and the model does not vanish because of it');
  assert.deepEqual(blocked.carriedModels[0].findings.map(finding => finding.reason), ['price-conflict']);
  assert.equal(blocked.carriedModels[0].findings[0].firstSeenAt, iso(NOW));
  assert.deepEqual(blocked.resolved, [], 'a lookup that could not run resolves nothing');
  // The same row on a cycle that could be trusted is a real resolution, and then nothing is carried.
  gaps.record([['openai', [settled]]], NOW + 2 * HOUR, { clean: true, listed: ['openai'] });
  const fixed = publish(gaps, 'openai', [settled]);
  assert.deepEqual(fixed.models, []);
  assert.deepEqual(fixed.carriedModels, []);
  assert.deepEqual(fixed.resolved.map(finding => finding.model), ['watched']);
});

// The catalog is re-read every collection while the gap state is recorded every five
// minutes. A source that breaks just after a recording leaves the stored failure instant
// empty, so reading only that would blank the list until the next recording cycle.
test('a lookup that broke since the last recording carries its findings immediately', () => {
  const store = memoryStore();
  const gaps = createPriceGaps({ store, now: () => NOW });
  const conflicted = priceRow({ model: 'watched', conflict: { reason: 'two sources disagree' } });
  const settled = priceRow({ model: 'watched' });
  gaps.record([['openai', [conflicted]]], NOW, { clean: true, listed: ['openai'] });
  // Nothing has been recorded since. The only thing that has changed is that this request's
  // own lookup says it could not be trusted.
  const between = publish(gaps, 'openai', [settled], { catalogStatus: 'stale', clean: false });
  assert.deepEqual(between.carriedModels.map(model => model.model), ['watched'],
    'a finding is carried from the moment its lookup breaks, not from the next recording');
  assert.deepEqual(between.carriedModels[0].findings.map(finding => finding.reason), ['price-conflict']);
  assert.deepEqual(between.resolved, []);
  // The same stored state with a trustworthy lookup is a live reading that found nothing.
  const trusted = publish(gaps, 'openai', [settled]);
  assert.deepEqual(trusted.carriedModels, [],
    'a lookup that did run is allowed to say the live row is clean');
});

// The provider-by-provider trust the confirmation depends on is computed in the collector,
// so a test that injects it by hand cannot protect that wiring.
test('the collector confirms only a provider whose own model list parsed', async t => {
  const confirmedNames = async models => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-price-gaps-listed-'));
    t.after(async () => { await rm(dir, { recursive: true, force: true }); });
    // Wall clock rather than the fixed instant: the catalog calls itself stale once it is
    // older than its window, and a stale catalog is not a cycle that confirms anything.
    const at = Date.now();
    await writeFile(join(dir, 'config.json'), JSON.stringify({ providers: {
      openai: { models, defaultModel: 'gpt-6-astra' } } }));
    await writeFile(join(dir, 'auth.json'), '{}');
    await writeFile(join(dir, 'models.json'), '{}');
    await writeFile(join(dir, 'usage.jsonl'), JSON.stringify({ requestId: 'priced',
      timestamp: at - 60000, provider: 'openai', model: 'gpt-6-astra', usageStatus: 'reported',
      usage: { inputTokens: 100, outputTokens: 100 } }) + '\n');
    const collector = await createCollector({ home: dir, codexHome: dir, dataDir: join(dir, 'state'),
      catalogPath: join(dir, 'models.json'), now: () => at });
    await collector.collect();
    await collector.close();
    // Read the durable record back rather than the response: a model with nothing wrong has
    // no published row to carry the instant on.
    const store = await openHistory(join(dir, 'state'));
    const stored = store.get('priceGapsV1');
    store.close();
    return Object.keys(stored?.providers?.openai?.confirmed ?? {});
  };
  assert.deepEqual(await confirmedNames(['gpt-6-astra']), ['gpt-6-astra']);
  assert.deepEqual(await confirmedNames('gpt-6-astra'), [],
    'a model list that did not parse confirms nothing, however clean the rest of the cycle was');
});

// The two lists are split by whether this reading published the model, so a model carrying
// one stale finding and one live one is still exactly one model.
test('a carried finding lands beside its model rather than duplicating it', () => {
  const store = memoryStore();
  const gaps = createPriceGaps({ store, now: () => NOW });
  const both = priceRow({ model: 'twofold', sourceUrl: null, conflict: { reason: 'two sources disagree' } });
  const onlySource = priceRow({ model: 'twofold', sourceUrl: null });
  gaps.record([['openai', [both]]], NOW, { clean: true, listed: ['openai'] });
  gaps.record([['openai', [onlySource]]], NOW + HOUR, { clean: false });
  const view = publish(gaps, 'openai', [onlySource], { catalogStatus: 'stale', clean: false });
  assert.deepEqual(view.models.map(model => model.model), ['twofold']);
  assert.equal(view.modelsNeedingPriceCheck, 1);
  assert.deepEqual(view.carriedModels, [], 'a model this reading published is never listed twice');
  assert.deepEqual(view.models[0].findings.map(finding => finding.reason), ['source-missing']);
  assert.deepEqual(view.models[0].carriedFindings.map(finding => finding.reason), ['price-conflict']);
});

// Two separate failures. One provider's unreadable model list does not make the whole cycle
// dirty, so a cycle-wide flag would stamp a confirmation the read never earned.
test('a confirmation instant needs a trustworthy cycle and a provider list that parsed', () => {
  const settled = priceRow({ model: 'settled' });
  const broken = priceRow({ model: 'settled', sourceUrl: null });
  const trusted = createPriceGaps({ store: memoryStore(), now: () => NOW });
  trusted.record([['openai', [settled]]], NOW, { clean: true, listed: ['openai'] });
  trusted.record([['openai', [broken]]], NOW + HOUR, { clean: true, listed: ['openai'] });
  const kept = publish(trusted, 'openai', [broken]);
  assert.deepEqual(kept.models[0].findings.map(finding => finding.reason), ['source-missing']);
  assert.equal(kept.models[0].lastConfirmedAt, iso(NOW),
    'the last reading that found nothing wrong with this model is kept');
  const untrusted = createPriceGaps({ store: memoryStore(), now: () => NOW });
  untrusted.record([['openai', [settled]]], NOW, { clean: true, listed: [] });
  untrusted.record([['openai', [broken]]], NOW + HOUR, { clean: true, listed: ['openai'] });
  assert.equal(publish(untrusted, 'openai', [broken]).models[0].lastConfirmedAt, null,
    'a provider whose model list did not parse records no confirmation');
  // It is a per-model fact, not the provider-wide lookup instant beside it.
  const other = createPriceGaps({ store: memoryStore(), now: () => NOW });
  other.record([['openai', [broken, priceRow({ model: 'elsewhere' })]]], NOW, { clean: true, listed: ['openai'] });
  assert.equal(publish(other, 'openai', [broken]).models[0].lastConfirmedAt, null,
    'another model being confirmed says nothing about this one');
});

// A provider the response has no object for cannot publish its own gaps. Saying nothing at
// all would read exactly like the gaps having been closed.
test('a provider missing from the response is named rather than silently dropped', () => {
  const store = memoryStore();
  const gaps = createPriceGaps({ store, now: () => NOW });
  gaps.record([['openai', [priceRow({ model: 'unclear', sourceUrl: null })]]], NOW,
    { clean: true, listed: ['openai'] });
  const present = snapshotOf([{ id: 'openai' }]);
  gaps.enrich(present, { rows: new Map([['openai', [priceRow({ model: 'unclear', sourceUrl: null })]]]) });
  assert.deepEqual(present.analytics.priceGaps.unreportedProviders, []);
  // The configuration stops parsing, so the provider is not in the snapshot at all.
  const absent = snapshotOf([]);
  gaps.enrich(absent, { rows: new Map() });
  assert.deepEqual(absent.analytics.priceGaps.unreportedProviders, ['openai']);
});

// --- JUN-50: the per-model projection's own boundaries ---
// These call the helper directly on purpose. describe() filters unpublishable names before it
// ever builds flagged, so a test driven through the collector reaches none of the helper's own
// guards: an audit removed each of them and all 32 tests still passed. The collector's name
// leak stays the job of the credential test above; this is the helper's own contract.
const periodRow = (model, over = {}) => {
  const row = { model };
  for (const [key] of USAGE_PERIODS) {
    row[key + 'Requests'] = 0; row[key + 'Tokens'] = 0; row[key + 'UnpricedRequests'] = 0;
    row[key + 'UnpricedTokens'] = 0; row[key + 'UnsizedRequests'] = 0;
  }
  return { ...row, ...over };
};
// The five recorded figures without the three that describe the window, so one comparison can
// hold every number at once.
const figures = bucket => ({ requests: bucket.requests, tokens: bucket.tokens,
  unpricedRequests: bucket.unpricedRequests, unpricedTokens: bucket.unpricedTokens,
  unpricedUnsizedRequests: bucket.unpricedUnsizedRequests });

test('the per-model projection withholds a name the caller may not publish', () => {
  const rows = [periodRow('ordinary', { oneHourRequests: 3 }),
    periodRow('later-a-key', { oneHourRequests: 5 })];
  const flagged = new Set(['ordinary', 'later-a-key']);
  assert.deepEqual(Object.keys(modelPeriodImpact(rows, NOW, flagged, null)).sort(),
    ['later-a-key', 'ordinary'], 'with nothing to withhold both names are projected');
  // Model names are the keys of this map, so a name that may not be published cannot be a key
  // and cannot ride along in the serialized response either.
  const guarded = modelPeriodImpact(rows, NOW, flagged, new Set(['ordinary']));
  assert.deepEqual(Object.keys(guarded), ['ordinary']);
  assert.equal(JSON.stringify(guarded).includes('later-a-key'), false);
});

test('a flagged model with no usage row is projected as five recorded zeroes, not as nothing', () => {
  const projected = modelPeriodImpact([], NOW, new Set(['quiet']), null);
  // Absent and zero are different sentences on the screen: one says the record is missing, the
  // other says the record is empty. The query walks the longest period in full, so it is zero.
  assert.notEqual(projected.quiet, undefined);
  assert.deepEqual(Object.keys(projected.quiet), USAGE_PERIODS.map(([key]) => key));
  for (const [key, ms] of USAGE_PERIODS) {
    assert.deepEqual(figures(projected.quiet[key]), { requests: 0, tokens: 0, unpricedRequests: 0,
      unpricedTokens: 0, unpricedUnsizedRequests: 0 }, key);
    // The same anchor and the same half-open window the aggregate beside it publishes.
    assert.equal(projected.quiet[key].startedAt, iso(NOW - ms), key);
    assert.equal(projected.quiet[key].endedAt, iso(NOW), key);
    assert.equal(projected.quiet[key].hours, ms / HOUR, key);
  }
});

test('every recorded figure reaches the projection, not only the call count', () => {
  const rows = [periodRow('busy', { oneHourRequests: 7, oneHourTokens: 1400,
    oneHourUnpricedRequests: 3, oneHourUnpricedTokens: 600, oneHourUnsizedRequests: 2,
    weeklyRequests: 21, weeklyTokens: 4200, weeklyUnpricedRequests: 9,
    weeklyUnpricedTokens: 1800, weeklyUnsizedRequests: 4 })];
  const periods = modelPeriodImpact(rows, NOW, new Set(['busy']), null).busy;
  // The screen reads all five. Checking the call count alone lets the other four silently
  // become zero, which an audit demonstrated by doing exactly that.
  assert.deepEqual(figures(periods.oneHour), { requests: 7, tokens: 1400, unpricedRequests: 3,
    unpricedTokens: 600, unpricedUnsizedRequests: 2 });
  assert.deepEqual(figures(periods.weekly), { requests: 21, tokens: 4200, unpricedRequests: 9,
    unpricedTokens: 1800, unpricedUnsizedRequests: 4 });
});

test('a call with no model name never lands in a model\'s own bucket', () => {
  // The nameless row comes second on purpose: a projection that does not skip it would key it
  // under "null" and overwrite the real model of that name, which is the collision to catch.
  const rows = [periodRow('null', { oneHourRequests: 6 }), periodRow(null, { oneHourRequests: 4 })];
  const projected = modelPeriodImpact(rows, NOW, new Set(['null']), null);
  assert.deepEqual(Object.keys(projected), ['null']);
  assert.equal(projected.null.oneHour.requests, 6,
    'a model actually called "null" keeps its own calls');
});
