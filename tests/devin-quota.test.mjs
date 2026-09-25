import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {devinAdapter} from '../src/devin-quota.mjs';
import {createQuotaTransport, ENDPOINTS} from '../src/quota-transport.mjs';
import {directOptions, DIRECT_PROVIDERS} from '../src/direct-adapters.mjs';
import {readCredentialSource} from '../src/credential-source.mjs';
import {createBindingRegistry} from '../src/account-binding.mjs';
import {createDirectQuota} from '../src/direct-quota.mjs';
import {openHistory} from '../src/history.mjs';
const NOW=1800000000000, TOKEN='SYNTHETIC_DEVIN_TOKEN';
const body = (plan={}) => ({userStatus:{planStatus:plan}});
const credential = {value:TOKEN,baseUrl:{status:'custom',origin:'https://server.codeium.com'}};
const sample = body({weeklyQuotaRemainingPercent:87.25,weeklyQuotaResetAtUnix:'1800604800',
 dailyQuotaRemainingPercent:100,dailyQuotaResetAtUnix:'1800086400',planInfo:{hideDailyQuota:false}});

test('Devin preserves reported daily and weekly limits and flips remaining to used',()=>{
 const rows=devinAdapter.parse(sample);
 assert.deepEqual(rows.map(r=>[r.windowId,r.raw.percent,r.resetAt]),[['short',0,1800086400000],['weekly',12.75,1800604800000]]);
 assert.equal(rows[1].raw.windowSemantics,'fixed_reset');
 assert.equal(rows[1].raw.precisionEvidence,'observed_fraction');
 assert.equal(rows[1].raw.scopeKey,'all');
 assert.equal(devinAdapter.parse(body({weeklyQuotaRemainingPercent:0}))[0].raw.percent,100);
});

test('Devin does not fabricate missing windows, accepts real zero and respects hidden daily quota',()=>{
 assert.deepEqual(devinAdapter.parse({}),[]);
 for(const invalid of [null,'99',NaN,Infinity,-1,101,{},false])
  assert.deepEqual(devinAdapter.parse(body({weeklyQuotaRemainingPercent:invalid})),[]);
 const hidden=structuredClone(sample);hidden.userStatus.planStatus.planInfo.hideDailyQuota=true;
 assert.deepEqual(devinAdapter.parse(hidden).filter(r=>!r.hidden).map(r=>r.windowId),['weekly']);
 assert.deepEqual(devinAdapter.parse(body({dailyQuotaRemainingPercent:42})).map(r=>r.windowId),['short']);
 for(const reset of [null,'',false,'oops','Infinity','8640000000000000',-1]) {
  const row=devinAdapter.parse(body({weeklyQuotaRemainingPercent:99,weeklyQuotaResetAtUnix:reset}))[0];
  assert.equal(row.resetAt,null);assert.equal(row.raw.windowSemantics,'unknown');
 }
});

test('Devin quota RPC has a fixed destination, bounded safe transport, and credential only in body',async()=>{
 const calls=[];
 const transport=createQuotaTransport({fetcher:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(sample));}});
 const response=await transport.request({provider:'devin',endpointId:'user-status',credential});
 assert.equal(response.ok,true);assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus');
 assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.redirect,'manual');
 const request=JSON.parse(calls[0].init.body);
 assert.equal(request.metadata.apiKey,TOKEN);assert.equal(typeof request.metadata.ideVersion,'string');
 assert.equal(calls[0].url.includes(TOKEN),false);assert.equal(JSON.stringify(calls[0].init.headers).includes(TOKEN),false);
 assert.equal(JSON.stringify(response).includes(TOKEN),false);
});

test('credential body builder runs only after canonical-origin validation',async()=>{
 let built=0,calls=0;
 const descriptor={...ENDPOINTS.devin['user-status'],body:c=>{built++;return JSON.stringify({token:c.value});}};
 const transport=createQuotaTransport({endpoints:{devin:{'user-status':descriptor}},fetcher:async()=>{calls++;return new Response('{}');}});
 for(const baseUrl of [{status:'custom',origin:'https://relay.invalid'},{status:'invalid'},{status:'unknown'}])
  assert.equal((await transport.request({provider:'devin',endpointId:'user-status',credential:{...credential,baseUrl}})).kind,'base_url_mismatch');
 assert.equal(built,0);assert.equal(calls,0);
 const echo=createQuotaTransport({fetcher:async()=>new Response(JSON.stringify({token:TOKEN}))});
 assert.equal((await echo.request({provider:'devin',endpointId:'user-status',credential})).kind,'credential_echoed');
 const redirect=createQuotaTransport({fetcher:async()=>new Response(null,{status:302,headers:{Location:'https://elsewhere.invalid'}})});
 assert.equal((await redirect.request({provider:'devin',endpointId:'user-status',credential})).kind,'redirect');
});

test('Devin configured credential collects through SQLite, rotates safely, and persists no secret fingerprint',async t=>{
 const home=await mkdtemp(join(tmpdir(),'quota-devin-'));
 const store=await openHistory(join(home,'state'));let clock=NOW;
 t.after(async()=>{store.close();await rm(home,{recursive:true,force:true});});
 await writeFile(join(home,'config.json'),JSON.stringify({providers:{devin:{baseUrl:'https://server.codeium.com',authMode:'oauth'}}}));
 const auth=token=>writeFile(join(home,'auth.json'),JSON.stringify({devin:{accounts:[{id:'d',credential:{access:token}}]}}));
 await auth(TOKEN);
 const source=()=>readCredentialSource({home,now:clock});
 const opts=directOptions({QUOTA_DIRECT_PROVIDERS:'devin'},{home});await opts.directPrepare();
 assert.ok(DIRECT_PROVIDERS.includes('devin'));assert.equal(opts.directAdapters.length,1);
 let release,started;
 let handler=async()=>new Response(JSON.stringify(sample));
 const direct=createDirectQuota({store,registry:createBindingRegistry({store,now:()=>clock}),
  transport:createQuotaTransport({fetcher:(...args)=>handler(...args),now:()=>clock}),readSource:source,
  adapters:opts.directAdapters,now:()=>clock,intervalMs:0});
 const snapshot=()=>({warnings:[],providers:[{id:'devin',enabled:true,accounts:[{id:'d',active:true,status:'unavailable',windows:[]}]}]});
 await direct.collect();
 const projected=await direct.project(snapshot());
 assert.equal(projected.providers[0].accounts[0].windows.find(w=>w.id==='weekly').usedPercent,12.75);
 // A positive hidden flag clears the prior daily window even when weekly is omitted.
 const before=store.get('directQuotaV1:devin:d').endpoints['user-status'].observation.measuredAt;
 clock+=1000;
 handler=async()=>new Response(JSON.stringify(body({planInfo:{hideDailyQuota:true}})));
 await direct.collect();
 const hidden=await direct.project(snapshot());
 assert.deepEqual(hidden.providers[0].accounts[0].windows.map(w=>w.id),['weekly']);
 assert.equal(hidden.providers[0].accounts[0].windows[0].measurement.fetchedAt,new Date(NOW).toISOString());
 assert.equal(store.get('directQuotaV1:devin:d').endpoints['user-status'].observation.measuredAt,before);
 const digest=(await source()).providers.devin.bindings[0].physical.digest;
 assert.ok(digest);assert.equal((await source()).providers.devin.bindings[0].physical.storable,false);
 const start=new Promise(r=>{started=r;});const gate=new Promise(r=>{release=r;});
 handler=async()=>{started();await gate;return new Response(JSON.stringify(sample));};
 clock+=600000;const flight=direct.collect();await start;await auth('SYNTHETIC_DEVIN_REPLACEMENT');release();await flight;
 const replaced=await direct.project(snapshot());
 assert.equal(replaced.providers[0].accounts[0].windows.length,0,'old account reply must be discarded');
 assert.ok(direct.diagnostics().discarded>=1);
 for(const table of ['meta','identity_epochs']) {
  const dump=JSON.stringify(store.db.prepare('SELECT * FROM '+table).all());
  for(const secret of [TOKEN,'SYNTHETIC_DEVIN_REPLACEMENT',digest])assert.equal(dump.includes(secret),false);
 }
});
