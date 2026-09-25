import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPricingCatalog} from '../src/pricing-catalog.mjs';
import {openHistory} from '../src/history.mjs';
const now = Date.parse('2026-09-10T12:30:00Z');
const usage = (id='new',model='future-model',timestamp=now) => ({requestId:id,provider:'opencode-go',model,timestamp,usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100,cachedInputTokens:200}});
const data = models => ({'opencode-go':{models}});
const model = (input=2) => ({cost:{input,output:4,cache_read:.5}});
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'quota-catalog-')),file=join(dir,'models.json');
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const catalog=await createPricingCatalog({file,now:()=>now});
 return {dir,file,catalog};
}
test('new exact provider/model rows refresh automatically and remain explicit estimates',async t=>{
 const {file,catalog:c}=await fixture(t);
 await c.refresh();assert.equal(c.diagnostics().status,'missing');assert.equal(c.priceUsage(usage()).usd,null);
 const previous=c.priceUsage.revision;
 await writeFile(file,JSON.stringify(data({'future-model':model(),'deepseek-flash':model(90),'claude-opus-5':model(7)})));await c.refresh();
 assert.notEqual(c.priceUsage.revision,previous);
 const priced=c.priceUsage(usage());assert.equal(priced.usd,.0021);assert.equal(priced.basis,'local-catalog');assert.equal(priced.sourceUrl,null);
 assert.equal(c.priceUsage({...usage(),provider:'opencode'}).usd,null);
 assert.equal(c.priceUsage(usage('x','future-model-latest')).usd,null);
 assert.equal(c.priceUsage({...usage(),responseServiceTier:'fast'}).usd,null);
 assert.equal(c.priceUsage(usage('flash','deepseek-flash')).usd,.0001806); // official beats local 90
 assert.equal(c.priceUsage(usage('bridge','claude-opus-5')).usd,.0061); // exact Go price, not the Anthropic rate
 assert.equal(c.priceUsage(usage('old','deepseek-flash',Date.parse('2026-09-10T03:59:59Z'))).usd,null);
 const loaded=c.priceUsage.revision;
 await writeFile(file,'{broken');await c.refresh();assert.equal(c.diagnostics().status,'stale');assert.equal(c.priceUsage.revision,loaded);assert.equal(c.priceUsage(usage()).usd,.0021);
 await writeFile(file,JSON.stringify(data({'next-model':model(3)})));await c.refresh();
 assert.equal(c.priceUsage(usage()).usd,null);assert.equal(c.priceUsage(usage('x','next-model')).usd,.0029);
});
test('catalog rejects invalid rates, unknown tier shapes and assumed free cache while preserving exact context thresholds',async t=>{
 const {file,catalog:c}=await fixture(t);
 await writeFile(file,JSON.stringify(data({
  free:{cost:{input:0,output:0}},negative:model(-1),string:model('2'),
  missingCache:{cost:{input:1,output:2}},badTier:{cost:{input:1,output:2,tiers:[{input:3,output:4,tier:{type:'time',size:1}}]}},
  context:{cost:{input:1,output:2,cache_read:.1,tiers:[{input:3,output:4,cache_read:.3,tier:{type:'context',size:256000}}],context_over_200k:{input:99,output:99}}},
 })));
 await c.refresh();
 for(const id of ['free','negative','string','missingCache','badTier'])assert.equal(c.priceUsage(usage('x',id)).usd,null,id);
 for(const [input,expected] of [[256000,.256],[256001,.768003]])assert.equal(c.priceUsage({...usage('x','context'),usage:{inputTokens:input,outputTokens:0}}).usd,expected);
});
test('a catalog price stays inside its own provider and a disagreement is recorded, not merged',async t=>{
 const {file,catalog:c}=await fixture(t);
 await writeFile(file,JSON.stringify({
  'opencode-go':{models:{'shared-model':{cost:{input:2,output:4,cache_read:.5}}}},
  google:{models:{'shared-model':{cost:{input:9,output:18,cache_read:1}}}},
  openai:{models:{'gpt-6-astra':{cost:{input:11,output:50,cache_read:1,cache_write:12.5}},'agreeing':{cost:{input:1,output:2}}}},
 }));
 await c.refresh();
 // One model ID, two providers, two prices. Neither borrows the other's.
 assert.equal(c.lookupModelPrice('opencode-go','shared-model').rates.input,2);
 assert.equal(c.lookupModelPrice('google','shared-model').rates.input,9);
 assert.equal(c.lookupModelPrice('cursor','shared-model').status,'unpriced');
 // A catalog row is an estimate and never borrows the provider's own evidence.
 const local=c.lookupModelPrice('opencode-go','shared-model');
 assert.equal(local.status,'local-catalog');
 assert.equal(local.sourceUrl,null);
 assert.equal(local.checkedAt,null);
 assert.equal(local.rates.cacheWrite,null);
 // Official evidence wins and the disagreeing local row is reported beside it.
 const astra=c.lookupModelPrice('openai','gpt-6-astra');
 assert.equal(astra.status,'official');
 assert.equal(astra.rates.input,10);
 assert.deepEqual(astra.conflict.rates,{input:11,output:50,cacheRead:1,cacheWrite:12.5});
 assert.equal(astra.conflict.status,'local-catalog');
 // Agreement is not a conflict, and neither is an omission: the catalog row below
 // states nothing about cache writes, so it cannot contradict a published free rate.
 assert.equal(c.lookupModelPrice('openai','gpt-5.6-luna').conflict,null);
 await writeFile(file,JSON.stringify({xai:{models:{'grok-4.6':{cost:{input:2,output:6,cache_read:.5}}}}}));
 await c.refresh();
 const grok=c.lookupModelPrice('xai','grok-4.6');
 assert.equal(grok.rates.cacheWrite,0);
 assert.equal(grok.conflict,null);
 await writeFile(file,JSON.stringify({xai:{models:{'grok-4.6':{cost:{input:2,output:6,cache_read:.9}}}}}));
 await c.refresh();
 assert.equal(c.lookupModelPrice('xai','grok-4.6').conflict.rates.cacheRead,.9);
});

test('an attributed provider quotes its own current price and does not reconstruct the original one',async t=>{
 const {file,catalog:c}=await fixture(t);
 await writeFile(file,JSON.stringify({openai:{models:{'catalog-only':{cost:{input:2,output:4,
  tiers:[{input:5,output:9,tier:{type:'context',size:200000}}]}}}}}));
 await c.refresh();
 const call=provider=>({provider,model:'catalog-only',timestamp:now,usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}});
 // History folds chatgpt into openai, so the stored key can quote a price the original
 // request's key never had. These records mean the attributed provider's current price.
 assert.equal(c.lookupModelPrice('chatgpt','catalog-only').status,'unpriced');
 assert.equal(c.priceUsage(call('chatgpt')).usd,null);
 assert.equal(c.lookupModelPrice('openai','catalog-only').rates.input,2);
 assert.equal(c.priceUsage(call('openai')).usd,.0024);
 // The catalog's own context threshold applies, and an absent cache price stays absent.
 assert.equal(c.lookupModelPrice('openai','catalog-only',{inputTokens:200000}).rates.input,2);
 assert.equal(c.lookupModelPrice('openai','catalog-only',{inputTokens:200001}).rates.input,5);
 assert.equal(c.lookupModelPrice('openai','catalog-only',{inputTokens:200001}).rates.cacheWrite,null);
 // A row whose rate moves with input size says so.
 assert.deepEqual(c.lookupModelPrice('openai','catalog-only',{}).conditions,['long-context']);
});

test('a model ID carrying the row separator cannot be read back under another provider',async t=>{
 const {file,catalog:c}=await fixture(t);
 // Rows are keyed by provider and model joined with a NUL. Without this guard,
 // provider "a" plus model "b\u0000c" would answer a lookup for provider "a\u0000b".
 await writeFile(file,JSON.stringify({a:{models:{['b\u0000c']:{cost:{input:7,output:11}}}}}));
 await c.refresh();
 assert.equal(c.lookupModelPrice('a\u0000b','c').status,'unpriced');
 assert.equal(c.lookupModelPrice('a','b\u0000c').status,'unpriced');
 assert.equal(c.priceUsage({provider:'a\u0000b',model:'c',timestamp:now,usageStatus:'reported',
  usage:{inputTokens:1000000,outputTokens:0}}).usd,null);
});

test('catalog revision repairs null history without changing rows, known money, attribution or reset boundaries',async t=>{
 const {dir,file,catalog:c}=await fixture(t),log=join(dir,'usage.jsonl'),store=await openHistory(join(dir,'state')),ids={labels:new Map()};
 t.after(()=>store.close());store.set('historyResetAt',now-1000);
 const entries=[usage('pre-reset','future-model',now-1001),usage('new'),usage('known','deepseek-flash')];
 await writeFile(log,entries.map(JSON.stringify).join('\n')+'\ninvalid\n');
 await c.refresh();await store.ingest(log,ids,c.priceUsage,now);
 assert.equal(store.stats('opencode-go',undefined,0,now).requests,2);
 assert.equal(store.stats('opencode-go',undefined,0,now).unknownPriceRequests,1);
 const known=store.db.prepare('SELECT id,usd FROM usage WHERE model=?').get('deepseek-flash');
 assert.deepEqual(store.unpricedModels('opencode-go',0,now),[{model:'future-model',requests:1}]);
 await writeFile(file,JSON.stringify(data({'future-model':model()})));await c.refresh();
 // A failed replay must retry without double-counting malformed lines already read.
 const fail=Object.assign(row=>{if(row.model==='deepseek-flash')throw new Error('interrupted');return c.priceUsage(row);},{revision:c.priceUsage.revision});
 await assert.rejects(store.ingest(log,ids,fail,now),/interrupted/);
 await store.ingest(log,ids,c.priceUsage,now);
 const stats=store.stats('opencode-go',undefined,0,now);assert.equal(stats.requests,2);assert.equal(stats.unknownPriceRequests,0);
 assert.equal(store.get('invalidUsageLines'),1);assert.equal(store.get('historyResetAt'),now-1000);
 assert.equal(store.db.prepare('SELECT usd FROM usage WHERE id=?').get(known.id).usd,known.usd);
 assert.equal(store.db.prepare('SELECT count(*) n FROM usage WHERE account IS NOT NULL').get().n,0);
 const cursor=store.get('usageCursor');await store.ingest(log,ids,c.priceUsage,now);assert.deepEqual(store.get('usageCursor'),cursor);
 await appendFile(log,JSON.stringify(usage('appended'))+'\n');await store.ingest(log,ids,c.priceUsage,now);
 assert.equal(store.stats('opencode-go',undefined,0,now).requests,3);
 await writeFile(file,JSON.stringify(data({'future-model':model(10)})));await c.refresh();await store.ingest(log,ids,c.priceUsage,now);
 assert.equal(store.stats('opencode-go',undefined,0,now).apiUsd,known.usd+.0042);
});
