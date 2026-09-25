import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ollamaModelPricing, OLLAMA_CREDIT_PLANS } from './pricing.mjs';

const DAY = 86400000;
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const providerName = value => typeof value === 'string' ? value.replace(/-(?:main|[pko][a-f0-9]{6})$/, '') : 'unknown';
const bucket = model => ({ model, requests: 0, pricedRequests: 0, unpricedRequests: 0, inputTokens: 0,
  outputTokens: 0, measuredCacheRequests: 0, missingCacheRequests: 0, noCacheRateRequests: 0,
  peakRequests: 0, noCacheUsd: 0, measuredDiscountUsd: 0, assumedDiscountAtFullCacheUsd: 0 });

// The coefficients preserve each request's model and peak tariff. Changing the
// assumed cache share never rewrites tokens, measured cache, or stored usage USD.
export function evaluateOllamaScenario(totals, cacheRate) {
  if (cacheRate !== null && (!valid(cacheRate) || cacheRate > 1)) throw new Error('Cache rate must be between 0 and 1');
  if (!totals.pricedRequests) return { noCacheUsd: null, estimatedUsd: null, cacheDiscountUsd: null };
  const needsAssumption = totals.assumedDiscountAtFullCacheUsd > 0;
  const estimatedUsd = cacheRate === null && needsAssumption ? null : Math.max(0,
    totals.noCacheUsd - totals.measuredDiscountUsd - (cacheRate ?? 0) * totals.assumedDiscountAtFullCacheUsd);
  return { noCacheUsd: totals.noCacheUsd, estimatedUsd,
    cacheDiscountUsd: estimatedUsd === null ? null : totals.noCacheUsd - estimatedUsd };
}

export async function compareOllamaUsage(file, { from = Date.now() - 30 * DAY, to = Date.now(), cacheRate = null } = {}) {
  if (!valid(from) || !valid(to) || from >= to || to >= 8.64e15) throw new Error('Invalid comparison interval');
  if (cacheRate !== null && (!valid(cacheRate) || cacheRate > 1)) throw new Error('Cache rate must be between 0 and 1');
  const info = await stat(file), seen = new Set(), sources = new Map(), models = new Map();
  let invalidLines = 0, duplicates = 0, firstAt = null, lastAt = null;
  const add = (map, key) => { if (!map.has(key)) map.set(key, bucket(key)); return map.get(key); };
  const stream = createReadStream(file, { end: Math.max(0, info.size - 1), encoding: 'utf8' });
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { invalidLines++; continue; }
    if (!entry || !valid(entry.timestamp) || typeof entry.requestId !== 'string') { invalidLines++; continue; }
    if (entry.timestamp <= from || entry.timestamp > to) continue;
    const attempts = Array.isArray(entry.attempts) && entry.attempts.length ? entry.attempts : [entry];
    for (const [index, row] of attempts.entries()) {
      if (!row || row.locallyAnswered) continue;
      const id = `${entry.requestId}\0${index}`;
      if (seen.has(id)) { duplicates++; continue; }
      seen.add(id);
      const provider = providerName(row.provider), u = row.usage ?? {};
      const reported = row.usageStatus === 'reported' && u.estimated !== true && valid(u.inputTokens) && valid(u.outputTokens);
      const read = u.cacheReadInputTokens ?? u.cachedInputTokens;
      const write = u.cacheCreationInputTokens ?? 0;
      const cacheValid = valid(read) && valid(write) && read + write <= u.inputTokens;
      if (provider !== 'ollama-cloud') {
        // Missing cache and estimated tokens are not measured cache misses.
        if (provider === 'unknown' || provider === 'cursor' || !reported || !cacheValid || u.inputTokens <= 0) continue;
        const s = sources.get(provider) ?? { provider, requests: 0, inputTokens: 0, cachedInputTokens: 0 };
        s.requests++; s.inputTokens += u.inputTokens; s.cachedInputTokens += read; sources.set(provider, s);
        continue;
      }
      firstAt = Math.min(firstAt ?? entry.timestamp, entry.timestamp); lastAt = Math.max(lastAt ?? entry.timestamp, entry.timestamp);
      const m = add(models, typeof row.model === 'string' ? row.model : 'unknown');
      m.requests++;
      const prices = ollamaModelPricing(row.model, entry.timestamp);
      const hasCache = u.cacheReadInputTokens !== undefined || u.cachedInputTokens !== undefined;
      if (!reported || !prices || (hasCache && !cacheValid) || !valid(write) || write > 0) { m.unpricedRequests++; continue; }
      m.pricedRequests++; m.inputTokens += u.inputTokens; m.outputTokens += u.outputTokens;
      m.peakRequests += Number(prices.peak);
      m.noCacheUsd += (u.inputTokens * prices.inputUsdPerMillion + u.outputTokens * prices.outputUsdPerMillion) / 1e6;
      if (prices.cachedInputUsdPerMillion === null) { m.noCacheRateRequests++; continue; }
      const discount = (prices.inputUsdPerMillion - prices.cachedInputUsdPerMillion) / 1e6;
      if (hasCache) { m.measuredCacheRequests++; m.measuredDiscountUsd += read * discount; }
      else { m.missingCacheRequests++; m.assumedDiscountAtFullCacheUsd += u.inputTokens * discount; }
    }
  }
  const reference = [...sources.values()].sort((a, b) => b.inputTokens - a.inputTokens);
  const input = reference.reduce((n, s) => n + s.inputTokens, 0), cached = reference.reduce((n, s) => n + s.cachedInputTokens, 0);
  const observedRate = input > 0 ? cached / input : null, appliedRate = cacheRate ?? observedRate;
  const totals = bucket('all');
  for (const m of models.values()) for (const key of Object.keys(totals)) if (key !== 'model') totals[key] += m[key];
  const values = evaluateOllamaScenario(totals, appliedRate);
  return { schemaVersion: 1, from: new Date(from).toISOString(), through: new Date(to).toISOString(),
    usageSince: firstAt === null ? null : new Date(firstAt).toISOString(), usageThrough: lastAt === null ? null : new Date(lastAt).toISOString(),
    basis: 'counterfactual-current-prices', partial: totals.unpricedRequests > 0 || invalidLines > 0,
    invalidLines, duplicates, cache: { basis: cacheRate === null ? 'other-providers-token-weighted' : 'manual',
      appliedRate, observedRate, referenceInputTokens: input, referenceCachedInputTokens: cached, providers: reference },
    totals: { ...totals, ...values }, models: [...models.values()].map(m => ({ ...m, ...evaluateOllamaScenario(m, appliedRate) })),
    plans: Object.entries(OLLAMA_CREDIT_PLANS).map(([id, plan]) => ({ id, ...plan })),
    notes: ['Ollama 입력·출력은 보고된 토큰만 사용합니다. 캐시가 없을 때만 다른 프로바이더의 토큰 가중 평균을 가정합니다.',
      '공식 캐시 단가가 없는 모델은 입력 정가를 적용합니다. 실측 캐시 값은 가정으로 덮어쓰지 않습니다.',
      '같은 기록을 현재 신 크레딧 요금제로 환산한 비교입니다. 구버전 GPU 사용률·실제 청구액·월 잔액을 뜻하지 않습니다.',
      '최근 구간 합계이며 실제 결제 주기나 미래 한 달 사용량이 아닙니다. 누락된 토큰과 알 수 없는 모델은 제외합니다.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!['--log', '--days', '--from', '--to', '--cache-rate', '--json', '--html'].includes(args[i]) || !args[i + 1]) throw new Error('Use --log PATH --days 30 --cache-rate 0.8 --json PATH --html PATH');
      options.set(args[i], args[i + 1]);
    }
    const to = options.has('--to') ? Date.parse(options.get('--to')) : Date.now();
    const from = options.has('--from') ? Date.parse(options.get('--from')) : to - Number(options.get('--days') ?? 30) * DAY;
    const file = options.get('--log') ?? join(process.env.OPENCODEX_HOME ?? join(homedir(), '.opencodex'), 'usage.jsonl');
    const inputInfo = await stat(file), outputs = ['--json', '--html'].filter(key => options.has(key)).map(key => options.get(key));
    const outputInfos = [];
    for (const output of outputs) {
      const info = await stat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (resolve(output) === resolve(file) || (info && info.ino === inputInfo.ino && info.dev === inputInfo.dev)) throw new Error('Output must not overwrite the usage log');
      if (outputInfos.some(prior => resolve(prior.path) === resolve(output) || (info && prior.info?.ino === info.ino && prior.info?.dev === info.dev))) throw new Error('JSON and HTML outputs must be different files');
      outputInfos.push({ path: output, info });
    }
    const data = await compareOllamaUsage(file,
      { from, to, cacheRate: options.has('--cache-rate') ? Number(options.get('--cache-rate')) : null });
    if (options.has('--json')) await writeFile(options.get('--json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    if (options.has('--html')) {
      const { comparisonHtml } = await import('./ollama-comparison-report.mjs');
      await writeFile(options.get('--html'), comparisonHtml(data, evaluateOllamaScenario), { mode: 0o600 });
    }
    console.log(JSON.stringify(data, null, 2));
  } catch (error) { console.error(`Ollama comparison: ${error.code ?? error.message}`); process.exitCode = 1; }
}
