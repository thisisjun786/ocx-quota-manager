import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

import {priceUsage,lookupModelPrice} from '../src/pricing.mjs';
import {createPricingCatalog} from '../src/pricing-catalog.mjs';
import {createCollector} from '../src/collector.mjs';

const TS=Date.parse('2026-09-15T00:00:00Z');

const claudeRow=(model)=>({
 provider:'anthropic',
 model,
 timestamp:TS,
 usageStatus:'reported',
 usage:{inputTokens:1_000_000,outputTokens:0,cacheCreationInputTokens:1_000_000},
});

// Claude cache writes have two published TTL prices: 5 minutes (the current
// default assumption) and 1 hour. The claudeCacheTtl option selects between
// them; anything else must price nothing rather than silently pick a rate.

test('claude-opus-5 cache write defaults to the 5-minute rate',()=>{
 const priced=priceUsage(claudeRow('claude-opus-5'));
 assert.strictEqual(priced.usd,6.25);
});

test('claude-opus-5 cache write with claudeCacheTtl 1h uses the 1-hour rate',()=>{
 const priced=priceUsage(claudeRow('claude-opus-5'),{claudeCacheTtl:'1h'});
 assert.strictEqual(priced.usd,10);
});

test('lookupModelPrice quotes the 1-hour cache write rate for claude-opus-5',()=>{
 const quote=lookupModelPrice('anthropic','claude-opus-5',{claudeCacheTtl:'1h'});
 assert.strictEqual(quote.rates.cacheWrite,10);
});

test('claude-fable-5-1 cache write defaults to the 5-minute rate',()=>{
 const priced=priceUsage(claudeRow('claude-fable-5-1'));
 assert.strictEqual(priced.usd,12.5);
});

test('claude-fable-5-1 cache write with claudeCacheTtl 1h uses the 1-hour rate',()=>{
 const priced=priceUsage(claudeRow('claude-fable-5-1'),{claudeCacheTtl:'1h'});
 assert.strictEqual(priced.usd,20);
});

test('lookupModelPrice quotes the 1-hour cache write rate for claude-fable-5-1',()=>{
 const quote=lookupModelPrice('anthropic','claude-fable-5-1',{claudeCacheTtl:'1h'});
 assert.strictEqual(quote.rates.cacheWrite,20);
});

test('an unsupported claudeCacheTtl leaves the row unpriced',()=>{
 const priced=priceUsage(claudeRow('claude-opus-5'),{claudeCacheTtl:'2h'});
 assert.strictEqual(priced.usd,null);
});

test('an unsupported claudeCacheTtl leaves the quote unpriced',()=>{
 const quote=lookupModelPrice('anthropic','claude-opus-5',{claudeCacheTtl:'2h'});
 assert.strictEqual(quote.status,'unpriced');
});

// The catalog wrapper keeps the 5-minute base price and attaches a sidecar with
// the 1-hour alternative for priced Anthropic rows that actually wrote cache.

const catalogFixture=async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-claude-cache-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 return createPricingCatalog({file:join(dir,'missing-models.json')});
};

test('catalog priceUsage attaches the 1-hour sidecar for a priced Anthropic write',async t=>{
 const catalog=await catalogFixture(t);
 const priced=catalog.priceUsage(claudeRow('claude-opus-5'));
 assert.strictEqual(priced.usd,6.25);
 assert.deepStrictEqual(priced.claudeCache,{
  fiveMinuteUsd:6.25,oneHourUsd:10,cacheWriteTokens:1_000_000,
 });
});

test('catalog priceUsage attaches the 1-hour sidecar for claude-fable-5-1',async t=>{
 const catalog=await catalogFixture(t);
 const priced=catalog.priceUsage(claudeRow('claude-fable-5-1'));
 assert.strictEqual(priced.usd,12.5);
 assert.deepStrictEqual(priced.claudeCache,{
  fiveMinuteUsd:12.5,oneHourUsd:20,cacheWriteTokens:1_000_000,
 });
});

test('catalog priceUsage never attaches the sidecar to ineligible rows',async t=>{
 const catalog=await catalogFixture(t);
 const noSidecar=row=>assert.strictEqual(catalog.priceUsage(row).claudeCache,undefined);
 // Zero or absent cache writes.
 noSidecar({...claudeRow('claude-opus-5'),usage:{inputTokens:1_000_000,outputTokens:0,cacheCreationInputTokens:0}});
 noSidecar({...claudeRow('claude-opus-5'),usage:{inputTokens:1_000_000,outputTokens:0}});
 // Cursor forward and API-key providers are not the anthropic provider.
 noSidecar({...claudeRow('claude-opus-5'),provider:'cursor'});
 noSidecar({...claudeRow('claude-opus-5'),provider:'anthropic-apikey'});
 // Unpriced rows: unknown model and unreported usage.
 noSidecar({...claudeRow('no-such-model')});
 noSidecar({...claudeRow('claude-opus-5'),usageStatus:'unreported'});
});

// The collector option is a user assumption: it is validated before any state is
// opened, and when active it shifts both the quoted cache-write rate and the
// provider's declared assumption together.

const collectorFixture=async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-claude-collector-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{anthropic:{models:['claude-opus-5']}}}));
 await writeFile(join(dir,'auth.json'),'{}');
 await writeFile(join(dir,'usage.jsonl'),'');
 return dir;
};

test('invalid claude cache settings reject before any database is created',async t=>{
 const dir=await collectorFixture(t),dataDir=join(dir,'state'),catalogPath=join(dir,'models.json');
 await assert.rejects(createCollector({home:dir,codexHome:dir,dataDir,catalogPath,claudeCacheTtl:'2h'}));
 await assert.rejects(createCollector({home:dir,codexHome:dir,dataDir,catalogPath,claudeCacheTtl:'1h'}));
 await assert.rejects(createCollector({home:dir,codexHome:dir,dataDir,catalogPath,claudeCacheTtl:'1h',claudeCacheFrom:'not-a-date'}));
 // No timezone designator is not a usable instant.
 await assert.rejects(createCollector({home:dir,codexHome:dir,dataDir,catalogPath,claudeCacheTtl:'1h',claudeCacheFrom:'2026-09-15 12:00'}));
 // Date.parse accepts non-ISO forms and normalizes impossible dates; neither is
 // a valid configured instant.
 await assert.rejects(createCollector({home:dir,codexHome:dir,dataDir,catalogPath,claudeCacheTtl:'1h',claudeCacheFrom:'September 1, 2026 GMT+0000'}));
 await assert.rejects(createCollector({home:dir,codexHome:dir,dataDir,catalogPath,claudeCacheTtl:'1h',claudeCacheFrom:'2026-02-30T00:00:00Z'}));
 await assert.rejects(createCollector({home:dir,codexHome:dir,dataDir,catalogPath,claudeCacheTtl:'1h',claudeCacheFrom:'2026-09-15T25:00:00Z'}));
 await assert.rejects(access(dataDir),{code:'ENOENT'});
});

test('a 1-hour assumption accepts Z and numeric-offset ISO instants',async t=>{
 const dir=await collectorFixture(t);
 for(const from of ['2026-09-01T00:00:00Z','2026-09-01T09:00:00+09:00']){
  const collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state-'+from.slice(-1)),
   catalogPath:join(dir,'models.json'),now:()=>Date.parse('2026-09-15T00:00:00Z'),
   claudeCacheTtl:'1h',claudeCacheFrom:from});
  t.after(()=>collector.close());
  const anthropic=(await collector.snapshot()).providers.find(p=>p.id==='anthropic');
  assert.strictEqual(anthropic.analytics.cacheWriteAssumption.ttl,'1h');
 }
});

test('an active 1-hour assumption shifts the quote and declares itself',async t=>{
 const dir=await collectorFixture(t);
 const now=Date.parse('2026-09-15T00:00:00Z');
 const collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),
  catalogPath:join(dir,'models.json'),now:()=>now,
  claudeCacheTtl:'1h',claudeCacheFrom:'2026-09-01T00:00:00Z'});
 t.after(()=>collector.close());
 const snapshot=await collector.snapshot();
 const anthropic=snapshot.providers.find(p=>p.id==='anthropic');
 assert.deepStrictEqual(anthropic.analytics.cacheWriteAssumption,
  {ttl:'1h',from:'2026-09-01T00:00:00.000Z',basis:'user-assumption'});
 const opus=anthropic.analytics.modelPrices.find(m=>m.model==='claude-opus-5');
 assert.strictEqual(opus.rates.cacheWrite,10);
 assert.ok(opus.conditions.includes('cache-write-1h-assumed'));
});

test('the assumption stays inert before its configured instant and by default',async t=>{
 const dir=await collectorFixture(t);
 const now=Date.parse('2026-09-15T00:00:00Z');
 const pending=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state-a'),
  catalogPath:join(dir,'models.json'),now:()=>now,
  claudeCacheTtl:'1h',claudeCacheFrom:'2026-10-01T00:00:00Z'});
 t.after(()=>pending.close());
 const inactive=(await pending.snapshot()).providers.find(p=>p.id==='anthropic');
 assert.strictEqual(inactive.analytics.cacheWriteAssumption,null);
 assert.strictEqual(inactive.analytics.modelPrices.find(m=>m.model==='claude-opus-5').rates.cacheWrite,6.25);
 const plain=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state-b'),
  catalogPath:join(dir,'models.json'),now:()=>now});
 t.after(()=>plain.close());
 const standard=(await plain.snapshot()).providers.find(p=>p.id==='anthropic');
 assert.strictEqual(standard.analytics.cacheWriteAssumption,null);
 assert.strictEqual(standard.analytics.modelPrices.find(m=>m.model==='claude-opus-5').rates.cacheWrite,6.25);
});
