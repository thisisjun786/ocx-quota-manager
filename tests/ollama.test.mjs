import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHistory } from '../src/history.mjs';
import { parseOllamaUsage, calibrateOllama, createOllamaMonitor } from '../src/ollama.mjs';
import { windowAnalytics } from '../src/analytics.mjs';
import { recommendQuotaAccounts } from '../src/recommendation.mjs';
import { weeklyQuotaUsage } from '../public/quota.js';
import { createCollector } from '../src/collector.mjs';
const M=60000, NOW=1800000000000;
const limits=(used,count,extra={})=>({session:{used,models:{'glm-5.3':count,...extra}}});
const observations=Array.from({length:6},(_,i)=>({at:NOW+i*M,limits:limits(i*.1,i)}));
const rows=Array.from({length:5},(_,i)=>({at:NOW+(i+1)*M,model:'glm-5.3',input:100,output:20,usd:.1}));
test('delayed provider counters accumulate until the complete run matches, without counting it twice',()=>{
 const obs=Array.from({length:16},(_,i)=>({at:NOW+i*M,limits:limits(i*.1,i>=5&&i<10?i-1:i)}));
 const usage=Array.from({length:15},(_,i)=>({at:NOW+(i+1)*M,model:'glm-5.3',input:100,output:20,usd:.1}));
 assert.equal(calibrateOllama(obs.slice(0,10),usage,'session').length,0);
 const [m]=calibrateOllama(obs,usage,'session');
 assert.equal(m.requests,15); assert.equal(m.deltaPp,1.5);
 assert.equal(m.inputTokens,1500); assert.equal(m.outputTokens,300);
 assert.equal(m.observedAt,new Date(NOW+15*M).toISOString());
});

test('Ollama resetless estimates reach the summary and recommendation without inventing a reset',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-estimate-')),store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKey:'estimate-key'}}}));
 let tick=0;
 const monitor=createOllamaMonitor({home:dir,store,now:()=>NOW+tick*M,fetcher:async()=>({ok:true,text:async()=>JSON.stringify({limits:{weekly:{usage:tick*.001,models:[{name:'glm-5.3',request_count:tick}]}}})})});
 for(tick=0;tick<=10;tick++)await monitor.collect();tick=10;
 const records=Array.from({length:10},(_,i)=>({requestId:`estimate-${i}`,timestamp:NOW+(i+1)*M,provider:'ollama-cloud',model:'glm-5.3',usageStatus:'reported',usage:{inputTokens:100,outputTokens:20}}));
 const file=join(dir,'usage.jsonl');await writeFile(file,records.map(JSON.stringify).join('\n')+'\n');
 await store.ingest(file,{labels:new Map()},()=>({usd:.1,basis:'official'}),NOW+10*M);
 const p=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default',windows:[]}]}]}).providers[0];
 const a=p.accounts[0],w=a.windows[0];
 w.analytics=windowAnalytics(store,p,a,w,NOW+10*M);
 assert.equal(w.resetAt,null);assert.equal(w.measurement.windowSemantics,'unknown');
 const sample=w.analytics.consumptionPeriods.oneHour;
 assert.equal(sample.deltaPp,1);assert.equal(sample.basis,'observed-increase');
 assert.ok(Math.abs(sample.observedHours-1/6)<1e-9);
 assert.equal(sample.recoveredHours,0);
 assert.ok(Math.abs(w.analytics.capacityApiUsd-100)<1e-9);
 assert.equal(w.analytics.capacityBasis,'workload-estimate');assert.equal(w.analytics.confidence,'low');
 assert.equal(w.analytics.exhaustsAt,null);
 assert.match(weeklyQuotaUsage(p,'oneHour').title,/증가분/);
 const rec=recommendQuotaAccounts(p,'oneHour',1);
 assert.equal(rec.recommendedAccounts,2);assert.equal(rec.status,'provisional');
 assert.match(rec.reason,/증가분/);
 const full=structuredClone(p);
 Object.assign(full.accounts[0].windows[0].analytics.consumptionPeriods.oneHour,{spanHours:1,observedHours:1,coverage:1});
 assert.equal(recommendQuotaAccounts(full,'oneHour',1).status,'provisional');
 assert.equal(weeklyQuotaUsage(full,'oneHour').state,'partial');
 // A successful log read is the far edge of capacity matching, even if quota
 // polling is ahead. Historical increase remains available while stale.
 store.set('usageReadAt',NOW+4*M);
 const lagged=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]}).providers[0].accounts[0];
 assert.equal(lagged.ollama.windows[0].models.length,0);
 tick=30;
 const stale=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]}).providers[0].accounts[0];
 const sa=windowAnalytics(store,p,stale,stale.windows[0],NOW+30*M);
 assert.equal(sa.status,'stale');assert.equal(sa.capacityApiUsd,null);
 assert.equal(sa.consumptionPeriods.oneHour.deltaPp,1);
 // The common snapshot boundary wins over a later local clock read. The edge
 // cuts the 4->5 minute interval in half: .55pp over5.5 observed minutes.
 const boundary=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]},NOW+64.5*M).providers[0].accounts[0];
 const clipped=boundary.ollama.windows[0].consumptionPeriods.oneHour;
 assert.ok(Math.abs(clipped.deltaPp-.55)<1e-9);
 assert.equal(clipped.periodEndedAt,new Date(NOW+64.5*M).toISOString());
 const empty=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]},NOW+80*M).providers[0].accounts[0];
 assert.equal(empty.ollama.windows[0].consumptionPeriods.oneHour.deltaPp,null);
});

test('resetless increases exclude drops, missing windows, counter rollovers and gaps',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-breaks-')),store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKey:'break-key'}}}));
 let minute=0,used=10,count=10,missing=false;
 const monitor=createOllamaMonitor({home:dir,store,now:()=>NOW+minute*M,fetcher:async()=>({ok:true,text:async()=>JSON.stringify({limits:missing?{session:{usage:0}}:{weekly:{usage:used/100,models:[{name:'x',request_count:count}]}}})})});
 for(const [at,value,n,absent] of [[0,10,10],[2,11,11],[4,10.5,11],[6,11,12],[8,50,1],[10,51,2],[20,90,30],[22,91,31],[24,0,0,true],[26,99,40]]) {
  minute=at;used=value;count=n;missing=!!absent;await monitor.collect();
 }
 const a=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]}).providers[0].accounts[0];
 const sample=a.ollama.windows.find(w=>w.id==='weekly').consumptionPeriods.oneHour;
 assert.equal(sample.deltaPp,3.5);
 assert.ok(Math.abs(sample.observedHours-8/60)<1e-9);
 assert.equal(sample.recoveredDeltaPp,0);assert.equal(sample.resetGapCount,0);
 assert.equal(a.windows.find(w=>w.id==='weekly').resetAt,null);
});

test('mixed runs can yield later isolated models and pending matches never cross a break',()=>{
 const obs=Array.from({length:16},(_,i)=>({at:NOW+i*M,limits:limits(i*.1,i,{other:i>=1?1:0})}));
 const usage=Array.from({length:15},(_,i)=>({at:NOW+(i+1)*M,model:'glm-5.3',input:100,output:20,usd:.1}));
 usage.push({at:NOW+M,model:'other',input:20,output:20,usd:.1});
 assert.equal(calibrateOllama(obs,usage,'session')[0].requests,10);
 for(const kind of ['gap','drop','counter']) {
  const changed=Array.from({length:11},(_,i)=>({at:NOW+i*M,limits:limits(i*.1,i>=5&&i<10?i-1:i)}));
  if(kind==='gap')for(let i=6;i<changed.length;i++)changed[i].at+=10*M;
  if(kind==='drop')changed[6].limits.session.used=0;
  if(kind==='counter')changed[6].limits.session.models['glm-5.3']=0;
  assert.equal(calibrateOllama(changed,usage.slice(0,10),'session').length,0,kind);
 }
});

test('unreported calls cannot disappear into a delayed counter match',()=>{
 const extra=[...rows,{at:NOW+4*M,model:'glm-5.3',input:0,output:0,usd:null,tokensReported:0}];
 assert.equal(calibrateOllama(observations,extra,'session').length,0);
 const missing=rows.map((row,i)=>({...row,tokensReported:i===4?0:1}));
 assert.equal(calibrateOllama(observations,missing,'session').length,0);
 const unpriced=rows.map((row,i)=>({...row,usd:i===4?null:row.usd}));
 const [m]=calibrateOllama(observations,unpriced,'session');
 assert.equal(m.priced,false);assert.equal(m.apiUsdPerPp,null);assert.equal(m.inputTokensPerPp,1000);
});

test('multiple keys keep their own increase series without borrowing provider token logs',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-multikey-')),store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKeyPool:[{id:'a',key:'key-a'},{id:'b',key:'key-b'}]}}}));
 let tick=0;
 const monitor=createOllamaMonitor({home:dir,store,now:()=>NOW+tick*M,fetcher:async(url,options)=>({ok:true,text:async()=>JSON.stringify({limits:{weekly:{usage:tick*(options.headers.Authorization.endsWith('key-a')?.001:.002),models:[{name:'glm-5.3',request_count:tick}]}}})})});
 for(tick=0;tick<=5;tick++)await monitor.collect();tick=5;
 const accounts=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:a'},{id:'key:b'}]}]}).providers[0].accounts;
 assert.deepEqual(accounts.map(a=>a.ollama.windows[0].consumptionPeriods.oneHour.deltaPp),[.5,1]);
 assert.ok(accounts.every(a=>a.ollama.windows[0].models.length===0));
});

test('aliases of the same physical key are collected and summed only once',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-aliases-')),store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKeyPool:[{id:'a',key:'same-key'},{id:'b',key:'same-key'}]}}}));
 let tick=0,calls=0;
 const monitor=createOllamaMonitor({home:dir,store,now:()=>NOW+tick*M,fetcher:async()=>{calls++;return{ok:true,text:async()=>JSON.stringify({limits:{weekly:{usage:tick*.002,models:[{name:'glm-5.3',request_count:tick}]}}})};}});
 for(tick=0;tick<=5;tick++)await monitor.collect();tick=5;
 const p=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:a'},{id:'key:b'}]}]}).providers[0];
 for(const a of p.accounts)for(const w of a.windows)w.analytics=windowAnalytics(store,p,a,w,NOW+5*M);
 assert.equal(calls,6);assert.equal(p.accounts.length,1);assert.equal(p.accounts[0].id,'key:a');
 assert.equal(recommendQuotaAccounts(p,'oneHour',1).totalConsumedPp,1);
 assert.equal(recommendQuotaAccounts(p,'oneHour',1).recommendedAccounts,2);
 assert.equal(recommendQuotaAccounts(p,'oneHour',1).currentAccounts,1);
 assert.equal(weeklyQuotaUsage(p,'oneHour').value,'≈ 1%p');
});

test('collector publishes Ollama estimates at the common snapshot boundary',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-collector-'));let tick=0;
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKey:'synthetic-key',models:['glm-5.3']}}}));
 const collector=await createCollector({home:dir,codexHome:join(dir,'no-codex'),claudeHome:join(dir,'no-claude'),dataDir:join(dir,'data'),catalogPath:join(dir,'catalog'),now:()=>NOW+tick*M,quotaIntervalMs:0,
  ollamaFetcher:async()=>({ok:true,text:async()=>JSON.stringify({limits:{weekly:{usage:tick*.001,models:[{name:'glm-5.3',request_count:tick}]}}})})});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 for(tick=0;tick<=10;tick++)await collector.collectQuota();tick=10;
 await writeFile(join(dir,'usage.jsonl'),Array.from({length:10},(_,i)=>JSON.stringify({requestId:`collector-${i}`,timestamp:NOW+(i+1)*M,provider:'ollama-cloud',model:'glm-5.3',usageStatus:'reported',usage:{inputTokens:100,outputTokens:20}})).join('\n')+'\n');
 await collector.collect({waitForQuota:false});const s=await collector.snapshot(),p=s.providers.find(p=>p.id==='ollama-cloud'),w=p.accounts[0].windows[0];
 assert.equal(w.analytics.consumptionPeriods.oneHour.deltaPp,1);
 assert.equal(w.analytics.consumptionPeriods.oneHour.periodEndedAt,s.observedAt);
 assert.equal(w.analytics.capacityBasis,'workload-estimate');
 assert.equal(p.analytics.quotaRecommendations.oneHour.recommendedAccounts,2);
 assert.equal(s.analytics.status,'ok');
});
test('Ollama fractions retain precision and unavailable windows stay absent',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(parseOllamaUsage({limits:{session:{usage:.001,models:[{name:'x',request_count:2}]},weekly:{usage:0}}}))),{session:{used:.1,fraction:.001,models:{x:2}},weekly:{used:0,fraction:0,models:{}}});
 assert.throws(()=>parseOllamaUsage({limits:{monthly:{usage:'0.1'}}}));
});
test('isolated single-model counter matches calibrate workload mix without invented GPU seconds',()=>{
 const [m]=calibrateOllama(observations,rows,'session');
 assert.equal(m.requests,5);assert.equal(m.deltaPp,.5);assert.equal(m.inputTokensPerPp,1000);assert.equal(m.outputTokensPerPp,200);assert.equal(m.apiUsdPerPp,1);
 assert.equal(calibrateOllama(observations,rows.slice(1),'session').length,0);
 const mixed=structuredClone(observations);mixed.at(-1).limits.session.models.other=1;
 assert.equal(calibrateOllama(mixed,rows,'session').length,0);
 const drop=structuredClone(observations);drop[3].limits.session.used=0;
 assert.equal(calibrateOllama(drop,rows,'session').length,0);
 const gap=structuredClone(observations);gap[3].at+=10*M;
 assert.equal(calibrateOllama(gap,rows,'session').length,0);
});
test('read-only Ollama polling preserves recent failed lookups until expiry and does not expose secrets',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-monitor-'));const store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const cfg={providers:{'ollama-cloud':{apiKey:'SECRET_SENTINEL',baseUrl:'https://ollama.com/v1'}}};
 await writeFile(join(dir,'config.json'),JSON.stringify(cfg));
 let calls=0,fail=false,time=NOW;
 const monitor=createOllamaMonitor({home:dir,store,now:()=>time,fetcher:async(url,options)=>{
  calls++;assert.equal(url,'https://ollama.com/api/usage');assert.equal(options.redirect,'error');
  if(fail)throw new Error('SECRET_SENTINEL');
  return {ok:true,text:async()=>JSON.stringify({limits:{session:{usage:.02},weekly:{usage:.1}}})};
 }});
 const snap=()=>({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]});
 await monitor.collect();let s=monitor.enrich(snap());assert.equal(s.providers[0].accounts[0].windows[0].usedPercent,2);
 assert.equal(s.providers[0].accounts[0].windows[0].resetAt,null);assert.equal(JSON.stringify(s).includes('SECRET_SENTINEL'),false);
 assert.equal(store.db.prepare('SELECT count(*) n FROM ollama_observations').get().n,1);
 fail=true;time+=10000;await monitor.collect();const account=monitor.enrich(snap()).providers[0].accounts[0];
 assert.equal(account.status,'ok');assert.equal(account.refresh.status,'delayed');assert.equal(account.updatedAt,new Date(NOW).toISOString());assert.equal(account.windows[0].stale,false);
 assert.equal(store.db.prepare('SELECT count(*) n FROM ollama_observations').get().n,1);
 time=NOW+15*M+1;assert.equal(monitor.enrich(snap()).providers[0].accounts[0].status,'stale');
 cfg.providers['ollama-cloud'].baseUrl='https://evil.example/v1';await writeFile(join(dir,'config.json'),JSON.stringify(cfg));
 await monitor.collect();assert.equal(calls,2);
});

test('persisted reported-token gate allows complete runs and excludes unreported calls',async t=>{
 for (const reported of [true,false]) await t.test(String(reported),async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ollama-gate-')),store=await openHistory(dir);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKey:'test-key'}}}));
  let tick=0;
  const monitor=createOllamaMonitor({home:dir,store,now:()=>NOW+tick*M,fetcher:async()=>({ok:true,text:async()=>JSON.stringify({limits:{session:{usage:tick*.001,models:[{name:'glm-5.3',request_count:tick}]}}})})});
  for(tick=0;tick<=5;tick++)await monitor.collect();tick=5;
  const records=rows.map((r,i)=>({requestId:`gate-${i}`,timestamp:r.at,provider:'ollama-cloud',model:r.model,usageStatus:i===4&&!reported?'unreported':'reported',usage:{inputTokens:r.input,outputTokens:r.output}}));
  const file=join(dir,'usage.jsonl');await writeFile(file,records.map(JSON.stringify).join('\n')+'\n');
  await store.ingest(file,{labels:new Map()},()=>({usd:.1,basis:'official'}),NOW+5*M);
  assert.equal(store.db.prepare('SELECT sum(tokensReported) n FROM usage_timings').get().n,reported?5:4);
  const s=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]});
  assert.equal(s.providers[0].accounts[0].ollama.windows[0].models.length,reported?1:0);
 });
});

test('one usage response carries the window evidence and the model counters together',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-measure-'));const store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKey:'MEASURE_KEY'}}}));
 let calls=0;
 const monitor=createOllamaMonitor({home:dir,store,now:()=>NOW,fetcher:async()=>{calls++;return{ok:true,status:200,text:async()=>JSON.stringify({limits:{session:{usage:.4237,models:[{name:'glm-5.3',request_count:3}]},weekly:{usage:0}}})};}});
 await monitor.collect();
 // One request. The window evidence and the model counters come out of the same answer.
 assert.equal(calls,1);
 const account=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]}).providers[0].accounts[0];
 const [session,weekly]=account.windows;
 // The provider reports a fraction of the window, so the published percentage is that
 // fraction scaled, not a rounding of it.
 assert.equal(session.usedPercent,.4237*100);
 assert.equal(session.measurement.method,'reported_fraction');
 assert.equal(session.measurement.reportedPercent,.4237*100);
 assert.equal(session.measurement.precisionEvidence,'observed_fraction');
 assert.equal(session.measurement.scopeKey,'ollama-cloud/api-usage/session');
 assert.equal(session.measurement.sourceVersion,'ollama-usage-v1');
 // This surface publishes no limit, and none is invented from a plan price.
 assert.equal(session.measurement.limitState,'missing');
 assert.equal(session.measurement.calculatedPercent,null);
 // Zero is a reading, not an absent one.
 assert.equal(weekly.usedPercent,0);assert.equal(weekly.measurement.reportedPercent,0);
 assert.equal(weekly.measurement.precisionEvidence,'unknown');
 assert.equal(JSON.parse(store.db.prepare('SELECT payload FROM ollama_observations').get().payload).session.models['glm-5.3'],3);
 assert.equal(account.refresh.reason,null);
 assert.equal(JSON.stringify(account).includes('MEASURE_KEY'),false);
});

test('a refused key, an unreachable provider, a broken body and a sound empty answer stay four different answers',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-reason-'));const store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKey:'REASON_KEY'}}}));
 let reply=()=>({ok:true,status:200,text:async()=>JSON.stringify({limits:{session:{usage:.1}}})}),time=NOW;
 const monitor=createOllamaMonitor({home:dir,store,now:()=>time,fetcher:async()=>reply()});
 const refreshOf=async()=>{await monitor.collect();return monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]}).providers[0].accounts[0].refresh;};
 assert.equal((await refreshOf()).reason,null);
 time+=1000;reply=()=>({ok:false,status:401,text:async()=>''});
 const refused=await refreshOf();
 assert.equal(refused.status,'delayed');assert.equal(refused.reason,'credential_rejected');
 time+=1000;reply=()=>({ok:false,status:503,text:async()=>''});
 assert.equal((await refreshOf()).reason,'provider_unavailable');
 // A proxy error page is a broken answer, not an answer with nothing to measure.
 time+=1000;reply=()=>({ok:true,status:200,text:async()=>'<html>proxy</html>'});
 assert.equal((await refreshOf()).reason,'provider_unavailable');
 time+=1000;reply=()=>({ok:true,status:200,text:async()=>'{}'});
 assert.equal((await refreshOf()).reason,'observation_unavailable');
 // None of those erased the reading that did succeed.
 const account=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]}).providers[0].accounts[0];
 assert.equal(account.windows[0].usedPercent,.1*100);
 assert.equal(account.updatedAt,new Date(NOW).toISOString());
});

test('a reading without its own fraction, and one outside the contract, carry no invented basis',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-basis-'));const store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKey:'BASIS_KEY'}}}));
 let usage=.25,time=NOW;
 const monitor=createOllamaMonitor({home:dir,store,now:()=>time,fetcher:async()=>({ok:true,status:200,text:async()=>JSON.stringify({limits:{session:{usage}}})})});
 const windowOf=()=>monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]}).providers[0].accounts[0].windows[0];
 await monitor.collect();
 assert.equal(windowOf().measurement.reportedPercent,25);
 // An observation stored before the fraction was kept keeps its number and gains no basis:
 // dividing the stored percentage back would not return the number the provider sent.
 store.db.prepare('UPDATE ollama_observations SET payload=?').run(JSON.stringify({session:{used:25,models:{}}}));
 assert.equal(windowOf().usedPercent,25);
 assert.equal('measurement' in windowOf(),false);
 // Outside the share the contract can describe, the number still publishes and the basis does not.
 time+=1000;usage=1.25;await monitor.collect();
 assert.equal(windowOf().usedPercent,100);
 assert.equal('measurement' in windowOf(),false);
});

test('a configuration that cannot be read is its own reason, and the last reading survives it',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-config-'));const store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const file=join(dir,'config.json');
 await writeFile(file,JSON.stringify({providers:{'ollama-cloud':{apiKey:'CONFIG_KEY'}}}));
 let time=NOW;
 const monitor=createOllamaMonitor({home:dir,store,now:()=>time,fetcher:async()=>({ok:true,status:200,text:async()=>JSON.stringify({limits:{session:{usage:.3}}})})});
 await monitor.collect();
 const account=()=>monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]}).providers[0].accounts[0];
 assert.equal(account().refresh.reason,null);
 // The file is present but no longer readable as configuration. That is not the provider
 // refusing anything, and it is not a key that expired.
 await writeFile(file,'{ broken');
 time+=1000;await monitor.collect();
 assert.equal(account().refresh.status,'delayed');
 assert.equal(account().refresh.reason,'configuration_unavailable');
 assert.equal(account().windows[0].usedPercent,.3*100);
});

test('the stored fraction is the number the provider sent, not one recovered from the percentage',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-fraction-'));const store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKey:'FRACTION_KEY'}}}));
 // 0.0007 does not survive a percentage round trip: multiplying by 100 and dividing back
 // returns 0.0006999999999999999, so a basis recovered that way would not be the reading.
 const monitor=createOllamaMonitor({home:dir,store,now:()=>NOW,fetcher:async()=>({ok:true,status:200,text:async()=>JSON.stringify({limits:{session:{usage:.0007}}})})});
 await monitor.collect();
 const stored=JSON.parse(store.db.prepare('SELECT payload FROM ollama_observations').get().payload).session;
 assert.equal(stored.fraction,.0007);
 assert.notEqual(stored.used/100,.0007);
 const window=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]}).providers[0].accounts[0].windows[0];
 assert.equal(window.measurement.reportedPercent,.0007*100);
 assert.equal(window.measurement.precisionEvidence,'observed_fraction');
});
