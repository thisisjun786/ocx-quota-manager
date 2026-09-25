import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, rm, appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCollector} from '../src/collector.mjs';
import {createApp} from '../src/server.mjs';
import {startCollectorRuntime} from '../src/collector-runtime.mjs';
const delay = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn) {for(let i=0;i<500;i++){if(await fn())return;await delay(10);}throw Error('condition not reached');}
async function world(t) {
 const home=await mkdtemp(join(tmpdir(),'quota-isolation-'));
 await mkdir(join(home,'native'));
 await writeFile(join(home,'native/auth.json'),JSON.stringify({tokens:{account_id:'synthetic-physical',access_token:'SYNTHETIC_TOKEN'}}));
 await writeFile(join(home,'config.json'),JSON.stringify({providers:{openai:{},anthropic:{},xai:{},devin:{},google:{apiKey:'SYNTHETIC_GOOGLE'}}}));
 await writeFile(join(home,'auth.json'),JSON.stringify({anthropic:{accounts:[{id:'a',credential:{access:'SYNTHETIC_A',accountId:'physical-a'}}]},xai:{accounts:[{id:'x',credential:{access:'SYNTHETIC_X',accountId:'physical-x'}}]},devin:{accounts:[{id:'d',credential:{access:'SYNTHETIC_D',accountId:'physical-d'}}]}}));
 await writeFile(join(home,'admin-api-token'),'ocx_admin_'+'a'.repeat(43));
 await writeFile(join(home,'usage.jsonl'),'');
 return {home,codexHome:join(home,'native'),dataDir:join(home,'state'),catalogPath:join(home,'no-models.json')};
}
const adapter = provider => ({provider,endpointId:'test',sourceVersion:'test-1',parse:()=>[{windowId:'weekly',label:'주간',resetAt:Date.now()+86400000,raw:{method:'reported_percent',percent:12,scopeKey:'all',unit:'percent'}}]});
const endpoint = {host:'quota.invalid',path:'/usage',acceptsDefaultBase:true,configuredOrigins:['https://quota.invalid'],authorize:c=>({Authorization:'Bearer '+c.value})};
const response=()=>({status:200,headers:{get:()=>null},text:async()=>JSON.stringify({})});
test('blocked direct provider does not stop another provider, local ingestion or repeat ticks',async t=>{
 const options=await world(t);let release,blocked=0,fast=0;
 const gate=new Promise(r=>{release=r;});
 const c=await createCollector({...options,directIntervalMs:1,intervalMs:20,
  directAdapters:[adapter('openai'),adapter('anthropic')],directEndpoints:{openai:{test:endpoint},anthropic:{test:endpoint}},
  directFetcher:async(_url,init)=>{if(init.headers.Authorization.includes('SYNTHETIC_TOKEN')){blocked++;await gate;}else fast++;return response();}});
 t.after(async()=>{release();await c.close();await rm(options.home,{recursive:true,force:true});});
 await c.start();
 await until(()=>blocked===1&&fast>=1);
 let explicitDone=false;
 const local=c.collect({waitForQuota:false});
 const explicit=c.collect().then(()=>{explicitDone=true;});
 await local;
 assert.equal(explicitDone,false,'explicit collection must still await blocked quota when it overlaps local collection');
 await appendFile(join(options.home,'usage.jsonl'),JSON.stringify({requestId:'new',timestamp:Date.now()-1,provider:'openai',model:'gpt-5.6-sol',usageStatus:'reported',usage:{inputTokens:100,outputTokens:10}})+'\n');
 await until(async()=>{const s=await c.snapshot();return s.providers.find(p=>p.id==='openai').analytics.periods.oneHour.requests===1;});
 await until(()=>fast>=2);
 assert.equal(blocked,1,'no duplicate in-flight request');
 const s=await c.snapshot(),a=s.providers.find(p=>p.id==='anthropic').accounts[0];
 assert.equal(a.directQuota.status,'ok','another direct instance must not purge its identity or reading');
 assert.equal(a.windows[0].usedPercent,12);
 release();await explicit;assert.equal(explicitDone,true);
});

test('blocked management provider is isolated and direct-owned providers never request management refresh',async t=>{
 const options=await world(t);let release,slow=0,fast=0,duplicates=0;
 const gate=new Promise(r=>{release=r;});
 const c=await createCollector({...options,intervalMs:20,quotaIntervalMs:1,managementOrigin:'http://127.0.0.1:10104',
  directAdapters:[adapter('openai')],directEndpoints:{openai:{test:endpoint}},directFetcher:async()=>response(),
  managementFetcher:async url=>{const id=new URL(url).searchParams.get('provider');if(url.includes('codex-auth')||id==='devin'||new URL(url).searchParams.get('name')==='google')duplicates++;if(id==='anthropic'){slow++;await gate;}if(id==='xai')fast++;return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};}});
 t.after(async()=>{release();await c.close();await rm(options.home,{recursive:true,force:true});});
 await c.start();await until(()=>slow===1&&fast>=2);
 assert.equal(duplicates,0);assert.equal(slow,1);
 assert.equal((await c.snapshot()).analytics.status,'ok');
});

test('HTTP starts and returns immediately even while the background worker blocks on a local input',async t=>{
 const options=await world(t);
 // FIFOs block worker file reads, independent of the HTTP event loop.
 const {execFileSync}=await import('node:child_process');
 await rm(join(options.home,'config.json'));execFileSync('mkfifo',[join(options.home,'config.json')]);
 const runtime=startCollectorRuntime({...options,directProviders:''});
 const app=createApp({port:0,snapshot:runtime.snapshot});await new Promise(r=>app.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>app.close(r));await runtime.close();await rm(options.home,{recursive:true,force:true});});
 const start=performance.now();
 const s=await(await fetch('http://127.0.0.1:'+app.address().port+'/api/v1/snapshot',{signal:AbortSignal.timeout(1000)})).json();
 assert.equal(s.schemaVersion,1);assert.equal(s.analytics.status,'collecting');
 assert.ok(performance.now()-start<1000);
 // Unblock the exact FIFO before shutdown; no task-owned worker left behind.
 await writeFile(join(options.home,'config.json'),JSON.stringify({providers:{}}));
 await rm(join(options.home,'config.json'));await writeFile(join(options.home,'config.json'),JSON.stringify({providers:{}}));
});

test('live HTTP and usage publication advance while a management request remains unresolved',async t=>{
 const options=await world(t);
 const {createServer}=await import('node:http');
 let held=null, fast=0;
 const upstream=createServer((req,res)=>{
  if(req.url.includes('provider=anthropic')){held=res;return;}
  fast++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({accounts:[],keys:[]}));
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const runtime=startCollectorRuntime({...options,intervalMs:30,quotaIntervalMs:40,directProviders:'',
  managementOrigin:'http://127.0.0.1:'+upstream.address().port},{intervalMs:30});
 const app=createApp({port:0,snapshot:runtime.snapshot});await new Promise(r=>app.listen(0,'127.0.0.1',r));
 t.after(async()=>{held?.end(JSON.stringify({accounts:[]}));await runtime.close();await new Promise(r=>app.close(r));upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(options.home,{recursive:true,force:true});});
 await until(()=>held!==null&&fast>=2);
 await appendFile(join(options.home,'usage.jsonl'),JSON.stringify({requestId:'live-new',timestamp:Date.now()-1,provider:'openai',model:'gpt-5.6-sol',usageStatus:'reported',usage:{inputTokens:100,outputTokens:10}})+'\n');
 await until(async()=>{const s=await runtime.snapshot();return s.providers.find(p=>p.id==='openai')?.analytics.periods.oneHour.requests===1;});
 const before=fast;await until(()=>fast>before);
 assert.equal(held.writableEnded,false,'external request is still held while local and other provider work advance');
 const start=performance.now();
 const s=await(await fetch('http://127.0.0.1:'+app.address().port+'/api/v1/snapshot',{signal:AbortSignal.timeout(1000)})).json();
 assert.equal(s.providers.find(p=>p.id==='openai').analytics.periods.oneHour.requests,1);
 assert.ok(performance.now()-start<1000);
 const retained=JSON.stringify(s.providers[0].analytics.periods);
 held.end(JSON.stringify({accounts:[]}));
 await runtime.close();
 assert.equal(JSON.stringify((await runtime.snapshot()).providers[0].analytics.periods),retained);
});
