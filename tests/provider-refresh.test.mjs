import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openHistory } from '../src/history.mjs';
import { createProviderRefresh } from '../src/provider-refresh.mjs';
import { windowAnalytics } from '../src/analytics.mjs';
const NOW=1800000000000, M=60000;
const quota=(at,used)=>({updatedAt:at,weeklyPercent:used,weeklyResetAt:(NOW+86400000)/1000});
async function fixture(t) {
 const home=await mkdtemp(join(tmpdir(),'quota-refresh-'));const store=await openHistory(home);
 t.after(async()=>{store.close();await rm(home,{recursive:true,force:true});});
 const config={providers:{openai:{},xai:{},anthropic:{},cursor:{},'opencode-go':{apiKey:'PRIVATE_KEY'},'ollama-cloud':{apiKey:'OLLAMA_KEY'}}};
 const auth={xai:{accounts:[{id:'g1'}]},anthropic:{accounts:[{id:'c1'},{id:'c2'}]},cursor:{accounts:[{id:'u1'}]}};
 for(const [file,value]of Object.entries({'config.json':config,'auth.json':auth}))await writeFile(join(home,file),JSON.stringify(value));
 await writeFile(join(home,'admin-api-token'),'ocx_admin_'+'a'.repeat(43));
 const snapshot=()=>({warnings:[],providers:[['openai',['__main__','pool']],['xai',['g1']],['anthropic',['c1','c2']],['cursor',['u1']],['opencode-go',['key:default']],['ollama-cloud',['key:default']]].map(([id,accounts])=>({id,enabled:true,accounts:accounts.map(id=>({id,label:id,plan:null,active:true,status:'unavailable',updatedAt:null,windows:[],quotaMode:'unavailable'}))}))});
 return {home,store,snapshot};
}
test('only explicit loopback management origins are allowed',()=>{
 for(const origin of ['https://evil.test','http://127.0.0.1.evil.test','http://user:secret@127.0.0.1','http://127.0.0.1/path','http://127.0.0.1/?token=x'])assert.throws(()=>createProviderRefresh({origin}));
});
test('a brief failed lookup retains the measurement and analytics without inventing history',async t=>{
 const f=await fixture(t);let time=NOW,failed=false;
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async url=>{
  if(new URL(url).searchParams.get('provider')==='xai'){
   if(failed)throw new Error('upstream failed');
   return {ok:true,text:async()=>JSON.stringify({accounts:[{id:'g1',quota:quota(time,40+(time-NOW)/M)}]})};
  }
  return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
 }});
 for(let i=0;i<=3;i++){time=NOW+i*5*M;await monitor.collect();f.store.capture(monitor.enrich(f.snapshot()),time);}
 const before=monitor.enrich(f.snapshot()),p=before.providers[1],a=p.accounts[0];
 const analytics=windowAnalytics(f.store,p,a,a.windows[0],time);
 assert.ok(analytics.exhaustsAt);const count=f.store.points('xai','g1','weekly',0).length;
 failed=true;time+=10000;await monitor.collect();
 const after=monitor.enrich(f.snapshot()),actual=after.providers[1].accounts[0];
 assert.equal(actual.status,'ok');assert.equal(actual.windows[0].stale,false);
 assert.equal(actual.updatedAt,a.updatedAt);assert.deepEqual(actual.windows,a.windows);
 assert.equal(actual.refresh.status,'delayed');assert.equal(actual.refresh.lastAttemptAt,new Date(time).toISOString());
 assert.equal(windowAnalytics(f.store,after.providers[1],actual,actual.windows[0],time).exhaustsAt,analytics.exhaustsAt);
 f.store.capture(after,time);assert.equal(f.store.points('xai','g1','weekly',0).length,count);
 time=NOW+30*M+1;const expired=monitor.enrich(f.snapshot()).providers[1].accounts[0];
 assert.equal(expired.status,'stale');assert.equal(expired.windows[0].stale,true);
});
test('a failed lookup expires only windows whose reset passed and clears its delay after recovery',async t=>{
 const f=await fixture(t);let time=NOW,failed=false;
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async url=>({ok:true,text:async()=>JSON.stringify({accounts:new URL(url).searchParams.get('provider')==='xai'?[{id:'g1',quotaUnavailable:failed,quota:{...quota(time,49),fiveHourPercent:10,fiveHourResetAt:time+M}}]:[],keys:[]})})});
 await monitor.collect();time+=M;failed=true;await monitor.collect();
 let a=monitor.enrich(f.snapshot()).providers[1].accounts[0];
 assert.equal(a.status,'stale');assert.equal(a.refresh.status,'delayed');
 assert.equal(a.windows[0].stale,true);assert.equal(a.windows[1].stale,false);
 assert.equal(a.updatedAt,new Date(NOW).toISOString());
 failed=false;time+=10000;await monitor.collect();a=monitor.enrich(f.snapshot()).providers[1].accounts[0];
 assert.equal(a.status,'ok');assert.equal(a.refresh.status,'ok');assert.equal(a.updatedAt,new Date(time).toISOString());
});
test('recent legacy failed cache rows recover their measurement eligibility without a new timestamp',async t=>{
 const f=await fixture(t);let time=NOW,failed=false;
 const fetcher=async()=>{if(failed)throw new Error('offline');return {ok:true,text:async()=>JSON.stringify({accounts:[{id:'g1',quota:quota(time,49)}],keys:[]})};};
 let monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher});
 await monitor.collect();const key='providerLiveV1:xai:g1',old=f.store.get(key);
 f.store.set(key,{...old,status:'unavailable',windows:old.windows.map(w=>({...w,stale:true}))});
 failed=true;time+=M;monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher});await monitor.collect();
 const a=monitor.enrich(f.snapshot()).providers[1].accounts[0];
 assert.equal(a.status,'ok');assert.equal(a.windows[0].stale,false);assert.equal(a.refresh.status,'delayed');assert.equal(a.updatedAt,old.updatedAt);
});
test('every account refreshes, key quotas map exactly, inactive Claude and Fable remain distinct',async t=>{
 const f=await fixture(t),paths=[];
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>NOW,fetcher:async(url,opts)=>{
  paths.push(url);assert.equal(opts.redirect,'error');assert.ok(opts.headers.Authorization.startsWith('Bearer ocx_admin_'));
  const u=new URL(url);let body;
  if(u.pathname.includes('codex-auth'))body={accounts:['__main__','pool'].map(id=>({id,quota:quota(NOW,12)}))};
  else if(u.pathname.endsWith('/keys'))body={keys:[{id:createHash('sha256').update('PRIVATE_KEY').digest('hex').slice(0,8),masked:'PRIVATE_MASK',quota:quota(NOW,37),quotaMode:'probe'}]};
  else {const p=u.searchParams.get('provider');body={accounts:p==='anthropic'?[{id:'c1',needsReauth:true,quotaUnavailable:true,quota:quota(NOW-86400000,19)},{id:'c2',quota:{...quota(NOW,34),customWindows:[{label:'Fable',percent:24,resetAt:NOW+86400000}]}}]:[{id:p==='xai'?'g1':'u1',quota:quota(NOW,49)}]};}
  return {ok:true,text:async()=>JSON.stringify(body)};
 }});
 await monitor.collect();const s=monitor.enrich(f.snapshot());
 assert.equal(paths.length,5);assert.ok(paths.every(p=>!p.includes('ollama')));
 const anthropic=new URL(paths.find(p=>p.includes('provider=anthropic')));
 assert.equal(anthropic.searchParams.get('quota'),'1');assert.equal(anthropic.searchParams.get('refresh'),'1');
 assert.ok(paths.every(p=>p.includes('refresh=1')));
 assert.equal(s.providers[1].accounts[0].windows[0].usedPercent,49);
 assert.equal(s.providers[2].accounts[0].status,'reauth');assert.equal(s.providers[2].accounts[0].windows.length,0);
 assert.equal(s.providers[2].accounts[1].windows[1].label,'Fable');
 assert.equal(s.providers[4].accounts[0].id,'key:default');assert.equal(s.providers[4].accounts[0].windows[0].usedPercent,37);
 assert.ok(!JSON.stringify(s).includes('PRIVATE'));assert.ok(!JSON.stringify(f.store.db.prepare("SELECT value FROM meta WHERE key LIKE 'providerLiveV1:%'").all()).includes('PRIVATE'));
});
test('fresh Grok observations persist unchanged percentages and enable burn rate after five minutes',async t=>{
 const f=await fixture(t);let time=NOW,used=44,fail=false;
 const fetcher=async url=>{if(fail)throw new Error('SECRET_TOKEN');return {ok:true,text:async()=>JSON.stringify({accounts:url.includes('provider=xai')?[{id:'g1',quota:quota(time,used)}]:[] ,keys:[]})};};
 let monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher});
 for(let i=0;i<=5;i++){time=NOW+i*M;used=44+(i===5?1:0);await monitor.collect();f.store.capture(monitor.enrich(f.snapshot()),time);}
 let s=monitor.enrich(f.snapshot()),p=s.providers[1],a=p.accounts[0];
 // Unchanged readings are thinned to a four-minute heartbeat, so six collections
 // store three samples: the first, the heartbeat at four minutes, and the change.
 // The observed span, and therefore the burn rate below, is unaffected.
 const stored=f.store.points('xai','g1','weekly',0);
 assert.equal(stored.length,3);
 assert.equal(stored.at(-1).at-stored[0].at,5*M);
 assert.equal(windowAnalytics(f.store,p,a,a.windows[0],time).recentRatePpHour,12);
 const measured=a.updatedAt;fail=true;time+=M;monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher});await monitor.collect();s=monitor.enrich(f.snapshot());a=s.providers[1].accounts[0];
 assert.equal(a.status,'ok');assert.equal(a.refresh.status,'delayed');assert.equal(a.updatedAt,measured);assert.equal(a.windows[0].usedPercent,45);
 assert.equal(windowAnalytics(f.store,s.providers[1],a,a.windows[0],time).recentRatePpHour,12);
 assert.ok(!JSON.stringify(s).includes('SECRET_TOKEN'));
});

test('missing and invalid quota responses never restamp a last-good measurement',async t=>{
 const f=await fixture(t);let time=NOW,reply={id:'g1',quota:quota(NOW,49)};
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async()=>({ok:true,text:async()=>JSON.stringify({accounts:[reply],keys:[]})})});
 await monitor.collect();time+=M;reply={id:'g1',quota:{updatedAt:time,unexpected:49}};await monitor.collect();
 let a=monitor.enrich(f.snapshot()).providers[1].accounts[0];assert.equal(a.updatedAt,new Date(NOW).toISOString());assert.equal(a.windows[0].usedPercent,49);assert.equal(a.status,'ok');assert.equal(a.refresh.status,'delayed');
 time+=M;reply={id:'g1',needsReauth:true,quotaUnavailable:true,quota:quota(time,0)};await monitor.collect();
 a=monitor.enrich(f.snapshot()).providers[1].accounts[0];assert.equal(a.status,'reauth');assert.equal(a.updatedAt,new Date(NOW).toISOString());assert.equal(a.windows[0].usedPercent,49);
});

test('Anthropic polls every two minutes and backs off failed lookups without invalidating recent data',async t=>{
 const f=await fixture(t);let time=NOW,mode='ok';const paths=[];
 const fetcher=async url=>{
  const u=new URL(url),provider=u.searchParams.get('provider');
  if(provider==='anthropic'){
   paths.push(u);const unavailable=mode==='failed';
   return {ok:true,text:async()=>JSON.stringify({accounts:['c1','c2'].map((id,index)=>({id,quotaUnavailable:unavailable,quota:quota(time,40+index)})),keys:[]})};
  }
  return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
 };
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher});
 await monitor.collect();time+=2*M;mode='failed';await monitor.collect();
 let account=monitor.enrich(f.snapshot()).providers[2].accounts[0];assert.equal(account.status,'ok');assert.equal(account.refresh.status,'delayed');assert.equal(account.refresh.nextAttemptAt,new Date(NOW+4*M).toISOString());assert.equal(paths.length,2);
 time+=M;await monitor.collect();assert.equal(paths.length,2);
 time+=M;await monitor.collect();assert.equal(paths.length,3);
 for(let i=0;i<3;i++){time+=M;await monitor.collect();assert.equal(paths.length,3);}
 time+=M;await monitor.collect();assert.equal(paths.length,4);
 for(let i=0;i<7;i++){time+=M;await monitor.collect();assert.equal(paths.length,4);}
 time+=M;mode='ok';await monitor.collect();account=monitor.enrich(f.snapshot()).providers[2].accounts[0];assert.equal(paths.length,5);assert.equal(account.status,'ok');assert.ok(paths.every(path=>path.searchParams.get('refresh')==='1'));
 time+=M;await monitor.collect();assert.equal(paths.length,5);time+=M;await monitor.collect();assert.equal(paths.length,6);
});

test('a healthy Anthropic sibling does not trigger rapid retries of a failing account',async t=>{
 const f=await fixture(t);let time=NOW,calls=0;
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async url=>{
  if(new URL(url).searchParams.get('provider')==='anthropic'){calls++;return {ok:true,text:async()=>JSON.stringify({accounts:[{id:'c1',quotaUnavailable:true,quota:quota(time,40)},{id:'c2',quota:quota(time,41)}],keys:[]})};}
  return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
 }});
 await monitor.collect();time+=10000;await monitor.collect();assert.equal(calls,1);time=NOW+2*M;await monitor.collect();const accounts=monitor.enrich(f.snapshot()).providers[2].accounts;
 assert.equal(calls,2);assert.equal(accounts[0].status,'unavailable');assert.equal(accounts[1].status,'ok');assert.equal(accounts[0].refresh.status,'delayed');assert.equal(accounts[1].refresh.status,'ok');assert.equal(accounts[0].refresh.nextAttemptAt,new Date(NOW+6*M).toISOString());time+=2*M;await monitor.collect();assert.equal(calls,2);
});

test('a changed Anthropic identity bypasses a pending retry delay',async t=>{
 const f=await fixture(t);let time=NOW,mode='ok',calls=0;
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async url=>{
  if(new URL(url).searchParams.get('provider')==='anthropic'){
   calls++;const unavailable=mode==='failed';return {ok:true,text:async()=>JSON.stringify({accounts:['c1','c2'].map((id,index)=>({id,quotaUnavailable:unavailable,quota:quota(time,50+index)})),keys:[]})};
  }
  return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
 }});
 await monitor.collect();time+=2*M;mode='failed';await monitor.collect();
 const auth=JSON.parse(await (await import('node:fs/promises')).readFile(join(f.home,'auth.json'),'utf8'));auth.anthropic.accounts[0].credential={accountId:'replacement'};await writeFile(join(f.home,'auth.json'),JSON.stringify(auth));
 time+=M;mode='ok';await monitor.collect();assert.equal(calls,3);assert.equal(monitor.enrich(f.snapshot()).providers[2].accounts[0].windows[0].usedPercent,50);
});

test('a newer same-identity Anthropic cache reading is not hidden by an older unavailable probe',async t=>{
 const f=await fixture(t);let time=NOW,failed=false;
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async url=>{
  if(new URL(url).searchParams.get('provider')==='anthropic')return {ok:true,text:async()=>JSON.stringify({accounts:['c1','c2'].map(id=>({id,quotaUnavailable:failed,quota:quota(time,49)})),keys:[]})};
  return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
 }});
 await monitor.collect();time+=2*M;failed=true;await monitor.collect();
 const snapshot=f.snapshot(),account=snapshot.providers[2].accounts[0];account.status='ok';account.updatedAt=new Date(time).toISOString();account.windows=[{id:'weekly',label:'주간',usedPercent:75,remainingPercent:25,resetAt:new Date(NOW+86400000).toISOString(),stale:false}];account.quotaMode='observed';
 const result=monitor.enrich(snapshot).providers[2].accounts[0];assert.equal(result.status,'ok');assert.equal(result.windows[0].usedPercent,75);assert.equal(result.windows[0].stale,false);
});

test('explicit source reauthentication and paused states cannot be replaced by a cached measurement',async t=>{
 const f=await fixture(t);const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>NOW,fetcher:async url=>({ok:true,text:async()=>JSON.stringify({accounts:new URL(url).searchParams.get('provider')==='anthropic'?[{id:'c1',quota:quota(NOW,49)},{id:'c2',quota:quota(NOW,50)}]:[],keys:[]})})});
 await monitor.collect();
 for(const status of ['reauth','paused']){
  const snapshot=f.snapshot(),account=snapshot.providers[2].accounts[0];account.status=status;account.updatedAt=null;account.windows=[];
  assert.equal(monitor.enrich(snapshot).providers[2].accounts[0].status,status);
 }
});

test('a newer healthy observation after reauthentication replaces the older saved login failure',async t=>{
 const f=await fixture(t);let time=NOW,failed=false;
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async url=>{
  if(new URL(url).searchParams.get('provider')==='anthropic')return {ok:true,text:async()=>JSON.stringify({accounts:['c1','c2'].map(id=>({id,needsReauth:failed,quotaUnavailable:failed,quota:quota(time,49)})),keys:[]})};
  return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
 }});
 await monitor.collect();time+=2*M;failed=true;await monitor.collect();
 const snapshot=f.snapshot(),account=snapshot.providers[2].accounts[0];account.status='ok';account.updatedAt=new Date(time).toISOString();account.windows=[{id:'weekly',label:'주간',usedPercent:75,remainingPercent:25,resetAt:new Date(NOW+86400000).toISOString(),stale:false}];account.quotaMode='observed';
 const result=monitor.enrich(snapshot).providers[2].accounts[0];assert.equal(result.status,'ok');assert.equal(result.windows[0].usedPercent,75);assert.equal(result.windows[0].stale,false);
});

test('a failed batch write rolls back every quota update and reports a refresh failure',async t=>{
 const f=await fixture(t);let time=NOW,used=40;
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async url=>({ok:true,text:async()=>JSON.stringify({accounts:new URL(url).searchParams.get('provider')==='anthropic'?['c1','c2'].map(id=>({id,quota:quota(time,used)})):[],keys:[]})})});
 await monitor.collect();
 const before=f.store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'providerLiveV1:%' ORDER BY key").all();
 const set=f.store.set;let writes=0;
 f.store.set=(...args)=>{if(++writes===2)throw new Error('simulated storage failure');return set(...args);};
 time+=2*M;used=80;await monitor.collect();
 assert.equal(writes,2);assert.equal(f.store.db.isTransaction,false);
 assert.deepEqual(f.store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'providerLiveV1:%' ORDER BY key").all(),before);
 const result=monitor.enrich(f.snapshot());
 for(const a of result.providers[2].accounts){assert.equal(a.windows[0].usedPercent,40);assert.equal(a.status,'ok');assert.equal(a.refresh.status,'delayed');}
 assert.equal(result.warnings.length,1);
 f.store.set=set;
});

test('a pending refresh retains its published measurement until the completed result replaces it',async t=>{
 const f=await fixture(t);let time=NOW,mode='initial',resolveFetch,started;
 const fetchStarted=new Promise(resolve=>{started=resolve;});
 const response=used=>({ok:true,text:async()=>JSON.stringify({accounts:[{id:'g1',quota:quota(time,used)}],keys:[]})});
 const fetcher=async url=>{
  if(new URL(url).searchParams.get('provider')!=='xai')return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
  if(mode==='pending'){started();return new Promise(resolve=>{resolveFetch=()=>resolve(response(50));});}
  if(mode==='failed')throw new Error('offline');
  return response(49);
 };
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher});
 await monitor.collect();
 let account=monitor.enrich(f.snapshot()).providers[1].accounts[0];assert.equal(account.status,'ok');assert.equal(account.windows[0].usedPercent,49);
 time+=M;mode='pending';const pending=monitor.collect();await fetchStarted;
 account=monitor.enrich(f.snapshot()).providers[1].accounts[0];assert.equal(account.status,'ok');assert.equal(account.windows[0].usedPercent,49);assert.equal(account.windows[0].stale,false);
 resolveFetch();await pending;
 account=monitor.enrich(f.snapshot()).providers[1].accounts[0];assert.equal(account.status,'ok');assert.equal(account.windows[0].usedPercent,50);
 time+=2*M;mode='failed';await monitor.collect();
 account=monitor.enrich(f.snapshot()).providers[1].accounts[0];assert.equal(account.status,'ok');assert.equal(account.refresh.status,'delayed');assert.equal(account.windows[0].usedPercent,50);
});

test('a refresh retains an API-key measurement before the next roster finishes loading',async t=>{
 const f=await fixture(t);let time=NOW;
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async url=>{
  if(new URL(url).pathname.endsWith('/keys'))return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[{id:createHash('sha256').update('PRIVATE_KEY').digest('hex').slice(0,8),quota:quota(time,37)}]})};
  return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
 }});
 await monitor.collect();assert.equal(monitor.enrich(f.snapshot()).providers[4].accounts[0].windows[0].usedPercent,37);
 time+=M;const pending=monitor.collect();
 assert.equal(monitor.enrich(f.snapshot()).providers[4].accounts[0].windows[0].usedPercent,37);
 await pending;
});

test('an expired published measurement remains stale while a refresh is pending',async t=>{
 const f=await fixture(t);let time=NOW,resolveFetch,started;
 const fetchStarted=new Promise(resolve=>{started=resolve;});
 const response=()=>({ok:true,text:async()=>JSON.stringify({accounts:[{id:'g1',quota:quota(NOW,49)}],keys:[]})});
 const fetcher=async url=>{
  if(new URL(url).searchParams.get('provider')!=='xai')return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
  if(time>NOW){started();return new Promise(resolve=>{resolveFetch=()=>resolve(response());});}
  return response();
 };
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher});
 await monitor.collect();time=NOW+15*M+1;const pending=monitor.collect();await fetchStarted;
 const account=monitor.enrich(f.snapshot()).providers[1].accounts[0];assert.equal(account.status,'stale');assert.equal(account.windows[0].stale,true);
 resolveFetch();await pending;
});

test('overlapping refreshes share one in-flight provider request',async t=>{
 const f=await fixture(t);let calls=0,resolveFetch,started;
 const fetchStarted=new Promise(resolve=>{started=resolve;});
 const fetcher=async url=>{
  if(new URL(url).searchParams.get('provider')!=='xai')return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
  calls++;started();return new Promise(resolve=>{resolveFetch=()=>resolve({ok:true,text:async()=>JSON.stringify({accounts:[{id:'g1',quota:quota(NOW,49)}],keys:[]})});});
 };
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>NOW,fetcher});
 const first=monitor.collect();await fetchStarted;const second=monitor.collect();assert.equal(first,second);assert.equal(calls,1);
 resolveFetch();await first;
});

test('one failed provider does not stop others; rotated API keys cannot reuse old quota',async t=>{
 const f=await fixture(t);let time=NOW,failGrok=false,keyValue='PRIVATE_KEY';
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async url=>{
  const u=new URL(url),p=u.searchParams.get('provider');
  if(failGrok&&(p==='xai'||u.pathname.endsWith('/keys')))throw new Error('offline');
  const body=u.pathname.endsWith('/keys')?{keys:[{id:createHash('sha256').update(keyValue).digest('hex').slice(0,8),quota:quota(time,37)}]}:{accounts:p==='xai'?[{id:'g1',quota:quota(time,49)}]:p==='cursor'?[{id:'u1',quota:quota(time,18)}]:[]};
  return {ok:true,text:async()=>JSON.stringify(body)};
 }});
 await monitor.collect();time+=M;failGrok=true;keyValue='NEW_PRIVATE_KEY';
 const {readFile}=await import('node:fs/promises');const config=JSON.parse(await readFile(join(f.home,'config.json'),'utf8'));config.providers['opencode-go'].apiKey=keyValue;await writeFile(join(f.home,'config.json'),JSON.stringify(config));
 await monitor.collect();const s=monitor.enrich(f.snapshot());
 assert.equal(s.providers[1].accounts[0].status,'ok');assert.equal(s.providers[1].accounts[0].refresh.status,'delayed');assert.equal(s.providers[1].accounts[0].updatedAt,new Date(NOW).toISOString());
 assert.equal(s.providers[3].accounts[0].status,'ok');assert.equal(s.providers[3].accounts[0].updatedAt,new Date(time).toISOString());
 assert.equal(s.providers[4].accounts[0].windows.length,0);
});

test('a pending refresh does not attach a prior reading after an API key rotates',async t=>{
 const f=await fixture(t);let time=NOW,keyValue='PRIVATE_KEY',resolveFetch,started;
 const fetchStarted=new Promise(resolve=>{started=resolve;});
 const keyResponse=()=>({ok:true,text:async()=>JSON.stringify({accounts:[],keys:[{id:createHash('sha256').update(keyValue).digest('hex').slice(0,8),quota:quota(time,keyValue==='NEW_PRIVATE_KEY'?38:37)}]})});
 const fetcher=async url=>{
  if(!new URL(url).pathname.endsWith('/keys'))return {ok:true,text:async()=>JSON.stringify({accounts:[],keys:[]})};
  if(keyValue==='NEW_PRIVATE_KEY'){started();return new Promise(resolve=>{resolveFetch=()=>resolve(keyResponse());});}
  return keyResponse();
 };
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher});
 await monitor.collect();assert.equal(monitor.enrich(f.snapshot()).providers[4].accounts[0].windows[0].usedPercent,37);
 keyValue='NEW_PRIVATE_KEY';const config=JSON.parse(await (await import('node:fs/promises')).readFile(join(f.home,'config.json'),'utf8'));config.providers['opencode-go'].apiKey=keyValue;await writeFile(join(f.home,'config.json'),JSON.stringify(config));
 const pending=monitor.collect();await fetchStarted;
 const account=monitor.enrich(f.snapshot()).providers[4].accounts[0];assert.equal(account.windows.length,0);
 resolveFetch();await pending;
 assert.equal(monitor.enrich(f.snapshot()).providers[4].accounts[0].windows[0].usedPercent,38);
});

test('excluded OAuth and API-key providers are not requested and keep their snapshot fields',async t=>{
 const f=await fixture(t),paths=[],reads=[],writes=[];
 const get=f.store.get,set=f.store.set;
 f.store.get=(...args)=>{reads.push(args[0]);return get(...args);};
 f.store.set=(...args)=>{writes.push(args[0]);return set(...args);};
 const snapshot=f.snapshot(),openai=JSON.parse(JSON.stringify(snapshot.providers[0])),anthropic=JSON.parse(JSON.stringify(snapshot.providers[2])),go=JSON.parse(JSON.stringify(snapshot.providers[4]));
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>NOW,excludeProviders:['openai','anthropic','opencode-go'],fetcher:async url=>{
  paths.push(url);
  const u=new URL(url),p=u.searchParams.get('provider');
  return {ok:true,text:async()=>JSON.stringify(u.pathname.endsWith('/keys')?{keys:[{id:createHash('sha256').update('PRIVATE_KEY').digest('hex').slice(0,8),quota:quota(NOW,37)}]}:{accounts:[{id:p==='xai'?'g1':'u1',quota:quota(NOW,49)}],keys:[]})};
 }});
 await monitor.collect();
 assert.ok(paths.length>=1);
 assert.ok(paths.every(p=>!p.includes('codex-auth')&&!p.includes('anthropic')&&!p.includes('opencode-go')&&!p.includes('/keys')));
 assert.ok(paths.some(p=>p.includes('provider=xai')));
 const owned=k=>typeof k==='string'&&(k.includes(':openai:')||k.includes(':anthropic:')||k.includes(':opencode-go:'));
 assert.ok(!reads.some(owned));assert.ok(!writes.some(owned));
 const s=monitor.enrich(snapshot);
 assert.deepEqual(s.providers[0],openai);assert.deepEqual(s.providers[2],anthropic);assert.deepEqual(s.providers[4],go);
 assert.equal(s.providers[0].accounts[0].refresh,undefined);
 assert.equal(s.providers[1].accounts[0].windows[0].usedPercent,49);
});

test('a one-provider collector does not mark another provider stale',async t=>{
 const f=await fixture(t);let time=NOW;
 const seed=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,fetcher:async url=>{
  const p=new URL(url).searchParams.get('provider');
  return {ok:true,text:async()=>JSON.stringify({accounts:p==='anthropic'?['c1','c2'].map(id=>({id,quota:quota(time,41)})):p==='xai'?[{id:'g1',quota:quota(time,40)}]:[],keys:[]})};
 }});
 await seed.collect();
 const before=f.store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'providerLiveV1:anthropic:%' ORDER BY key").all();
 time=NOW+15*M+1;const paths=[],reads=[],writes=[];
 const get=f.store.get,set=f.store.set;
 f.store.get=(...args)=>{reads.push(args[0]);return get(...args);};
 f.store.set=(...args)=>{writes.push(args[0]);return set(...args);};
 const monitor=createProviderRefresh({...f,origin:'http://127.0.0.1:10104',now:()=>time,includeProviders:['xai'],excludeProviders:['anthropic','opencode-go'],fetcher:async url=>{
  paths.push(url);return {ok:true,text:async()=>JSON.stringify({accounts:[{id:'g1',quota:quota(time,42)}],keys:[]})};
 }});
 await monitor.collect();
 assert.equal(paths.length,1);assert.ok(paths[0].includes('provider=xai'));
 assert.ok(reads.every(k=>!String(k).includes(':anthropic:')&&!String(k).includes(':opencode-go:')));
 assert.ok(writes.every(k=>!String(k).includes(':anthropic:')&&!String(k).includes(':opencode-go:')));
 assert.deepEqual(f.store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'providerLiveV1:anthropic:%' ORDER BY key").all(),before);
 const snapshot=f.snapshot(),account=snapshot.providers[2].accounts[0];
 account.status='ok';account.updatedAt=new Date(NOW).toISOString();account.windows=[{id:'weekly',label:'주간',usedPercent:41,remainingPercent:59,resetAt:new Date(NOW+86400000).toISOString(),stale:false}];account.quotaMode='observed';
 const untouched=JSON.parse(JSON.stringify(account));
 const result=monitor.enrich(snapshot);
 assert.deepEqual(result.providers[2].accounts[0],untouched);
 assert.equal(result.providers[2].accounts[0].status,'ok');
 assert.equal(result.providers[2].accounts[0].windows[0].stale,false);
 assert.equal(result.providers[2].accounts[0].refresh,undefined);
 assert.equal(result.providers[1].accounts[0].windows[0].usedPercent,42);
 assert.equal(result.providers[1].accounts[0].status,'ok');
});
