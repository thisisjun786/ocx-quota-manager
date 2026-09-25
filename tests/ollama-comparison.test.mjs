import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareOllamaUsage, evaluateOllamaScenario } from '../src/ollama-comparison.mjs';
import { comparisonHtml } from '../src/ollama-comparison-report.mjs';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const to = Date.parse('2026-09-10T11:00:00Z'), from = to - 86400000;
const row = (requestId, provider, usage, extra = {}) => ({ requestId, timestamp: to - 1000,
  provider, model: 'glm-5.3-flash', usageStatus: 'reported', usage, ...extra });
async function compare(t, rows, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quota-credit-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'usage.jsonl'); await writeFile(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  return compareOllamaUsage(file, { from, to, ...options });
}
test('missing reference cache stays unknown, explicit zero stays measured, and invalid rates reject', async t => {
  const usage = { inputTokens: 1000000, outputTokens: 1000000 };
  const data = await compare(t, [row('a', 'ollama-cloud', usage)]);
  assert.equal(data.cache.appliedRate, null); assert.equal(data.totals.noCacheUsd, .65); assert.equal(data.totals.estimatedUsd, null);
  const zero = await compare(t, [row('a', 'ollama-cloud', { ...usage, cachedInputTokens: 0 })]);
  assert.equal(zero.totals.estimatedUsd, .65); assert.equal(zero.totals.measuredCacheRequests, 1);
  const empty = await compare(t, []); assert.equal(empty.totals.estimatedUsd, null);
  await assert.rejects(compare(t, [], { cacheRate: 1.01 }), /Cache rate/);
  await assert.rejects(compare(t, [], { from: to }), /interval/);
});
test('reference rate is token weighted, excludes absent and estimated cache, and discounts only missing Ollama cache', async t => {
  const data = await compare(t, [
    row('ref1', 'openai-pabcdef', { inputTokens: 900, outputTokens: 1, cachedInputTokens: 810 }),
    row('ref2', 'anthropic', { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 10 }),
    row('missing', 'xai', { inputTokens: 100000, outputTokens: 1 }),
    row('estimated', 'cursor', { inputTokens: 100000, outputTokens: 1, cachedInputTokens: 1 }, { usageStatus: 'estimated' }),
    row('bad', 'openai', { inputTokens: 100, outputTokens: 1, cachedInputTokens: 101 }),
    row('a', 'ollama-cloud', { inputTokens: 1000000, outputTokens: 1000000 }),
    row('b', 'ollama-cloud', { inputTokens: 1000000, outputTokens: 0, cachedInputTokens: 500000 }),
  ]);
  assert.equal(data.cache.observedRate, .82); assert.equal(data.cache.providers.length, 2);
  assert.equal(data.totals.noCacheUsd, .8);
  assert.ok(Math.abs(data.totals.estimatedUsd - .6416) < 1e-12);
  assert.ok(Math.abs(evaluateOllamaScenario(data.totals, 0).estimatedUsd - .74) < 1e-12);
  assert.ok(Math.abs(evaluateOllamaScenario(data.totals, 1).estimatedUsd - .62) < 1e-12);
});
test('manual cache overrides reference, peak prices follow request time, and unpublished cache keeps input price', async t => {
  const data = await compare(t, [
    row('ref', 'openai', { inputTokens: 100, outputTokens: 0, cachedInputTokens: 90 }),
    row('peak', 'ollama-cloud', { inputTokens: 1000000, outputTokens: 1000000 }, { timestamp: Date.parse('2026-09-09T13:00:00Z'), model: 'deepseek-v4-flash:0731' }),
    row('no-cache-price', 'ollama-cloud', { inputTokens: 1000000, outputTokens: 0 }, { model: 'mistral-large-3' }),
  ], { cacheRate: .5 });
  assert.equal(data.cache.appliedRate, .5); assert.equal(data.cache.observedRate, .9);
  assert.equal(data.totals.peakRequests, 1); assert.equal(data.totals.noCacheRateRequests, 1);
  assert.ok(Math.abs(data.totals.noCacheUsd - 2.26) < 1e-12);
  assert.ok(Math.abs(data.totals.estimatedUsd - 2.047) < 1e-12);
});
test('attempts replace parent costs, duplicate attempts dedupe, and unsupported usage is visibly partial', async t => {
  const a = row('parent', 'ollama-cloud', { inputTokens: 9999999, outputTokens: 9999999 }, { attempts: [
    row('a', 'ollama-cloud', { inputTokens: 1000000, outputTokens: 0 }),
    row('b', 'ollama-cloud', { inputTokens: 1000000, outputTokens: 0 }, { model: 'unknown' }),
    row('c', 'ollama-cloud', {}, { usageStatus: 'unreported' }),
    row('d', 'ollama-cloud', {}, { locallyAnswered: true }),
  ] });
  const data = await compare(t, [a, a, '{broken', row('old', 'ollama-cloud', {}, { timestamp: from }), row('future', 'ollama-cloud', {}, { timestamp: to + 1 })], { cacheRate: 0 });
  assert.equal(data.totals.requests, 3); assert.equal(data.totals.pricedRequests, 1); assert.equal(data.totals.unpricedRequests, 2);
  assert.equal(data.duplicates, 3); assert.equal(data.invalidLines, 1); assert.equal(data.partial, true); assert.equal(data.totals.estimatedUsd, .15);
  assert.equal(data.models.find(m => m.model === 'unknown').noCacheUsd, null);
});
test('standalone report escapes log model text and keeps data local', async t => {
  const data = await compare(t, [row('x', 'ollama-cloud', {}, { model: '</script><img src=x>' })]);
  const html = comparisonHtml(data, evaluateOllamaScenario);
  assert.equal(html.includes('</script><img'), false);
  assert.ok(html.includes('&lt;/script&gt;&lt;img src=x&gt;'));
  assert.equal(html.includes('fetch('), false);
});

test('CLI writes a runnable standalone report and refuses to overwrite the source', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-credit-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'usage.jsonl'), html = join(dir, 'report.html');
  const input = JSON.stringify(row('cli', 'ollama-cloud', { inputTokens: 1000, outputTokens: 100 })) + '\n';
  await writeFile(log, input);
  const run = output => spawnSync(process.execPath, ['src/ollama-comparison.mjs', '--log', log, '--from', new Date(from).toISOString(), '--to', new Date(to).toISOString(), '--cache-rate', '0.5', '--html', output], { encoding: 'utf8' });
  const ok = run(html); assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).totals.pricedRequests, 1);
  assert.match(await readFile(html, 'utf8'), /<!doctype html>/);
  const collision = run(log); assert.notEqual(collision.status, 0); assert.match(collision.stderr, /must not overwrite/);
  assert.equal(await readFile(log, 'utf8'), input);
});
