import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHistory } from '../src/history.mjs';
import { priceUsage } from '../src/pricing.mjs';
import { windowAnalytics, enrichSnapshot } from '../src/analytics.mjs';
const now=1800000000000, minute=60000, reset=now+3600000;
const window=(used=20,r=reset)=>({id:'monthly',label:'월간',usedPercent:used,remainingPercent:100-used,resetAt:new Date(r).toISOString(),stale:false});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'quota-value-'));const store=await openHistory(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})});return store;}
function point(store,at,used,r=reset){store.db.prepare('INSERT INTO samples VALUES (?,?,?,?,?,?)').run('cursor','a','monthly',at,r,used)}
function cost(store,id,at,usd,account='a'){store.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,at,'cursor',account,'model',100,10,0,110,usd,usd===null?'unknown':'official')}
const calculate=(s,w=window())=>windowAnalytics(s,{id:'cursor'},{id:'a',status:'ok'},w,now);
test('fractional and one-point movement calculate low-confidence values from matched cost',async t=>{
 for(const delta of [.315,1]){const s=await fixture(t);point(s,now-10*minute,20-delta);point(s,now,20);cost(s,'1',now-5*minute,2);const v=calculate(s);assert.ok(Math.abs(v.capacityApiUsd-200/delta)<1e-7);assert.equal(v.confidence,'low');assert.match(v.capacityReason,/소량/);}
});
test('a fresh reset reuses prior valid runs without counting the reset jump',async t=>{
 const s=await fixture(t),old=now-20*minute;
 point(s,now-40*minute,10,old);point(s,now-30*minute,20,old);cost(s,'old',now-35*minute,5);
 point(s,now-10*minute,0);point(s,now,0);
 const v=calculate(s,window(0));assert.equal(v.capacityApiUsd,50);assert.equal(v.remainingApiUsd,50);assert.equal(v.matchedDeltaPp,10);assert.equal(v.recentRatePpHour,0);assert.equal(v.capacityBasis,'historical');
});
test('gaps, cross-reset pairs, zero movements and unpriced traffic cannot invent capacity',async t=>{
 for(const mode of ['gap','reset','flat','unpriced']){const s=await fixture(t);point(s,now-(mode==='gap'?30:10)*minute,10,mode==='reset'?reset-100000:reset);point(s,now,mode==='flat'?10:20);cost(s,'1',now-5*minute,mode==='unpriced'?null:10);const v=calculate(s);assert.equal(v.capacityApiUsd,null,mode);assert.ok(v.capacityReason,mode);}
});
test('partial priced usage retains an approximate partial subscription value',async t=>{
 const s=await fixture(t);point(s,now-10*minute,10);point(s,now,20);cost(s,'1',now-5*minute,5);cost(s,'2',now-4*minute,null);
 const snapshot={providers:[{id:'cursor',accounts:[{id:'a',status:'ok',plan:'ultra',windows:[window()]}]}]};
 const v=enrichSnapshot(snapshot,s,{plans:new Map()},{lookupSubscription:()=>({monthlyUsd:200}),pricingSources:[]},now).providers[0].accounts[0];
 assert.equal(v.analytics.monthlyValueRatio,.025);assert.equal(v.analytics.monthlyValueBasis,'partial');assert.equal(v.windows[0].analytics.capacityBasis,'partial');
});

test('quota that moved with no priced usage divides the estimate instead of vanishing from it',async t=>{
 const s=await fixture(t),old=now-20*minute;
 point(s,now-40*minute,0,old);point(s,now-30*minute,10,old);cost(s,'priced',now-35*minute,10);
 point(s,now-10*minute,0);point(s,now,90);cost(s,'unknown',now-5*minute,null);
 const v=calculate(s,window(90));
 // The 90%p run logged only an unpriced request, so it enters the denominator at $0.
 // Discarding it used to publish $100, an estimate built from one tenth of the movement.
 assert.equal(v.capacityApiUsd,10);assert.equal(v.matchedDeltaPp,10);assert.equal(v.unexplainedDeltaPp,90);
 assert.equal(v.capacityBasis,'lower-bound');assert.equal(v.capacityObservedDeltaPp,100);
 assert.equal(v.capacityMatchedQuotaCoverage,.1);assert.equal(v.capacityObservedAt,new Date(now-30*minute).toISOString());
 assert.match(v.capacityReason,/보수적으로 계산/);
});

test('one cheap request cannot swing the estimate, and run order does not matter',async t=>{
 // The live shape that made two accounts of one provider differ sevenfold: most of
 // the quota was consumed outside OpenCodex, and whether a run was counted depended
 // only on whether a stray cheap request happened to land inside it.
 const runs=[[0,14,'a',.16],[20,37,'b',2.42],[45,68,null,null]];
 const order=[[0,1,2],[2,0,1]];
 const results=[];
 for(const sequence of order){
  const s=await fixture(t);
  let at=now-600*minute;
  for(const index of sequence){
   const [from,to,id,usd]=runs[index];
   point(s,at,from);point(s,at+10*minute,to);
   if(id!==null)cost(s,id+sequence.join(''),at+5*minute,usd);
   at+=40*minute;
  }
  point(s,now,68);
  results.push(calculate(s,window(68)));
 }
 for(const v of results){
  assert.ok(Math.abs(v.capacityApiUsd-2.58/54*100)<1e-9);
  assert.equal(v.matchedDeltaPp,31);assert.equal(v.unexplainedDeltaPp,23);
  assert.equal(v.capacityBasis,'lower-bound');
 }
 assert.equal(results[0].capacityApiUsd,results[1].capacityApiUsd);
});

test('an unreadable tail stays out of the denominator even when the run has no priced usage',async t=>{
 const s=await fixture(t);s.set('usageReadAt',now-10*minute);
 point(s,now-60*minute,0);point(s,now-50*minute,10);cost(s,'matched',now-55*minute,1);
 point(s,now-20*minute,10);point(s,now-10*minute,20);point(s,now,40);
 const v=calculate(s,window(40));
 // The second run moved 30%p but only its first 10%p is inside the log we have read.
 assert.equal(v.unexplainedDeltaPp,10);assert.equal(v.capacityObservedDeltaPp,40);
 assert.equal(v.capacityApiUsd,5);
});

test('unexplained movement alone downgrades confidence that would otherwise be medium',async t=>{
 const s=await fixture(t);
 point(s,now-120*minute,0);point(s,now-110*minute,10);
 for(let i=0;i<20;i++)cost(s,'priced'+i,now-115*minute,.1);
 let v=calculate(s,window(10));
 assert.equal(v.confidence,'medium');assert.equal(v.unexplainedDeltaPp,0);assert.equal(v.capacityBasis,'matched');
 point(s,now-60*minute,10);point(s,now-50*minute,20);
 v=calculate(s,window(20));
 assert.equal(v.unexplainedDeltaPp,10);assert.equal(v.capacityBasis,'lower-bound');
 assert.equal(v.confidence,'low');
});

test('movement with no priced usage anywhere leaves the estimate unknown rather than zero',async t=>{
 const s=await fixture(t);
 point(s,now-60*minute,0);point(s,now-50*minute,30);
 point(s,now-20*minute,30);point(s,now,60);
 const v=calculate(s,window(60));
 assert.equal(v.capacityApiUsd,null);assert.equal(v.remainingApiUsd,null);assert.equal(v.capacityBasis,null);
 assert.equal(v.unexplainedDeltaPp,60);assert.equal(v.matchedDeltaPp,0);
});

test('absent account usage has no monthly value basis and unattributed costs make its ratio partial',async t=>{
 const s=await fixture(t);
 const snapshot={providers:[{id:'cursor',accounts:[{id:'a',status:'ok',plan:'ultra',windows:[]}]}]};
 const evaluate=()=>enrichSnapshot(snapshot,s,{plans:new Map()},{lookupSubscription:()=>({monthlyUsd:200}),pricingSources:[]},now).providers[0].accounts[0].analytics;
 assert.equal(evaluate().monthlyValueRatio,null);assert.equal(evaluate().monthlyValueBasis,null);
 cost(s,'linked',now-minute,5);cost(s,'unlinked',now-minute,10,null);
 assert.equal(evaluate().monthlyValueRatio,.025);assert.equal(evaluate().monthlyValueBasis,'partial');
});

test('five-hour recommendation includes the first positive priced request in a short history',async t=>{
 const s=await fixture(t);cost(s,'first',now-2*86400000,300);cost(s,'last',now-minute,1);
 for(const id of ['weekly','five-hour']) for(const [minutes,used] of [[10,0],[0,id==='weekly'?.1:1]])
  s.db.prepare('INSERT INTO samples VALUES (?,?,?,?,?,?)').run('cursor','a',id,now-minutes*minute,reset,used);
 const snapshot={providers:[{id:'cursor',accounts:[{id:'a',status:'ok',plan:'ultra',windows:['weekly','five-hour'].map(id=>({...window(1),id}))}]}]};
 const r=enrichSnapshot(snapshot,s,{plans:new Map()},{lookupSubscription:()=>({monthlyUsd:200}),pricingSources:[]},now).providers[0].analytics.recommendation;
 assert.equal(r.peakFiveHourAccounts,3);assert.equal(r.minimumAccounts,2);assert.equal(r.recommendedAccounts,2);
});

test('continuous observation reaches weekly recommendations through the real history pipeline',async t=>{
 const s=await fixture(t),day=86400000;
 s.set('usageReadAt',now);s.set('usageObservedSince',now-30*day);s.set('usageObservedThrough',now);
 cost(s,'yesterday',now-day,600);
 for(let i=0;i<20;i++)cost(s,'current'+i,now-5*minute+i,5);
 for(const [id,start,end] of [['weekly',10,20],['five-hour',0,80]])
  for(const [at,used] of [[now-10*minute,start],[now,end]])s.db.prepare('INSERT INTO samples VALUES (?,?,?,?,?,?)').run('cursor','a',id,at,reset,used);
 const snapshot={providers:[{id:'cursor',accounts:[{id:'a',status:'ok',plan:'ultra',windows:[
  {...window(20),id:'weekly'},{...window(80),id:'five-hour'},
 ]}]}]};
 const evaluate=()=>enrichSnapshot(snapshot,s,{plans:new Map()},{lookupSubscription:()=>({monthlyUsd:200}),pricingSources:[]},now).providers[0].analytics.recommendation;
 const r=evaluate();
 assert.ok(s.pricedBounds('cursor',now-30*day,now).since>now-30*day);
 assert.equal(r.observedDays,30);assert.equal(r.recentObservedDays,7);
 assert.equal(r.weeklyDemandApiUsd,700);assert.equal(r.weeklyCapacityPerAccountUsd,1000);
 assert.equal(r.peakFiveHourAccounts,5);assert.equal(r.recommendedAccounts,1);assert.equal(r.status,'ready');
 s.set('usageObservedSince',now-12*3600000);
 assert.equal(evaluate().observedDays,1);assert.equal(evaluate().status,'provisional');
});

test('new quota capture cannot dilute capacity before matching usage has been read',async t=>{
 const s=await fixture(t);s.set('usageReadAt',now-10*minute);
 for(const [minutes,used] of [[20,10],[10,20],[0,30]])point(s,now-minutes*minute,used);
 cost(s,'before-read',now-15*minute,5);
 let v=calculate(s,window(30));assert.equal(v.capacityApiUsd,50);
 assert.equal(v.capacityObservedAt,new Date(now-10*minute).toISOString());assert.equal(v.capacityBasis,'partial');
 cost(s,'after-read',now-5*minute,5);s.set('usageReadAt',now);
 v=calculate(s,window(30));assert.equal(v.capacityApiUsd,50);assert.equal(v.capacityBasis,'matched');
});

test('Cursor Grok historical repricing repairs only missing dollars and is idempotent',async t=>{
 const s=await fixture(t);const {priceUsage}=await import('../src/pricing.mjs');
 const dir=await mkdtemp(join(tmpdir(),'quota-cursor-replay-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'usage.jsonl'),ids={labels:new Map([['cursor\0oabcdef','a']])};
 await writeFile(file,JSON.stringify({requestId:'cursor-grok',timestamp:now-1000,provider:'cursor',accountLogLabel:'oabcdef',model:'grok-4.6',usageStatus:'estimated',usage:{inputTokens:100000,outputTokens:1000,estimated:true}})+'\n');
 await s.ingest(file,ids,()=>({usd:null,basis:'unknown'}),now);
 s.db.prepare('DELETE FROM meta WHERE key=?').run('cursorGrokPricingReplayV1');
 await s.ingest(file,ids,priceUsage,now);await s.ingest(file,ids,priceUsage,now);
 const v=s.stats('cursor','a',now-5000,now);assert.equal(v.requests,1);assert.equal(v.apiUsd,.206);assert.equal(v.tokens,101000);assert.equal(v.localPriceRequests,1);
});

test('each period tells an unpriced call apart from an amount that really is zero',async t=>{
 const s=await fixture(t);
 // The last hour holds only a call whose price we could not confirm.
 cost(s,'unknown',now-30*minute,null);
 // Further back sits a priced call that genuinely cost nothing.
 cost(s,'free',now-180*minute,0);
 const snapshot={providers:[{id:'cursor',accounts:[{id:'a',status:'ok',plan:'ultra',windows:[]}]}]};
 const periods=enrichSnapshot(snapshot,s,{plans:new Map()},{lookupSubscription:()=>({monthlyUsd:200}),pricingSources:[]},now).providers[0].accounts[0].analytics.periods;
 assert.equal(periods.oneHour.requests,1);
 assert.equal(periods.oneHour.apiUsd,null);
 assert.equal(periods.oneHour.unknownPriceRequests,1);
 assert.equal(periods.oneHour.pricedRequests,0);
 // Adding the zero-cost call makes the subtotal 0, which is not the same as unknown.
 assert.equal(periods.fiveHour.requests,2);
 assert.equal(periods.fiveHour.apiUsd,0);
 assert.equal(periods.fiveHour.pricedRequests,1);
 assert.equal(periods.fiveHour.unknownPriceRequests,1);
 // Never called at all reads differently again: no requests, and no amount.
 assert.equal(periods.twentyFourHour.requests,2);
 const quiet=await fixture(t);
 const none=enrichSnapshot(snapshot,quiet,{plans:new Map()},{lookupSubscription:()=>({monthlyUsd:200}),pricingSources:[]},now).providers[0].accounts[0].analytics.periods;
 assert.equal(none.oneHour.requests,0);assert.equal(none.oneHour.apiUsd,null);assert.equal(none.oneHour.unknownPriceRequests,0);
});

// JUN-45 (d): adding provider evidence fills records that had no price and leaves amounts
// that were already settled under the previous tariff exactly as they were.
test('new provider evidence fills unpriced history without repricing settled amounts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-jun45-'));
 const log=join(dir,'usage.jsonl');
 const store=await openHistory(join(dir,'state'));
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})});
 const at=Date.parse('2026-09-16T12:00:00Z');
 const ids={labels:new Map()};
 const entry=(requestId,model)=>({requestId,provider:'devin',model,timestamp:at,usageStatus:'reported',
  usage:{inputTokens:1000000,outputTokens:100000,cacheReadInputTokens:200000}});
 await writeFile(log,[entry('settled','swe-2'),entry('missing','kimi-k3')].map(e=>JSON.stringify(e)).join('\n')+'\n');
 // The state before this change: swe-2 had a price, kimi-k3 had none. The settled amount is
 // deliberately not today's rate, so a retroactive overwrite would be visible.
 const previous=Object.assign(r=>r.model==='swe-2'?{usd:9.99,basis:'official'}:{usd:null,basis:'unknown'},
  {revision:'before-jun45'});
 await store.ingest(log,ids,previous,at+1000);
 const stored=model=>store.db.prepare('SELECT usd FROM usage WHERE model=?').get(model)?.usd;
 assert.equal(stored('swe-2'),9.99);
 assert.equal(stored('kimi-k3'),null);
 // A changed pricing revision re-reads the log with the current tariff.
 const current=Object.assign(r=>priceUsage(r),{revision:'after-jun45'});
 await store.ingest(log,ids,current,at+2000);
 // Today's tariff would say 3.96, and the settled row still says 9.99.
 assert.equal(priceUsage(entry('probe','swe-2')).usd,3.96);
 assert.equal(stored('swe-2'),9.99);
 // The record that never had a price is the one the new evidence fills.
 assert.equal(stored('kimi-k3'),3.96);
});
