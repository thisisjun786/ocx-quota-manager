import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,appendFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {priceCursorCache} from '../src/cursor-cache.mjs';
import {priceUsage} from '../src/pricing.mjs';
import {openHistory} from '../src/history.mjs';
import {createCollector} from '../src/collector.mjs';
import {compareOllamaUsage} from '../src/ollama-comparison.mjs';
const NOW=Date.parse('2026-09-10T13:00:00Z'),DAY=86400000;
const close=(a,b)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<1e-10,`${a} != ${b}`);
const row=(id,provider='cursor',u={},extra={})=>({requestId:id,timestamp:NOW,provider,model:'grok-4.6',usageStatus:'estimated',usage:{inputTokens:100000,outputTokens:1000,estimated:true,...u},...extra});
const price=Object.assign(r=>priceCursorCache(r,priceUsage),{revision:'cursor-cache-v1'});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'quota-cursor-cache-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('Cursor missing-cache coefficients keep input/output and exact model/context rates',()=>{
 const r=row('x'),c=price(r).cursorCache;assert.deepEqual(c,{noCacheUsd:.206,fullCacheUsd:.056,eligibleInputTokens:100000});
 assert.equal(r.usage.cachedInputTokens,undefined);assert.equal(r.usage.inputTokens,100000);
 for(const u of [{cachedInputTokens:0},{cacheReadInputTokens:20},{cachedInputTokens:null}])assert.equal(price(row('x','cursor',u)).cursorCache,undefined);
 assert.equal(price(row('x','xai')).cursorCache,undefined);assert.equal(price(row('x','cursor',{}, {usageStatus:'unreported'})).cursorCache,undefined);
 assert.equal(price(row('x','cursor',{}, {model:'unknown'})).cursorCache,undefined);
 const long=price(row('x','cursor',{inputTokens:200000})).cursorCache;assert.deepEqual(long,{noCacheUsd:.812,fullCacheUsd:.212,eligibleInputTokens:200000});
 const write=price(row('x','cursor',{inputTokens:100000,cacheCreationInputTokens:10000},{model:'claude-opus-5'})).cursorCache;
 close(write.noCacheUsd,.5375);close(write.fullCacheUsd,.1325);assert.equal(write.eligibleInputTokens,90000);
 const unknown=priceCursorCache(row('x','cursor',{}, {model:'no-cache-rate'}),r=>priceUsage(r,{catalog:()=>[2,4,null,null,null,'local-catalog']}));assert.equal(unknown.cursorCache,undefined);close(unknown.usd,.204);
});
test('effective valuation replays legacy Cursor rows, updates every amount query, and preserves raw data and reset',async t=>{
 const dir=await fixture(t),s=await openHistory(join(dir,'state')),log=join(dir,'usage.jsonl');t.after(()=>s.close());
 s.set('historyResetAt',NOW-1000);
 const entries=[row('old','cursor',{}, {timestamp:NOW-1001}),row('a'),row('b','cursor',{cachedInputTokens:0}),row('c','xai')];
 await writeFile(log,entries.map(JSON.stringify).join('\n')+'\n');const ids={labels:new Map()};
 await s.ingest(log,ids,priceUsage,NOW);const before=s.db.prepare('SELECT * FROM usage ORDER BY id').all();
 s.set('cursorCacheReference',{appliedRate:.8});await s.ingest(log,ids,price,NOW);
 let v=s.stats('cursor',undefined,0,NOW);close(v.apiUsd,.292);close(v.noCacheApiUsd,.412);assert.equal(v.cacheEstimatedRequests,1);assert.equal(v.estimatedCachedTokens,80000);assert.equal(v.cachedTokens,0);assert.equal(v.localPriceRequests,2);
 close(s.peakFiveHour('cursor',0,NOW),.292);close(s.stats('xai',undefined,0,NOW).apiUsd,.206);
 s.set('cursorCacheReference',{appliedRate:.5});close(s.stats('cursor',undefined,0,NOW).apiUsd,.337);close(s.peakFiveHour('cursor',0,NOW),.337);
 for(const bad of [null,-1,2,'0.8']){s.set('cursorCacheReference',{appliedRate:bad});close(s.stats('cursor',undefined,0,NOW).apiUsd,.412);}
 s.set('cursorCacheReference',{appliedRate:0});close(s.stats('cursor',undefined,0,NOW).apiUsd,.412);
 s.set('cursorCacheReference',{appliedRate:1});close(s.stats('cursor',undefined,0,NOW).apiUsd,.262);
 await s.ingest(log,ids,price,NOW);assert.deepEqual(s.db.prepare('SELECT * FROM usage ORDER BY id').all(),before);
 assert.equal(s.db.prepare('SELECT count(*) n FROM cursor_cache_costs').get().n,1);
 assert.equal(s.get('historyResetAt'),NOW-1000);
 s.maintain(NOW+91*DAY);assert.equal(s.db.prepare('SELECT count(*) n FROM cursor_cache_costs').get().n,0);
});
test('collector and Ollama use the same measured 30-day average and refresh existing Cursor costs without feedback',async t=>{
 const dir=await fixture(t),log=join(dir,'usage.jsonl');let now=NOW;
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{cursor:{}}}));await writeFile(join(dir,'auth.json'),'{}');
 const ref=(id,input,cached,provider='openai')=>row(id,provider,{inputTokens:input,outputTokens:1,cachedInputTokens:cached,estimated:false},{model:'gpt-6-astra',usageStatus:'reported'});
 const entries=[row('c'),ref('r1',900,810),ref('r2',100,10,'anthropic'),ref('cursor-explicit',900000,0,'cursor'),ref('ollama-explicit',900000,0,'ollama-cloud'),ref('unreported',100000,1,'xai')];
 entries.at(-1).usageStatus='unreported';
 await writeFile(log,entries.map(JSON.stringify).join('\n')+'\n');
 let collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),catalogPath:join(dir,'missing.json'),now:()=>now});
 t.after(()=>collector.close());const cursor=s=>s.providers.find(p=>p.id==='cursor').analytics;
 await collector.collect();let snapshot=await collector.snapshot(),c=cursor(snapshot);
 assert.equal(snapshot.refreshIntervalSeconds,10);assert.equal(snapshot.analytics.sampleIntervalSeconds,10);
 const comparison=await compareOllamaUsage(log,{from:now-30*DAY,to:now});assert.equal(c.cacheAssumption.appliedRate,.82);assert.equal(c.cacheAssumption.appliedRate,comparison.cache.appliedRate);close(c.periods.weekly.apiUsd,18.000075+.083);
 const r=ref('new',1000,0);r.timestamp=NOW+1;await appendFile(log,JSON.stringify(r)+'\n');
 now+=60000;await collector.collect();assert.equal(cursor(await collector.snapshot()).cacheAssumption.appliedRate,.82);
 now+=5*60000;await collector.collect();snapshot=await collector.snapshot();c=cursor(snapshot);assert.equal(c.cacheAssumption.appliedRate,.41);close(c.periods.weekly.apiUsd,18.000075+.1445);
 await collector.close();collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),catalogPath:join(dir,'missing.json'),now:()=>now});await collector.collect();close(cursor(await collector.snapshot()).periods.weekly.apiUsd,18.000075+.1445);
 await rename(log,log+'.unavailable');now+=16*60000;await collector.collect();c=cursor(await collector.snapshot());assert.equal(c.cacheAssumption.stale,true);close(c.periods.weekly.apiUsd,18.000075+.1445);
});
