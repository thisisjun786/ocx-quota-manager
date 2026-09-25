import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { priceUsage, lookupModelPrice, listModelPriceConditions } from './pricing.mjs';
import { priceCursorCache } from './cursor-cache.mjs';
const MAX_BYTES = 25 * 1024 * 1024;
const STALE_MS = 7 * 86400000;
// Same string as CLAUDE in pricing.mjs; kept local so the sidecar keys off the
// priced row's provenance rather than a model-name guess.
const CLAUDE_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const rate = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e6;
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const normalizedProvider = provider => typeof provider === 'string' ? provider.replace(/-(?:main|[pko][a-f0-9]{6})$/,'') : '';

// Anthropic bills cache writes by storage TTL. The base valuation keeps the
// 5-minute assumption; this sidecar adds the 1-hour amount alongside it so a
// reader can compare without replaying the row. Only a priced Anthropic row
// with real cache-write tokens qualifies; Cursor forwards and unpriced rows
// get the untouched base result.
function claudeCache(row, price, lookup) {
 const base = price(row), u = row?.usage;
 if (normalizedProvider(row?.provider) !== 'anthropic' || !u || !valid(base.usd) ||
     base.sourceUrl !== CLAUDE_SOURCE) return base;
 const write = u.cacheCreationInputTokens ?? 0;
 if (!valid(write) || write <= 0 || !valid(u.inputTokens) || write > u.inputTokens) return base;
 const full = priceUsage(row, { catalog: lookup, claudeCacheTtl: '1h' });
 if (!valid(full.usd)) return base;
 return { ...base, claudeCache: { fiveMinuteUsd: base.usd, oneHourUsd: full.usd, cacheWriteTokens: write } };
}
const tuple = c => object(c) && !Object.keys(c).some(k=>!['input','output','cache_read','cache_write','tiers','context_over_200k','tier'].includes(k)) && rate(c.input) && rate(c.output) &&
 ['cache_read','cache_write'].every(k => c[k] == null || rate(c[k])) && c.input + c.output > 0
 ? [c.input,c.output,c.cache_read ?? null,c.cache_write ?? null] : null;
const hash = data => createHash('sha256').update(data).digest('hex');

function catalogRows(data) {
 if (!object(data)) throw new Error('Invalid catalog');
 const rows = new Map();
 for (const [provider,p] of Object.entries(data)) {
  // Rows are keyed by provider and model joined with a separator. An id carrying that
  // separator could be read back under a provider that has no such row, so it is refused.
  if (!object(p?.models) || provider.includes('\0')) continue;
  for (const [id,m] of Object.entries(p.models)) {
   if (!object(m) || id.includes('\0') || (m.id != null && m.id !== id)) continue;
   const base = tuple(m.cost); if (!base) continue;
   let tiers = m.cost.tiers;
   // models.dev exposes both forms; explicit thresholds take precedence.
   if (tiers == null && m.cost.context_over_200k != null) tiers = [{...m.cost.context_over_200k,tier:{type:'context',size:200000}}];
   if (tiers != null && (!Array.isArray(tiers) || tiers.some(t => t?.tier?.type !== 'context' || !rate(t.tier.size) || t.tier.size <= 0 || !tuple(t)))) continue;
   const context = (tiers ?? []).map(t => [t.tier.size,tuple(t)]).sort((a,b) => a[0]-b[0]);
   if (new Set(context.map(t=>t[0])).size !== context.length) continue;
  rows.set(provider+'\0'+id,{base,context});
  }
 }
 return rows;
}

// The evidence behind the unit price that was applied. lookupModelPrice resolves the rate
// through the same selection order as the valuation, so what is recorded here is what was
// charged -- provided it is asked the same question: same instant, same input size, same
// service tier. claudeCacheTtl is deliberately absent: the stored amount assumes the
// 5-minute cache write, and the collector's own quote injects the user's 1-hour option.
// A quote naming a different source is not this row's evidence and is dropped rather than
// recorded as though it were.
function priceEvidenceOf(row, base, lookup) {
 if (!valid(base?.usd)) return null;
 const quote = lookupModelPrice(row?.provider, row?.model, {timestamp:row?.timestamp,
  inputTokens:row?.usage?.inputTokens, tierOutcome:row?.tierOutcome,
  responseServiceTier:row?.responseServiceTier, requestedServiceTier:row?.requestedServiceTier,
  catalog:lookup});
 if (quote.status === 'unpriced' || quote.sourceUrl !== base.sourceUrl) return null;
 // Built field by field. Spreading the quote would carry whatever that contract grows next
 // into stored history, where every field is kept for the retention period.
 return {provider:quote.provider, model:quote.model, status:quote.status, sourceUrl:quote.sourceUrl,
  checkedAt:quote.checkedAt, effectiveFrom:quote.effectiveFrom, effectiveTo:quote.effectiveTo,
  rates:{input:quote.rates.input, output:quote.rates.output, cacheRead:quote.rates.cacheRead,
   cacheWrite:quote.rates.cacheWrite},
  tierMultiplier:quote.tierMultiplier, conditions:[...quote.conditions], unsupported:[...quote.unsupported],
  conflict:quote.conflict === null ? null : {status:quote.conflict.status,
   rates:{input:quote.conflict.rates.input, output:quote.conflict.rates.output,
    cacheRead:quote.conflict.rates.cacheRead, cacheWrite:quote.conflict.rates.cacheWrite},
   reason:quote.conflict.reason},
  reason:quote.reason};
}

export async function createPricingCatalog({file = process.env.QUOTA_MODEL_CATALOG || join(process.env.XDG_CACHE_HOME || join(homedir(),'.cache'),'opencode','models.json'), now = Date.now} = {}) {
 // A source update automatically rechecks unpriced history; no per-model migration flags.
  const source = await Promise.all(['pricing.mjs','opencode-pricing.mjs','pricing-catalog.mjs','cursor-cache.mjs','provider-prices.mjs'].map(name=>readFile(new URL(name,import.meta.url))));
 const builtinRevision = hash(Buffer.concat(source));
 let rows = new Map(), signature = null, updatedAt = null, status = 'missing';
 const lookup = (provider,model,input) => {
  if (typeof provider !== 'string' || typeof model !== 'string' || provider.includes('\0') || model.includes('\0')) return null;
  const r = rows.get(provider+'\0'+model); if (!r) return null;
  let selected = r.base;
  for (const [threshold,value] of r.context) if (input > threshold) selected = value;
  return [...selected,null,'local-catalog',r.context.length ? ['long-context'] : []];
 };
// The catalog enumerates its own context boundaries. The selection above stays the only
// place that decides which one applies, so a listed condition cannot drift away from the
// rate that was actually chosen. Same key gate as the lookup: an id carrying the
// separator could otherwise be read back under a provider that has no such row.
 // Supplying this function is a warrant: the returned list is every boundary this catalog
 // applies to that model. Enumeration relies on it because sampling a price cannot prove
 // what it did not sample, and here the list is exactly the one the lookup selects from.
lookup.thresholds = (provider,model) => {
  if (typeof provider !== 'string' || typeof model !== 'string' || provider.includes('\0') || model.includes('\0')) return [];
  return (rows.get(provider+'\0'+model)?.context ?? []).map(([threshold]) => threshold);
 };
  const value = row => claudeCache(row, base => priceCursorCache(base, v => priceUsage(v,{catalog:lookup})), lookup);
 // evidence is always present and is null when there is none, so an absent record and an
 // unread one never share a shape. The quote is taken once, here at the outermost wrapper:
 // priceCursorCache reprices the same row internally, and pricing it there would ask the
 // same question three times per row.
 const price = row => { const base = value(row); return {...base, evidence: priceEvidenceOf(row, base, lookup)}; };
price.revision = builtinRevision;
 return {
  priceUsage:price,
  // Same catalog, same selection order as the valuation above, so a quoted unit price
  // cannot drift from the amount charged. Provider normalization happens inside.
  lookupModelPrice:(provider,model,options={})=>lookupModelPrice(provider,model,{...options,catalog:lookup}),
  // Same catalog and the same selection order once more: the conditions a screen lists are
  // the conditions this valuation would price, including the thresholds above.
  listModelPriceConditions:(provider,model,options={})=>listModelPriceConditions(provider,model,{...options,catalog:lookup}),
  async refresh() {
   let handle;
   try {
    handle = await open(file,'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid catalog file');
    const nextSignature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (signature !== nextSignature) {
     const buffer = Buffer.alloc(info.size+1);
     let length=0;
     while(length<buffer.length){const part=await handle.read(buffer,length,buffer.length-length,length);if(!part.bytesRead)break;length+=part.bytesRead;}
     if(length!==info.size)throw new Error('Catalog changed while reading');
     const next = catalogRows(JSON.parse(buffer.subarray(0,length).toString('utf8')));
     rows = next; signature = nextSignature; updatedAt = info.mtimeMs;
     price.revision = hash(builtinRevision+JSON.stringify([...rows].sort(([a],[b])=>a.localeCompare(b))));
    }
    status = now()-updatedAt > STALE_MS ? 'stale' : 'ok';
   } catch (error) { status = rows.size ? 'stale' : error.code === 'ENOENT' ? 'missing' : 'invalid'; }
   finally { await handle?.close(); }
  },
  diagnostics:()=>({status,modelCount:rows.size,updatedAt:updatedAt === null ? null : new Date(updatedAt).toISOString(),basis:'local-catalog'}),
 };
}
