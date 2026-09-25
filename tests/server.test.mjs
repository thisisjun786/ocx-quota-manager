import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApp } from '../src/server.mjs';
async function app(t, snapshot) {
 const s=createApp({port:0,snapshot});await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>s.close(resolve)));return `http://127.0.0.1:${s.address().port}`;
}
test('API serves DTO with privacy headers, denies origins hosts mutations and arbitrary files', async t=>{
 const url=await app(t, async()=>({schemaVersion:1,providers:[]}));
 const response=await fetch(`${url}/api/v1/snapshot`);assert.equal(response.status,200);assert.deepEqual(await response.json(),{schemaVersion:1,providers:[]});assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 for (const options of [{method:'POST'},{headers:{Origin:'https://evil.example'}},{headers:{'sec-fetch-site':'cross-site'}}]) {
 const r=await fetch(`${url}/api/v1/snapshot`,options);assert.equal(r.status,options.method?405:403);
 }
 const badHost = await new Promise(resolve => { const r=request(url+'/api/v1/snapshot',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}); r.end(); }); assert.equal(badHost,403);
 for(const path of ['/config.json','/.env','/../auth.json','/%2e%2e/auth.json','/api/providers']) assert.equal((await fetch(url+path)).status,404);
 assert.equal((await fetch(url+'/healthz')).status,200);
});
test('source failure is recoverable and does not leak exceptions',async t=>{
 let broken=true;const url=await app(t,async()=>{if(broken)throw new Error('SECRET_SENTINEL /home/private');return {providers:[]};});
 const r=await fetch(url+'/api/v1/snapshot');assert.equal(r.status,503);assert.equal((await r.text()).includes('SECRET_SENTINEL'),false);broken=false;assert.equal((await fetch(url+'/api/v1/snapshot')).status,200);
});

test('the snapshot route carries model price evidence through without collapsing nulls',async t=>{
 const priced={model:'claude-opus-5',sources:['ocx-config','observed'],requests:2,unpricedRequests:0,providerBasis:'attributed',
  status:'official',unit:'usd-per-million-tokens',rates:{input:5,output:25,cacheRead:.5,cacheWrite:6.25},
  sourceUrl:'https://platform.claude.com/docs/en/about-claude/pricing',checkedAt:'2026-09-10',
  effectiveFrom:null,effectiveTo:null,conditions:['cache-write-assumed'],unsupported:[],conflict:null,reason:null};
 // An unpriced model keeps its place in the list with null rates, not zeros.
 const unpriced={...priced,model:'never-published-model',sources:['ocx-config'],requests:0,status:'unpriced',
  rates:{input:null,output:null,cacheRead:null,cacheWrite:null},sourceUrl:null,checkedAt:null,
  conditions:[],unsupported:['cache-write'],reason:'모델 단가 미확인'};
 const payload={schemaVersion:1,providers:[{id:'anthropic',analytics:{modelPrices:[priced,unpriced]}}],
  analytics:{modelPriceConditions:{'cache-write-assumed':'캐시 쓰기는 5분 보관 단가를 가정합니다.'}}};
 const url=await app(t,async()=>payload);
 const body=await (await fetch(`${url}/api/v1/snapshot`)).json();
 assert.deepEqual(body.providers[0].analytics.modelPrices,[priced,unpriced]);
 assert.equal(body.providers[0].analytics.modelPrices[1].rates.input,null);
 assert.equal(body.analytics.modelPriceConditions['cache-write-assumed'].length>0,true);
});

test('CLI rejects public and malformed bind addresses', async () => {
 const {spawnSync}=await import('node:child_process');
 for(const host of ['0.0.0.0','::','100.1.2.3','100.99.999.1']) {
  const p=spawnSync(process.execPath,['src/server.mjs'],{env:{...process.env,QUOTA_HOST:host},encoding:'utf8'});
  assert.notEqual(p.status,0,host);assert.match(p.stderr,/Use loopback or a Tailscale/);
 }
});

test('explicit Tailscale HTTPS proxy works without trusting arbitrary forwarded hosts or origins',async t=>{
 const publicOrigin='https://quota.example.ts.net:10105';
 const s=createApp({port:0,publicOrigin,snapshot:async()=>({schemaVersion:1,providers:[]})});await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>s.close(resolve)));
 const url=`http://127.0.0.1:${s.address().port}/api/v1/snapshot`;
 const probe=headers=>new Promise(resolve=>{const req=request(url,{headers},res=>{res.resume();resolve(res.statusCode);});req.end();});
 assert.equal(await probe({Host:'quota.example.ts.net:10105',Origin:publicOrigin}),200);
 assert.equal(await probe({Host:'quota.example.ts.net:10105',Origin:'https://evil.example'}),403);
 assert.equal(await probe({Host:'evil.example','X-Forwarded-Host':'quota.example.ts.net:10105'}),403);
 for(const origin of ['http://quota.example.ts.net','https://evil.example','https://quota.example.ts.net/path'])assert.throws(()=>createApp({publicOrigin:origin}));
 assert.throws(()=>createApp({host:'100.97.43.12',publicOrigin}));
});

test('browser quota freshness excludes expired, invalid and unavailable readings without dropping fresh sibling windows', async () => {
 const {freshWindow}=await import('../public/quota.js');
 const now=Date.now(),base={status:'ok',updatedAt:new Date(now).toISOString()};
 const window={remainingPercent:75,stale:false,resetAt:new Date(now+3600000).toISOString()};
 const cases=[
  [base,window,true],
  [{...base,status:'stale'},window,true],
  [{...base,status:'paused'},window,false],
  [{...base,status:'reauth'},window,false],
  [{...base,status:'unavailable'},window,false],
  [{...base,updatedAt:new Date(now-16*60000).toISOString()},window,false],
  [{...base,updatedAt:new Date(now+2*60000).toISOString()},window,false],
  [{...base,updatedAt:null},window,false],
  [base,{...window,resetAt:new Date(now-1000).toISOString()},false],
  [base,{...window,remainingPercent:101},false],
  [base,{...window,remainingPercent:null},false],
  [base,{...window,remainingPercent:0},true],
 ];
 const result=cases.map(([a,w])=>freshWindow(a,w));
 assert.deepEqual(result,cases.map(c=>c[2]));
});

test('browser distinguishes zero-valued usage, absent calls and unpriced calls', async () => {
 const {usageAmount,usageNote}=await import('../public/quota.js');
 const result=[
  [usageAmount({requests:1,apiUsd:0}),usageNote({requests:1,apiUsd:0})],
  [usageAmount({requests:0,apiUsd:null}),usageNote({requests:0,apiUsd:null})],
  [usageAmount({requests:2,apiUsd:null}),usageNote({requests:2,apiUsd:null})],
  [usageAmount({requests:1,apiUsd:0.00403005}),usageNote({requests:1,apiUsd:0.00403005})],
  [usageAmount({requests:1,apiUsd:0.00000001}),usageNote({requests:1,apiUsd:0.00000001})],
  [usageAmount({requests:1,apiUsd:0.5,cacheEstimatedRequests:1}),usageNote({requests:1,apiUsd:0.5,cacheEstimatedRequests:1})],
  [usageAmount({requests:2,apiUsd:3,unknownPriceRequests:1}),usageNote({requests:2,apiUsd:3,unknownPriceRequests:1})]
 ];
 assert.deepEqual(JSON.parse(JSON.stringify(result)),[['$0.00','1회 호출'],['—','호출 없음'],['—','단가 미확인'],['$0.00403','1회 호출'],['< $0.000001','1회 호출'],['$0.50','1회 호출 · 캐시 추정'],['$3.00','일부']]);
});

test('the served snapshot stays schema version 1 and keeps the period fields a browser already reads',async t=>{
 const {mkdtemp,rm,writeFile}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {openHistory}=await import('../src/history.mjs');
 const {enrichSnapshot}=await import('../src/analytics.mjs');
 const {usageAmount,usageNote}=await import('../public/quota.js');
 const now=1800000000000;
 const dir=await mkdtemp(join(tmpdir(),'quota-server-periods-'));
 const store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})});
 const identities={labels:new Map([['openai\0pabcdef','a1'],['openai\0paaaaaa','gone']]),plans:new Map()};
 const file=join(dir,'usage.jsonl');
 // Two reads two hours apart of the same file, so the served numbers carry a real
 // observed span rather than a placeholder.
 await writeFile(file,'');
 await store.ingest(file,identities,()=>({usd:1.5,basis:'official'}),now-7200000);
 // Ninety minutes back, so the one-hour period is genuinely empty while the rest hold
 // it, plus one call from an account this snapshot will not list.
 await writeFile(file,[
  {requestId:'one',timestamp:now-5400000,provider:'openai-pabcdef',usage:{inputTokens:100,outputTokens:100}},
  {requestId:'two',timestamp:now-5400000,provider:'openai-paaaaaa',usage:{inputTokens:100,outputTokens:100}},
 ].map(r=>JSON.stringify(r)).join('\n')+'\n');
 await store.ingest(file,identities,()=>({usd:1.5,basis:'official'}),now);
 const observedAt=new Date(now).toISOString();
 const base={schemaVersion:1,observedAt,source:'opencodex-local-snapshot',refreshIntervalSeconds:10,warnings:[],
  providers:[{id:'openai',name:'OpenAI',enabled:true,defaultModel:null,
   accounts:[{id:'a1',label:'A',plan:null,active:true,status:'ok',updatedAt:observedAt,quotaMode:'observed',windows:[]}]}]};
 const enriched=enrichSnapshot(base,store,identities,{lookupSubscription:()=>({monthlyUsd:20,label:'Pro'}),pricingSources:[]},now);
 const url=await app(t,async()=>enriched);
 const body=await (await fetch(url+'/api/v1/snapshot')).json();
 assert.equal(body.schemaVersion,1);
 const periods=body.providers[0].accounts[0].analytics.periods;
 assert.deepEqual(Object.keys(periods),['oneHour','fiveHour','twentyFourHour','weekly','monthly']);
 // A reader that only knows the three original keys renders exactly what it did before.
 for(const key of ['fiveHour','weekly','monthly']){
  assert.equal(usageAmount(periods[key]),'$1.50',key);
  assert.equal(usageNote(periods[key]),'1회 호출',key);
 }
 assert.equal(periods.oneHour.requests,0);
 assert.equal(usageNote(periods.oneHour),'호출 없음');
 assert.equal(periods.fiveHour.startedAt,new Date(now-5*3600000).toISOString());
 assert.equal(periods.fiveHour.endedAt,observedAt);
 // The observation span and the remainder for an unlisted account both cross the wire
 // with the values the store actually holds, not placeholders.
 assert.equal(periods.oneHour.observedCoverageHours,1);
 assert.equal(periods.fiveHour.observedCoverageHours,2);
 const provider=body.providers[0].analytics.periods;
 assert.equal(provider.fiveHour.requests,2);
 assert.equal(provider.fiveHour.listedAccountRequests,1);
 assert.equal(provider.fiveHour.unlistedAccountRequests,1);
 assert.equal(provider.fiveHour.unattributedRequests,0);
 assert.equal(body.analytics.usageObservedSince,new Date(now-7200000).toISOString());
});
