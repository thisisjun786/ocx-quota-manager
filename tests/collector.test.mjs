import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,readFile,cp} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createApp} from '../src/server.mjs';
import {openHistory} from '../src/history.mjs';
import {createCollector} from '../src/collector.mjs';
import {createModelRoster} from '../src/model-roster.mjs';
import {buildFixture} from '../scripts/ui-fixture.mjs';
import {MODEL_EXCLUSIONS} from '../src/snapshot.mjs';
import {rename} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
test('a configured credential is a secret under every provider, and real OCX ids survive',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-crosskey-')),catalogPath=join(dir,'models.json');
 const now=Date.parse('2026-09-14T14:00:00Z');
 // Distinct keys per provider. Reusing one sentinel everywhere hides exactly the
 // per-provider scoping bug this test exists to catch.
 const alpha='SYNTHETIC_KEY_ALPHA',beta='SYNTHETIC_KEY_BETA',gamma='SYNTHETIC_KEY_GAMMA';
 // A key hides inside a longer string just as well as it sits alone.
 const composite='vendor/'+alpha;
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{
  anthropic:{apiKey:alpha,models:[alpha,'claude-opus-5']},
  cursor:{apiKey:beta,models:[beta,alpha,composite,`${alpha}[1m]`,`vendor/${alpha}:latest`,'grok-4.6'],
   defaultModel:`${alpha}[1m]`,
   apiKeyPool:[{id:'p',key:beta,label:'backup '+alpha}]},
  google:{apiKeyPool:[{id:'pool',key:gamma,label:gamma}],models:['gemini-3.8-flash']},
  short:{apiKey:'sk-1234',models:['vendor/sk-1234','glm-5.3'],apiKeyPool:[{id:'q',key:'sk-1234',label:'backup sk-1234'}]},
  // A key that is only a name fragment of ordinary models must not delete them.
  fragment:{apiKey:'gpt',models:['gpt-5.6-luna','gpt-6-astra','gpt'],defaultModel:'gpt-5.6-luna'},
  // A longer key can also be the opening of a real model name.
  vertex:{apiKey:'gemini-3',models:['gemini-3.8-flash','gemini-3'],defaultModel:'gemini-3.8-flash'},
  kimi:{models:['k3','k3[1m]','glm-5.3[1m]',
   'C:/Users/Jun[1]/.opencodex/api-key','~root/[private]','[private]','..[1m]','[]',
   'C:/secret[1m]','~root/secret[1m]','C:secret[1m]','C:.env[1]',
   '~jun/.opencodex/config.json','~/.opencodex/x','.opencodex/config.json','a/.b/c','~a/b/c','~a',
   '~anthropic/claude-opus-latest'],
   defaultModel:'/home/private/.opencodex/api-key'},
 }}));
 await writeFile(join(dir,'auth.json'),'{}');
 const call=(id,provider,model)=>JSON.stringify({requestId:id,timestamp:now-1000,provider,model,
  usageStatus:'reported',usage:{inputTokens:1,outputTokens:1}});
 await writeFile(join(dir,'usage.jsonl'),[call('observed-key','cursor',alpha),call('observed-composite','cursor',composite),
  call('observed-decorated','cursor',`vendor/${alpha}:latest`),call('observed-path','kimi','~jun/.opencodex/config.json'),
  call('configured-and-observed','kimi','k3[1m]'),call('observed-only','kimi','claude-opus-4-8[1m]')].join('\n')+'\n');
 const collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),catalogPath,now:()=>now});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 await collector.collect();const snapshot=await collector.snapshot();
 const at=id=>snapshot.providers.find(p=>p.id===id);
 const body=JSON.stringify(snapshot);
 // A key is a secret wherever it appears, not only inside the provider that declares it.
 for(const secret of [alpha,beta,gamma])assert.equal(body.includes(secret),false,secret);
 // The default selector is published as a model name and passes the same two checks.
 assert.equal(at('cursor').defaultModel,null);
 assert.equal(at('kimi').defaultModel,null);
 assert.equal(body.includes('/home/private'),false);
 // A pooled key used as its own label falls back to the generic account name.
 assert.ok(at('google').accounts.some(a=>a.id==='key:pool'&&a.label==='API 계정 1'));
 assert.deepEqual(at('anthropic').supportedModels,['claude-opus-5']);
 assert.deepEqual(at('cursor').supportedModels,['grok-4.6']);
 assert.equal(body.includes(composite),false);
 // A known key wearing model syntax leaves all three discovery paths: the configured
 // list, the default selector, and a row seen only in the usage log.
 for(const shape of [`${alpha}[1m]`,`vendor/${alpha}:latest`]){
  assert.equal(body.includes(shape),false,shape);
  assert.equal(at('cursor').supportedModels.includes(shape),false,shape);
  assert.equal(at('cursor').analytics.modelPrices.some(p=>p.model===shape),false,shape);
  assert.equal(at('cursor').analytics.unpricedModels.some(m=>m.model===shape),false,shape);
 }
 assert.equal(at('cursor').defaultModel,null);
 assert.deepEqual(at('cursor').accounts.filter(a=>a.id==='key:p').map(a=>a.label),['API 계정 1']);
 // A bracketed marker belongs to a model id, not to a path. Allowing it must not
 // readmit a Windows absolute path, a named-user home, or an empty base.
 for(const shape of ['C:/Users/Jun[1]/.opencodex/api-key','~root/[private]','[private]','..[1m]','[]',
  'C:/secret[1m]','~root/secret[1m]','C:secret[1m]','C:.env[1]',
  '~jun/.opencodex/config.json','~/.opencodex/x','.opencodex/config.json','a/.b/c','~a/b/c','~a'])
  assert.equal(at('kimi').supportedModels.includes(shape),false,shape);
 // The same path must not arrive through the usage log either.
 assert.equal(body.includes('~jun/.opencodex/config.json'),false);
 // The catalog's leading-tilde alias is a real id and stays.
 assert.ok(at('kimi').supportedModels.includes('~anthropic/claude-opus-latest'));
 // A colon tag is a real id shape, so the drive-letter rule must be the narrow one.
 assert.ok(at('kimi').supportedModels.includes('k3[1m]'));
 assert.deepEqual(at('fragment').supportedModels,['gpt-5.6-luna','gpt-6-astra']);
 assert.equal(at('fragment').defaultModel,'gpt-5.6-luna');
 assert.deepEqual(at('vertex').supportedModels,['gemini-3.8-flash']);
 assert.equal(at('vertex').defaultModel,'gemini-3.8-flash');
 // A short key is still a key. It is matched as a complete token so that a
 // one-character key cannot erase every model whose name merely starts with it.
 assert.equal(body.includes('sk-1234'),false);
 assert.deepEqual(at('short').supportedModels,['glm-5.3']);
 assert.deepEqual(at('short').accounts.filter(a=>a.id==='key:q').map(a=>a.label),['API 계정 1']);
 // Installed OCX 2.55.0 registers k3[1m], glm-5.3[1m] and claude-*[1m]. A bracketed id
 // is a real model; the Kimi tariff now preserves its OCX reference price.
 assert.deepEqual(at('kimi').supportedModels,['k3','k3[1m]','glm-5.3[1m]','~anthropic/claude-opus-latest']);
 const kimi=Object.fromEntries(at('kimi').analytics.modelPrices.map(r=>[r.model,r]));
 assert.deepEqual(kimi['k3[1m]'].sources,['ocx-config','observed']);
 assert.equal(kimi['k3[1m]'].status,'ocx-provided');
 assert.deepEqual(kimi['k3[1m]'].rates,{input:3,output:15,cacheRead:.3,cacheWrite:null});
 assert.equal(typeof kimi['k3[1m]'].reason,'string');
 assert.deepEqual(kimi['claude-opus-4-8[1m]'].sources,['observed']);
 assert.equal(at('kimi').analytics.unpricedModels.some(m=>m.model==='k3[1m]'),false);
 assert.equal(kimi['claude-opus-4-8[1m]'].status,'unpriced');
});
test('every configured and observed model keeps a listed price record, and no secret rides along',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-prices-')),catalogPath=join(dir,'models.json');
 const now=Date.parse('2026-09-11T12:30:00Z');
 await writeFile(join(dir,'config.json'),JSON.stringify({
  providers:{
   anthropic:{apiKey:'SECRET_SENTINEL',models:['claude-opus-5','claude-sonnet-5','never-published-model',
    'claude-sonnet-4@20250514','Pro/deepseek-ai/DeepSeek-V3','~anthropic/claude-opus-latest',
    '/home/private/.opencodex/api-key','../../etc/passwd','has space','../secret','./config.json',
    '~/.opencodex/api-key','SECRET_SENTINEL'],
    defaultModel:'claude-sonnet-5'},
   'opencode-go':{apiKey:'SECRET_SENTINEL',models:['kimi-k2.7-code','deepseek-flash','deepseek/deepseek-v4-flash','a/b/c/d/e/f'],defaultModel:'kimi-k2.7-code'},
   cursor:{apiKeyPool:[{id:'pool',key:'POOLED_SENTINEL'}],apiKey:'SECRET_SENTINEL'},
 },
 disabledModels:['anthropic/claude-sonnet-5','opencode-go/deepseek/deepseek-v4-flash','opencode-go/a/b/c/d/e/f'],
 }));
 await writeFile(join(dir,'auth.json'),'{}');
 const call=(id,provider,model)=>JSON.stringify({requestId:id,timestamp:now-1000,provider,model,
  usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}});
 await writeFile(join(dir,'usage.jsonl'),[call('seen','opencode-go','glm-5.3'),
  call('path','anthropic','/home/private/.opencodex/api-key'),call('home','anthropic','~/.opencodex/api-key'),
  call('up','anthropic','../../etc/passwd'),call('key','cursor','SECRET_SENTINEL'),
  call('pool','cursor','POOLED_SENTINEL'),call('real','cursor','grok-4.6')].join('\n')+'\n');
 await writeFile(catalogPath,JSON.stringify({anthropic:{models:{'never-published-model':{cost:{input:0,output:0}}}}}));
 const collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),catalogPath,now:()=>now});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 await collector.collect();const snapshot=await collector.snapshot();
 const priced=id=>Object.fromEntries(snapshot.providers.find(p=>p.id===id).analytics.modelPrices.map(r=>[r.model,r]));
 const anthropic=priced('anthropic');
 // A provider-qualified disable removes only that provider's model.
 assert.equal('claude-sonnet-5' in anthropic,false);
 assert.equal(anthropic['claude-opus-5'].status,'official');
 assert.equal(anthropic['claude-opus-5'].rates.input,5);
 assert.equal(anthropic['claude-opus-5'].checkedAt,'2026-09-15');
 // No public price is a listed state with a reason, not a disappearance. An all-zero
 // catalog row is rejected upstream, so this model stays genuinely unpriced.
 const missing=anthropic['never-published-model'];
 assert.equal(missing.status,'unpriced');
 assert.deepEqual(missing.rates,{input:null,output:null,cacheRead:null,cacheWrite:null});
 assert.equal(typeof missing.reason,'string');
 assert.deepEqual(missing.sources,['ocx-config']);
 assert.equal(missing.unit,'usd-per-million-tokens');
 // A model ID is an ID, not an arbitrary string: neither a path nor a credential can be
 // published as one, whatever the credential happens to look like.
 for(const shape of ['/home/private/.opencodex/api-key','../../etc/passwd','has space','../secret','./config.json','~/.opencodex/api-key','SECRET_SENTINEL'])
  assert.equal(shape in anthropic,false,shape);
 // Real IDs carry namespaces and version suffixes and must survive that filter.
 assert.equal(anthropic['claude-sonnet-4@20250514'].status,'unpriced');
 assert.equal(anthropic['Pro/deepseek-ai/DeepSeek-V3'].status,'unpriced');
 // A bare tilde is a home reference; the catalog's alias marker carries its vendor.
 assert.equal(anthropic['~anthropic/claude-opus-latest'].status,'unpriced');
 // A recorded name passes the same gate as a configured one: the usage log belongs to
 // another product, so a path in its model field is not republished as a model.
 for(const shape of ['/home/private/.opencodex/api-key','~/.opencodex/api-key','../../etc/passwd'])
  assert.equal(shape in anthropic,false,'observed '+shape);
 // Configuration and the usage log are separate discovery sources and stay separate.
 const go=priced('opencode-go');
 assert.deepEqual(go['kimi-k2.7-code'].sources,['ocx-config']);
 assert.deepEqual(go['glm-5.3'].sources,['observed']);
 assert.equal(go['glm-5.3'].requests,1);
 assert.equal(go['glm-5.3'].status,'official');
 assert.equal(go['glm-5.3'].providerBasis,'attributed');
 // Priced as of the snapshot instant. Without a timestamp this peak-scheduled model
 // would be listed as unpriced even though it has a valid current rate.
 assert.equal(go['deepseek-flash'].status,'official');
 assert.equal(go['deepseek-flash'].rates.input,.15);
 assert.ok(go['deepseek-flash'].conditions.includes('peak-hours'));
 // A disable entry qualifies a vendor-prefixed model with its provider, so it has more
 // than one separator and must still match.
 assert.equal('deepseek/deepseek-v4-flash' in go,false);
 // Qualification must not consume the model's own segment allowance.
 assert.equal('a/b/c/d/e/f' in go,false);
 assert.ok(snapshot.analytics.modelPriceConditions['long-context'].length>0);
 // A recorded name that is character-identical to a model ID is still refused when it
 // is a key this configuration holds. Only its value can tell them apart.
 const cursor=priced('cursor');
 assert.equal('SECRET_SENTINEL' in cursor,false);
 assert.equal('POOLED_SENTINEL' in cursor,false);
 assert.equal(cursor['grok-4.6'].status,'official');
 assert.deepEqual(snapshot.providers.find(p=>p.id==='cursor').analytics.unpricedModels,[]);
 const body=JSON.stringify(snapshot);
 assert.equal(body.includes('SECRET_SENTINEL'),false);
 assert.equal(body.includes('POOLED_SENTINEL'),false);
 assert.equal(body.includes('/etc/passwd'),false);
 for(const secret of [dir,catalogPath,'models.json','usage.jsonl','.opencodex','/home/'])assert.equal(body.includes(secret),false,secret);
});
test('collector reprices a newly cataloged model without restart and exposes missing-model diagnostics',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-catalog-')),catalogPath=join(dir,'models.json');
 const now=Date.parse('2026-09-10T12:30:00Z');
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'opencode-go':{apiKey:'synthetic-key'}}}));
 await writeFile(join(dir,'auth.json'),'{}');
 await writeFile(join(dir,'usage.jsonl'),JSON.stringify({requestId:'new-model',timestamp:now,provider:'opencode-go',model:'next-model',usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100,cachedInputTokens:0}})+'\n');
 const collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),catalogPath,now:()=>now});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 await collector.collect();let snapshot=await collector.snapshot();
 const go=s=>s.providers.find(p=>p.id==='opencode-go').analytics;
 assert.deepEqual(go(snapshot).unpricedModels,[{model:'next-model',requests:1}]);assert.equal(snapshot.analytics.pricingCatalog.status,'missing');
 await writeFile(catalogPath,JSON.stringify({'opencode-go':{models:{'next-model':{cost:{input:2,output:4,cache_read:.2}}}}}));
 await collector.collect();snapshot=await collector.snapshot();
 assert.equal(go(snapshot).periods.weekly.requests,1);assert.equal(go(snapshot).periods.weekly.apiUsd,.0024);
 assert.equal(go(snapshot).periods.weekly.localPriceRequests,1);assert.deepEqual(go(snapshot).unpricedModels,[]);
 assert.equal(snapshot.analytics.pricingCatalog.status,'ok');assert.equal(JSON.stringify(snapshot).includes('synthetic-key'),false);
});
test('timer collects with no browser; source files stay intact and restart retains history',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-')),native=join(dir,'native'),dataDir=join(dir,'state');await mkdir(native);
 let now=1800000000000;
 const files={'config.json':{providers:{openai:{}},codexAccounts:[{id:'pool',logLabel:'pabcdef',plan:'pro'}]},'auth.json':{},'codex-accounts.json':{pool:{credential:{accessToken:'PRIVATE_SENTINEL'}}},'codex-quota-cache.json':{version:1,quotas:{pool:{updatedAt:now,weeklyPercent:10,weeklyResetAt:now/1000+86400}}},'provider-account-quota-cache.json':{version:1,rows:{}}};
 for(const [name,value]of Object.entries(files))await writeFile(join(dir,name),JSON.stringify(value));await writeFile(join(native,'auth.json'),'{}');
 await writeFile(join(dir,'usage.jsonl'),JSON.stringify({requestId:'one',timestamp:now-1000,provider:'openai-pabcdef',model:'gpt-6-astra',usageStatus:'reported',usage:{inputTokens:100000,outputTokens:1000}})+'\n');
 const opts={home:dir,codexHome:native,dataDir,now:()=>now,intervalMs:20};
 let collector=await createCollector(opts);t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});await collector.start();
 const initial=await collector.snapshot();assert.equal(initial.providers[0].accounts[1].analytics.periods.weekly.apiUsd,1.05);
 now+=60000;files['codex-quota-cache.json'].quotas.pool.updatedAt=now;files['codex-quota-cache.json'].quotas.pool.weeklyPercent=12;await writeFile(join(dir,'codex-quota-cache.json'),JSON.stringify(files['codex-quota-cache.json']));
 // Observe a timer-owned collection, without invoking collect or an HTTP/browser route.
 const deadline=Date.now()+2000;let next;
 while(Date.now()<deadline){next=await collector.snapshot();if(next.analytics.lastCollectedAt===new Date(now).toISOString())break;await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(next.analytics.lastCollectedAt,new Date(now).toISOString());
 await collector.close();collector=await createCollector(opts);await collector.start();
 const restored=await collector.snapshot();assert.equal(restored.analytics.historyStartedAt,initial.analytics.historyStartedAt);
 assert.equal(restored.providers[0].accounts[1].analytics.periods.weekly.apiUsd,1.05);assert.equal(restored.providers[0].accounts[1].windows[0].analytics.history.length,2);
 assert.equal(JSON.stringify(restored).includes('PRIVATE_SENTINEL'),false);
 const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(dir,'codex-accounts.json'),'utf8'),JSON.stringify(files['codex-accounts.json']));
});

test('collector usage-read failure preserves demand and matches capacity only through the last read',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-failure-')),native=join(dir,'native');await mkdir(native);
 const base=1800000000000,minute=60000;let now=base;
 const quota=()=>({version:1,quotas:{pool:{updatedAt:now,weeklyPercent:(now-base)/minute,weeklyResetAt:base+86400000}}});
 const files={'config.json':{providers:{openai:{}},codexAccounts:[{id:'pool',logLabel:'pabcdef',plan:'pro'}]},'auth.json':{},'codex-accounts.json':{pool:{credential:{accessToken:'PRIVATE_SENTINEL'}}},'codex-quota-cache.json':quota(),'provider-account-quota-cache.json':{version:1,rows:{}}};
 for(const [name,value]of Object.entries(files))await writeFile(join(dir,name),JSON.stringify(value));await writeFile(join(native,'auth.json'),'{}');
 const entry=(id,at)=>({requestId:id,timestamp:at,provider:'openai-pabcdef',model:'gpt-6-astra',usageStatus:'reported',usage:{inputTokens:100000,outputTokens:0}});
 const usage=join(dir,'usage.jsonl');await writeFile(usage,JSON.stringify(entry('older',base-2*86400000))+'\n');
 const collector=await createCollector({home:dir,codexHome:native,dataDir:join(dir,'state'),now:()=>now});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 await collector.collect();
 now=base+10*minute;await writeFile(join(dir,'codex-quota-cache.json'),JSON.stringify(quota()));
 await writeFile(usage,[entry('older',base-2*86400000),entry('matched',base+5*minute)].map(JSON.stringify).join('\n')+'\n');
 await collector.collect();const before=await collector.snapshot();
 now=base+20*minute;await writeFile(join(dir,'codex-quota-cache.json'),JSON.stringify(quota()));await rename(usage,join(dir,'usage-unavailable.jsonl'));
 await collector.collect();const after=await collector.snapshot();
 assert.equal(after.analytics.status,'error');assert.equal(after.analytics.usageObservedAt,new Date(base+10*minute).toISOString());
 const previous=before.providers[0].analytics,current=after.providers[0].analytics;
 assert.equal(current.pace.usdPerHour,previous.pace.usdPerHour);assert.equal(current.pace.stale,true);
 assert.equal(current.recommendation.weeklyDemandApiUsd,previous.recommendation.weeklyDemandApiUsd);
 assert.equal(current.recommendation.usageStale,true);assert.equal(current.recommendation.status,'provisional');
const value=after.providers[0].accounts[1].windows[0].analytics;
assert.equal(value.capacityApiUsd,10);assert.equal(value.capacityObservedAt,new Date(base+10*minute).toISOString());assert.equal(value.capacityBasis,'partial');assert.equal(value.unexplainedDeltaPp,0);
});

// --- JUN-53: 고장을 겪은 뒤 API 가 같은 네 대상을 다시 내놓는가 ---------------------------
// 기준선은 두 번 수집한 뒤에 잡는다. 로스터 기록이 사용량 적재보다 먼저 돌기 때문에 첫 수집 뒤에는
// 모델의 sources 가 아직 ocx-config 뿐이고 두 번째 수집에서 observed 가 붙는다. 그 정상적인 변화를
// 보존 실패로 읽지 않으려면 정착시킨 뒤에 찍어야 한다.
const pick=(o,keys)=>Object.fromEntries(keys.map(k=>[k,o?.[k]??null]));
const PERIOD=['requests','tokens','apiUsd','pricedRequests','unknownPriceRequests'];
const preserved=body=>{
 const p=body.providers.find(x=>x.id==='openai');
 const account=p.accounts.find(a=>a.windows?.length)??p.accounts[0];
 const roster=p.analytics.modelRoster;
 return {
  usage:{weekly:pick(p.analytics.periods.weekly,PERIOD),monthly:pick(p.analytics.periods.monthly,PERIOD),
   since:body.analytics.usageSince,through:body.analytics.usageThrough},
  samples:account.windows.map(w=>[w.id,w.analytics.history]),
  observations:account.windows.map(w=>[w.id,pick(w.analytics.quotaPrecision,['latest','changes','breakCount','segments'])]),
  evidence:p.analytics.priceEvidence,
  roster:{baselineAt:roster.baselineAt,listedCount:roster.listedCount,knownCount:roster.knownCount,
   changes:roster.changes,models:roster.models.map(m=>pick(m,['model','state','sources','firstSeenAt','removedAt']))}};
};
// 저장된 행을 전 열로 읽는다. 응답 투영은 "클라이언트가 같은 값을 받는가", 이쪽은 "기록이 그대로인가"
// 이며 둘은 다른 질문이다. 응답에 실리지 않는 열(usage_prices.pricedAt, price_evidence.firstSeenAt 등)은
// 이쪽으로만 보인다.
const storedRows=dataDir=>{
 const db=new DatabaseSync(join(dataDir,'history.sqlite'),{readOnly:true});
 try{return {usage:db.prepare('SELECT * FROM usage ORDER BY id').all(),
  samples:db.prepare('SELECT * FROM samples ORDER BY provider,account,window,at').all(),
  observations:db.prepare('SELECT * FROM quota_observations ORDER BY seq').all(),
  prices:db.prepare('SELECT * FROM usage_prices ORDER BY id').all(),
  evidence:db.prepare('SELECT * FROM price_evidence ORDER BY id').all(),
  roster:db.prepare("SELECT value FROM meta WHERE key='modelRosterV1'").get()?.value??null};}
 finally{db.close();}
};
// 수집을 한 번 더 돌면 로스터는 정상 동작으로 시각을 다시 찍고 listedReadings 를 올린다. 움직여도 되는
// 것은 그 일곱 개뿐이고 firstSeenAt·baselineAt·removedAt·모델 집합·sources·changes 는 움직이면 안 된다.
// 뭉뚱그려 "시각은 봐준다" 고 하면 신원 손실이 정확히 그 구멍으로 빠져나간다.
const rosterIdentity=json=>{
 const {lastAttemptAt,lastSuccessAt,providers,...state}=JSON.parse(json);
 return JSON.stringify({...state,providers:Object.fromEntries(Object.entries(providers).map(([id,p])=>{
  const {seenAt,listedAt,listedReadings,models,...keep}=p;
  return [id,{...keep,models:Object.fromEntries(Object.entries(models).map(([name,m])=>{
   const {lastListedAt,lastObservedAt,...identity}=m;return [name,identity];}))}];}))});
};
// 2층 판정기. 이전 행은 한 줄도 바뀌지 않아야 하고, 늘어나는 것은 칸마다 명시한 수만큼이어야 한다.
// 개수만 보면 내용이 바뀐 행을 놓치고, 전체 동등성만 보면 정당한 추가를 실패로 잡는다.
const keepsAll=(before,after,label)=>{
 const kept=new Set(after.map(row=>JSON.stringify(row)));
 for(const row of before) assert.ok(kept.has(JSON.stringify(row)),label+': an earlier row changed or vanished');
};
const retains=(before,after,added,label)=>{
 keepsAll(before,after,label);
 assert.equal(after.length,before.length+added,label+': unexpected row count');
};
// 닫기는 한 번만. 명시적으로 닫은 뒤 정리 훅이 또 닫으면 SQLite 가 ERR_INVALID_STATE 로 죽는다.
const closable=(t,collector)=>{let open=true;
 const close=async()=>{if(open){open=false;await collector.close();}};
 t.after(close);return close;};
const storedAllowing=(before,after,allowed,label)=>{
 for(const key of ['usage','samples','observations','prices','evidence'])
  retains(before[key],after[key],allowed[key]??0,label+' '+key);
 assert.equal(rosterIdentity(after.roster),rosterIdentity(before.roster),label+' roster identity');
};
// 단계마다 새 인스턴스를 만든다. 응답 캐시는 주입 시계가 아니라 실제 Date.now() 로 1초를 센다.
const overHttp=async collector=>{
 const app=createApp({port:0,snapshot:()=>collector.snapshot()});
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 try{const response=await fetch(`http://127.0.0.1:${app.address().port}/api/v1/snapshot`);
  assert.equal(response.status,200);return response.json();}
 finally{await new Promise(resolve=>app.close(resolve));}
};
// 가격 목록은 fixture 안에 둔다. catalogPath 를 넘기지 않으면 기본값이 이 호스트의 실제 캐시 파일이라
// 테스트가 바깥 상태에 의존하게 된다.
async function retentionFixture(t,label){
 const dir=await mkdtemp(join(tmpdir(),'quota-jun53-'+label+'-')),native=join(dir,'native');await mkdir(native);
 const start=Date.parse('2026-09-16T00:00:00Z');let now=start;
 const quota=(percent,at)=>({version:1,quotas:{pool:{updatedAt:at,weeklyPercent:percent,weeklyResetAt:start/1000+86400}}});
 const listed=async models=>writeFile(join(dir,'config.json'),JSON.stringify({providers:{openai:{models}},
  codexAccounts:[{id:'pool',logLabel:'pabcdef',plan:'pro'}]}));
 await listed(['gpt-6-astra','gpt-5.6-sol','gpt-legacy']);
 await writeFile(join(dir,'auth.json'),'{}');
 await writeFile(join(dir,'codex-accounts.json'),JSON.stringify({pool:{credential:{accessToken:'JUN53_SENTINEL'}}}));
 await writeFile(join(dir,'provider-account-quota-cache.json'),JSON.stringify({version:1,rows:{}}));
 await writeFile(join(dir,'codex-quota-cache.json'),JSON.stringify(quota(10,start)));
 await writeFile(join(dir,'models.json'),JSON.stringify({openai:{models:{'gpt-6-astra':{cost:{input:2,output:4}}}}}));
 const call=(id,at,model='gpt-6-astra')=>JSON.stringify({requestId:id,timestamp:at,provider:'openai-pabcdef',
  model,usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}});
 await writeFile(join(dir,'usage.jsonl'),call('one',start-60000)+'\n');
 t.after(async()=>{await rm(dir,{recursive:true,force:true});});
 const dataDir=join(dir,'state');
 return {dir,native,start,dataDir,call,quota,listed,
  opts:extra=>({home:dir,codexHome:native,dataDir,catalogPath:join(dir,'models.json'),now:()=>now,...extra}),
  advance(ms){now+=ms;},get now(){return now;}};
}
// 제거된 모델을 하나 만들어 둔다. removedAt 이 전부 null 이면 "제거 시각이 보존된다" 는 단언이
// null 과 null 을 비교하는 것에 지나지 않는다.
const settle=async(fx,collector)=>{
 await collector.collect();
 fx.advance(6*60000);
 await fx.listed(['gpt-6-astra','gpt-5.6-sol']);
 await collector.collect();
 fx.advance(6*60000);
 await collector.collect();
};

test('수집 실패와 회전을 겪고 다시 열어도 API 는 같은 네 대상을 내놓는다',async t=>{
const fx=await retentionFixture(t,'ladder');
let collector=await createCollector(fx.opts());
 let closeCollector=closable(t,collector);
 await settle(fx,collector);
 const settled=preserved(await overHttp(collector));
 // 비어 있는 것끼리 같다고 나오면 아무것도 증명하지 못한다.
 assert.ok(settled.usage.weekly.requests>0,'usage seeded');
 assert.ok(settled.evidence.length,'price evidence seeded');
 assert.ok(settled.samples.some(([,history])=>history?.length),'samples seeded');
 assert.ok(settled.observations.some(([,q])=>q.latest),'quota evidence seeded');
 const removed=settled.roster.models.find(m=>m.model==='gpt-legacy');
 assert.equal(removed.state,'removed');
 assert.ok(removed.removedAt,'a removal timestamp exists to be preserved');

 // 1칸 -- 수집 실패. 새 쿼타 읽기가 샘플과 관측을 하나씩 더하는 것만 허용한다.
 fx.advance(6*60000);
 await writeFile(join(fx.dir,'codex-quota-cache.json'),JSON.stringify(fx.quota(12,fx.now)));
 await rename(join(fx.dir,'usage.jsonl'),join(fx.dir,'usage-away.jsonl'));
 const beforeFailure=storedRows(fx.dataDir);
 await collector.collect();
 const failed=preserved(await overHttp(collector));
 assert.equal((await overHttp(collector)).analytics.status,'error','the read really failed');
 assert.deepEqual(failed.usage,settled.usage,'usage survives a failed read');
 assert.deepEqual(failed.roster,settled.roster,'the model roster survives a failed read');
 // 가격 근거는 응답 배열로 판정하지 않는다. 사용량 파일이 없으면 수집이 가격 근거 갱신에 도달하지
 // 못하므로 그 배열은 설계상 낡은 값이고, 같다는 사실이 보존을 증명하지 않는다. 저장된 행을 본다.
 storedAllowing(beforeFailure,storedRows(fx.dataDir),{samples:1,observations:1},'failed read');

 // 2칸 -- 회전. 새 파일은 inode 가 다르다. 들어오는 행의 모델은 로스터가 이미 아는 것이어야
 // observed-only 항목이 늘지 않는다.
 fx.advance(6*60000);
 const beforeRotation=storedRows(fx.dataDir);
 await writeFile(join(fx.dir,'usage.jsonl'),fx.call('after-rotation',fx.now-1000)+'\n');
 await collector.collect();
 const rotated=preserved(await overHttp(collector));
 assert.deepEqual(rotated.roster,settled.roster,'a rotation adds no model and loses no removal');
 storedAllowing(beforeRotation,storedRows(fx.dataDir),{usage:1,prices:1},'rotation');
 assert.ok(rotated.usage.weekly.requests>failed.usage.weekly.requests,'the new line was read');

 // 3칸 -- 다시 열기. 재수집 전에 전 열을 먼저 본다. 수집을 먼저 하면 바뀐 과거 행이 새 수집에 묻힌다.
 await closeCollector();
 const closed=storedRows(fx.dataDir);
 collector=await createCollector(fx.opts());
 closeCollector=closable(t,collector);
 assert.deepEqual(storedRows(fx.dataDir),closed,'reopening the store writes nothing');
 fx.advance(6*60000);
 await collector.collect();
storedAllowing(closed,storedRows(fx.dataDir),{},'recollection after reopening');
assert.deepEqual(preserved(await overHttp(collector)),rotated,'the API republishes the same four targets');
});

// 판정기가 네 대상을 실제로 보고 있는지 대조한다. 대조마다 상태 디렉터리를 따로 복사한다 --
// 한 fixture 에서 연달아 지우면 첫 대조가 두 번째의 전제를 바꾼다.
test('네 대상 각각이 판정기에 보이는지, 그리고 판정기가 늘 불일치를 내지는 않는지 대조한다',async t=>{
 const fx=await retentionFixture(t,'controls');
const first=await createCollector(fx.opts());
 const closeFirst=closable(t,first);
 await settle(fx,first);
 // 서로 다른 읽기가 둘 있어야 한다. 관측이 하나뿐이면 지운 뒤 다시 수집했을 때 같은 시각·같은 퍼센트의
 // 행이 그대로 복원되어, 대조가 "보존" 과 "재생성" 을 구별하지 못한다.
 fx.advance(6*60000);
 await writeFile(join(fx.dir,'codex-quota-cache.json'),JSON.stringify(fx.quota(14,fx.now)));
 await first.collect();
 const baseline=preserved(await overHttp(first));
assert.ok(baseline.samples.some(([,history])=>history?.length>1),'two distinct readings are stored');
 await closeFirst();
 const closed=storedRows(fx.dataDir);
 const copyOf=async label=>{const to=join(fx.dir,'copy-'+label);await cp(fx.dataDir,to,{recursive:true});return to;};
 const openOn=async to=>{const c=await createCollector(fx.opts({dataDir:to}));
  t.after(async()=>{await c.close();});fx.advance(6*60000);await c.collect();return preserved(await overHttp(c));};
 const damage=async(label,sql)=>{const to=await copyOf(label);
  const db=new DatabaseSync(join(to,'history.sqlite'));db.exec(sql);db.close();return openOn(to);};
 for(const [label,sql] of [['prices','DELETE FROM usage_prices'],['observations','DELETE FROM quota_observations'],
  ['samples','DELETE FROM samples'],['roster',"DELETE FROM meta WHERE key='modelRosterV1'"]]){
  assert.notDeepEqual(await damage(label,sql),baseline,label+' is visible to the projection');}
 // 대조 장치 자체가 늘 불일치를 내는 것은 아니라는 것을 보인다.
 assert.deepEqual(await openOn(await copyOf('untouched')),baseline,'an untouched copy still matches');
 // 응답에 실리지 않는 열은 응답 비교로 볼 수 없다. 저장된 전 열을 따로 비교하는 층이 있는 이유다.
 for(const [label,sql] of [['pricedAt','UPDATE usage_prices SET pricedAt=pricedAt+1'],
  ['firstSeenAt','UPDATE price_evidence SET firstSeenAt=firstSeenAt+1'],
  ['older-observation','UPDATE quota_observations SET at=at-60000 WHERE seq=(SELECT min(seq) FROM quota_observations)']]){
  const to=await copyOf('silent-'+label);
  const db=new DatabaseSync(join(to,'history.sqlite'));db.exec(sql);db.close();
  assert.notDeepEqual(storedRows(to),closed,label+' is caught by the stored-row layer');}
});

test('저장 공간이 꽉 차면 수집기의 쓰기가 실패하고, 풀린 뒤 API 가 같은 네 대상을 내놓는다',async t=>{
 const fx=await retentionFixture(t,'full');
 const small={retentionDays:90,maxBytes:1024*1024};
const first=await createCollector(fx.opts({storage:small}));
 const closeFirst=closable(t,first);
 await settle(fx,first);
 const before=preserved(await overHttp(first));
 assert.ok(before.usage.weekly.requests>0&&before.evidence.length&&before.roster.models.length);
 // 기준선은 첫 수집기를 닫기 전에 뜬다. 채우기 뒤에 뜨면 그 사이에 잃은 것이 기준선에 흡수되고,
 // 복구가 다시 만들어 낸 것을 보존으로 읽게 된다.
 const anchor=storedRows(fx.dataDir);
 for(const key of ['usage','samples','observations','prices','evidence']) assert.ok(anchor[key].length,'anchor '+key);
 await closeFirst();
 // 상한까지 채운다. 바깥 연결로 파일을 키우는 방식으로는 원래 연결의 상한이 따라 올라가 물리지 않으므로,
 // 같은 상한을 가진 연결에서 채운다.
 const filler=await openHistory(fx.dataDir,small);
 filler.db.exec('CREATE TABLE fill (payload BLOB)');
 for(const size of [65536,4096,1024,256,64,8,1]){
  try{for(let i=0;i<20000;i++)filler.db.exec('INSERT INTO fill VALUES (zeroblob('+size+'))');}catch{}}
 assert.equal(filler.db.prepare('PRAGMA page_count').get().page_count,
  filler.db.prepare('PRAGMA max_page_count').get().max_page_count);
 assert.throws(()=>filler.db.exec('INSERT INTO fill VALUES (zeroblob(4096))'),/full/i,'the cap is engaged');
 filler.close();
 const full=storedRows(fx.dataDir);
 // 채우느라 연 것도 아무것도 잃지 않아야 한다.
 for(const key of ['usage','samples','observations','prices','evidence'])
  keepsAll(anchor[key],full[key],'filler reopen '+key);
 // 이제 수집기 자신의 쓰기가 상한에 부딪히게 한다. 새 로그 줄이 많으면 적재가 페이지를 요구한다.
const flood=await createCollector(fx.opts({storage:small}));
 const closeFlood=closable(t,flood);
 fx.advance(6*60000);
 const lines=Array.from({length:6000},(unused,i)=>fx.call('flood-'+i,fx.now-1000)).join('\n')+'\n';
 await writeFile(join(fx.dir,'usage.jsonl'),lines);
 await flood.collect();
 assert.equal((await overHttp(flood)).analytics.status,'error','a production write hit the cap');
 // 상한에 걸린 뒤에도 작은 쓰기는 잎 페이지 여유에 들어가 성공한다. 주장할 수 있는 것은 '아무것도
 // 잃지 않았다' 이지 '아무것도 바뀌지 않았다' 가 아니다. 그래서 보존만 단언한다.
 const afterFailure=storedRows(fx.dataDir);
 for(const key of ['usage','samples','observations','prices','evidence'])
  keepsAll(full[key],afterFailure[key],'failed production write '+key);
 assert.equal(rosterIdentity(afterFailure.roster),rosterIdentity(full.roster),'failed write roster identity');
 await closeFlood();
 // 공간이 다시 생긴 뒤. 재수집 전에 전 열을 먼저 본다.
 const after=await createCollector(fx.opts({storage:{retentionDays:90,maxBytes:16*1024*1024}}));
 t.after(async()=>{await after.close();});
 assert.deepEqual(storedRows(fx.dataDir),afterFailure,'reopening with room writes nothing');
 fx.advance(6*60000);
 await after.collect();
 const republished=preserved(await overHttp(after));
 // 적재가 이제 성공하므로 사용량은 늘어난다. 늘어나는 것은 그것뿐이고, 나머지 세 대상은 그대로다.
 assert.deepEqual(republished.samples,before.samples,'samples republish unchanged');
 assert.deepEqual(republished.observations,before.observations,'quota evidence republishes unchanged');
 assert.deepEqual(republished.roster,before.roster,'the model roster republishes unchanged');
 const recovered=storedRows(fx.dataDir);
 for(const key of ['usage','samples','observations','prices','evidence'])
  keepsAll(anchor[key],recovered[key],'recovery '+key);
 retains(afterFailure.samples,recovered.samples,0,'recovery adds no sample');
 retains(afterFailure.observations,recovered.observations,0,'recovery adds no observation');
 // 아무 증가나 받아들이면 절반만 읽고 커서를 끝까지 민 구현도 통과한다. 정확한 수를 요구한다.
 assert.equal(recovered.usage.length,anchor.usage.length+6000,'every deferred line was read');
 assert.equal(recovered.prices.length,anchor.prices.length+6000,'every recovered row kept its price link');
 assert.equal(rosterIdentity(recovered.roster),rosterIdentity(anchor.roster),'recovery roster identity');
 // 저장된 행이 남아 있다는 것과 API 가 그것을 다시 내놓는다는 것은 다른 주장이다. 둘 다 본다.
 assert.equal(republished.usage.weekly.requests,before.usage.weekly.requests+6000,
  'the API republishes the recovered usage, not just the stored rows');
 const group=republished.evidence.find(row=>row.model==='gpt-6-astra');
 assert.ok(group,'the recovered price evidence is published');
 assert.equal(group.requests,anchor.usage.length+6000);
 // 그룹이 있고 수가 맞아도 그 안의 근거가 null 이면 아무것도 설명하지 못한다. 중첩된 기록까지 본다.
 const baselineGroup=before.evidence.find(row=>row.model==='gpt-6-astra');
 assert.ok(baselineGroup?.evidence,'the baseline group carries a real price record');
 assert.deepEqual(group.evidence,baselineGroup.evidence,
  'the same price record still explains the recovered calls');
 // 금액까지 본다. 게시되는 금액을 상수로 바꿔 버리는 결함은 근거 비교만으로는 잡히지 않는다.
 assert.ok(baselineGroup.storedApiUsd>0,'the baseline group carries a real amount');
 assert.ok(Math.abs(group.storedApiUsd-baselineGroup.storedApiUsd/baselineGroup.requests*group.requests)<1e-9,
  'the recovered amount is the same per-call amount, not a constant');
 // 다시 수집해도 같은 줄을 두 번 세지 않는다.
 fx.advance(6*60000);
 await after.collect();
 assert.equal(storedRows(fx.dataDir).usage.length,recovered.usage.length,'a second collection duplicates nothing');
});

test('the model roster keeps a baseline, names each change once, and a failed lookup loses nothing',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-roster-')),catalogPath=join(dir,'models.json');
 const usage=join(dir,'usage.jsonl'),config=join(dir,'config.json');
 let now=Date.parse('2026-09-16T00:00:00Z');
 const write=value=>writeFile(config,JSON.stringify({providers:{'opencode-go':value}}));
 const listed=models=>write({apiKey:'ROSTER_SENTINEL',models});
 await listed(['glm-5.3','k3','kimi-k2.7-code']);
 await writeFile(join(dir,'auth.json'),'{}');
 const call=(id,model)=>JSON.stringify({requestId:id,timestamp:now-1000,provider:'opencode-go',model,
  usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}});
 // One configured model and one that only the usage log knows about.
 await writeFile(usage,[call('configured','glm-5.3'),call('logged','deepseek-flash'),
  call('credential','ROSTER_SENTINEL')].join('\n')+'\n');
 const collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),catalogPath,now:()=>now});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 const roster=s=>s.providers.find(p=>p.id==='opencode-go').analytics.modelRoster;
 const model=(s,name)=>roster(s).models.find(m=>m.model===name);
 const step=async()=>{now+=60000;await collector.collect();return collector.snapshot();};

 // The first reading is the basis for every later comparison, so it names nothing as new.
 await collector.collect();
 let snapshot=await collector.snapshot();
 assert.equal(roster(snapshot).status,'baseline');
 assert.deepEqual(roster(snapshot).changes,[]);
 assert.equal(roster(snapshot).listedCount,3);
 const firstSeenAt=model(snapshot,'glm-5.3').firstSeenAt;

 // The usage log is read after the list, so a model only it knows about arrives on the
 // next reading — once, and not again however often the same log is read.
 snapshot=await step();
 assert.equal(roster(snapshot).status,'ok');
 assert.deepEqual(roster(snapshot).changes.map(c=>[c.model,c.change]),[['deepseek-flash','observed']]);
 assert.equal(model(snapshot,'deepseek-flash').state,'observed-only');
 assert.deepEqual(model(snapshot,'deepseek-flash').sources,['observed']);
 assert.equal(model(snapshot,'deepseek-flash').removedAt,null);
 snapshot=await step();
 assert.equal(roster(snapshot).changes.length,1);
 assert.equal(model(snapshot,'glm-5.3').firstSeenAt,firstSeenAt);

 // A model added to the configuration is named once.
 await listed(['glm-5.3','k3','kimi-k2.7-code','gpt-6-astra']);
 snapshot=await step();
 assert.deepEqual(roster(snapshot).changes[0],{at:new Date(now).toISOString(),model:'gpt-6-astra',change:'added'});
 assert.equal(roster(snapshot).changes.length,2);

 // A model removed from the configuration keeps its identity, its first sighting and
 // its priced history. Only its listing ends.
 await listed(['k3','kimi-k2.7-code','gpt-6-astra']);
 snapshot=await step();
 const removedAt=new Date(now).toISOString();
 assert.deepEqual(roster(snapshot).changes[0],{at:removedAt,model:'glm-5.3',change:'removed'});
 assert.equal(model(snapshot,'glm-5.3').state,'removed');
 assert.equal(model(snapshot,'glm-5.3').firstSeenAt,firstSeenAt);
 assert.equal(model(snapshot,'glm-5.3').removedAt,removedAt);
 const priced=s=>s.providers.find(p=>p.id==='opencode-go').analytics.modelPrices.find(r=>r.model==='glm-5.3');
 assert.equal(priced(snapshot).requests,1);
 assert.equal(priced(snapshot).status,'official');
 assert.ok(priced(snapshot).rates.input>0);

 // The same model configured again returns rather than being born a second time.
 await listed(['glm-5.3','k3','kimi-k2.7-code','gpt-6-astra']);
 snapshot=await step();
 assert.deepEqual(roster(snapshot).changes[0],{at:new Date(now).toISOString(),model:'glm-5.3',change:'returned'});
 assert.equal(model(snapshot,'glm-5.3').firstSeenAt,firstSeenAt);
 assert.equal(model(snapshot,'glm-5.3').removedAt,null);
 const settled=roster(snapshot).changes.length;
 const lastSuccessAt=snapshot.analytics.modelRoster.lastSuccessAt;

 // A configuration that cannot be read is not a configuration without models. The
 // previous list, the instant it was read and every model survive the failure.
 const intact=await readFile(config,'utf8');
 await writeFile(config,'{ this is not json');
 now+=60000;
 await collector.collect();
 await writeFile(config,intact);
 snapshot=await collector.snapshot();
 assert.equal(snapshot.analytics.modelRoster.status,'failed');
 assert.equal(snapshot.analytics.modelRoster.failureSince,new Date(now).toISOString());
 assert.equal(snapshot.analytics.modelRoster.lastSuccessAt,lastSuccessAt);
 assert.equal(roster(snapshot).listedCount,4);
 assert.equal(roster(snapshot).changes.length,settled);

 // Recovery clears the failure without inventing a change.
 snapshot=await step();
 assert.equal(snapshot.analytics.modelRoster.failureSince,null);
 assert.equal(snapshot.analytics.modelRoster.lastSuccessAt,new Date(now).toISOString());
 assert.equal(roster(snapshot).changes.length,settled);

 // A usage log that cannot be read is a different failure: the list was read, so the
 // roster records a successful lookup even while the collection reports an error.
 await rename(usage,join(dir,'usage-away.jsonl'));
 snapshot=await step();
 assert.equal(snapshot.analytics.status,'error');
 assert.equal(snapshot.analytics.modelRoster.status,'ok');
 assert.equal(snapshot.analytics.modelRoster.failureSince,null);
 assert.equal(snapshot.analytics.modelRoster.lastSuccessAt,new Date(now).toISOString());
 await rename(join(dir,'usage-away.jsonl'),usage);

 // The roster reads the OCX files and never writes them, and no credential rides along.
 assert.equal(await readFile(config,'utf8'),intact);
 assert.equal(JSON.stringify(snapshot).includes('ROSTER_SENTINEL'),false);
 // A usage row whose model name is the configured key is a credential, not a model.
 assert.equal(roster(snapshot).models.some(m=>m.model==='ROSTER_SENTINEL'),false);
 assert.equal(roster(snapshot).changes.some(c=>c.model==='ROSTER_SENTINEL'),false);
});

test('a roster comparison survives a restart and a list that lost everything is not a removal',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-roster-loss-')),catalogPath=join(dir,'models.json');
 const dataDir=join(dir,'state'),config=join(dir,'config.json');
 let now=Date.parse('2026-09-16T00:00:00Z');
 const write=providers=>writeFile(config,JSON.stringify({providers}));
 const full={alpha:{models:['a1','a2','a3']},beta:{models:['b1','b2','b3'],defaultModel:'b1'},gamma:{models:'not-a-list'}};
 await write(full);
 await writeFile(join(dir,'auth.json'),'{}');
 await writeFile(join(dir,'usage.jsonl'),'');
 const options={home:dir,codexHome:dir,dataDir,catalogPath,now:()=>now};
 let collector=await createCollector(options);
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 const roster=(s,id)=>s.providers.find(p=>p.id===id).analytics.modelRoster;
 const step=async()=>{now+=60000;await collector.collect();return collector.snapshot();};
 await collector.collect();
 let snapshot=await collector.snapshot();
 assert.equal(roster(snapshot,'alpha').listedCount,3);
 // A provider whose model list could not be projected has no comparison basis yet.
 assert.equal(roster(snapshot,'gamma').status,'unknown');
 const firstSeenAt=roster(snapshot,'alpha').models.find(m=>m.model==='a1').firstSeenAt;

 // A restart continues the same comparison: the same identifiers, the same first
 // sighting, and a real removal still named once.
 await collector.close();
 now+=60000;
 collector=await createCollector(options);
 await write({...full,alpha:{models:['a1','a3']}});
 snapshot=await step();
 assert.deepEqual(roster(snapshot,'alpha').changes.map(c=>[c.model,c.change]),[['a2','removed']]);
 assert.equal(roster(snapshot,'alpha').models.find(m=>m.model==='a1').firstSeenAt,firstSeenAt);

 // An emptied list and a mistyped one arrive identically, and neither is evidence that
 // the models are gone. Repeating the reading does not make it evidence either.
 await write({...full,alpha:{models:[]}});
 snapshot=await step();
 assert.equal(roster(snapshot,'alpha').status,'suspect');
 assert.equal(roster(snapshot,'alpha').listedCount,2);
 await write({...full,alpha:{models:'not-a-list'}});
 for (let reading=0;reading<3;reading++) snapshot=await step();
 assert.equal(roster(snapshot,'alpha').status,'suspect');
 assert.equal(roster(snapshot,'alpha').listedCount,2);
 assert.equal(roster(snapshot,'alpha').changes.filter(c=>c.change==='removed').length,1);

 // A list that lost everything except its default selector has the same shape as a
 // mistyped one, because the selector is projected separately.
 await write({...full,beta:{models:'not-a-list',defaultModel:'b1'}});
 snapshot=await step();
 assert.equal(roster(snapshot,'beta').status,'suspect');
 assert.equal(roster(snapshot,'beta').listedCount,3);
 assert.deepEqual(roster(snapshot,'beta').changes,[]);

 // A first reading with no usable list is not a basis, so the real list that follows
 // is a baseline rather than a configuration full of new models.
 await write({...full,gamma:{models:['g1','g2']}});
 snapshot=await step();
 assert.equal(roster(snapshot,'gamma').status,'baseline');
 assert.deepEqual(roster(snapshot,'gamma').changes,[]);
 assert.equal(roster(snapshot,'gamma').listedCount,2);

 // A list that comes back clears the suspicion without inventing changes.
 await write(full);
 snapshot=await step();
 assert.equal(roster(snapshot,'alpha').status,'ok');
 assert.deepEqual(roster(snapshot,'alpha').changes.map(c=>[c.model,c.change]),[['a2','returned'],['a2','removed']]);
});


test('the roster forgets only what cannot return, bounds its own log, and never breaks collection',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-roster-unit-'));
 t.after(async()=>{await rm(dir,{recursive:true,force:true});});
 let now=Date.parse('2026-09-16T00:00:00Z');
 // An injectable source: the stored state and the observed names are both supplied.
 // Meta reads parse on the way out exactly as the real store does, so a corrupt stored
 // value throws where it would in production and a later write replaces it.
 const source=({observed=[],meta={},corrupt=false}={})=>({names:observed,
  values:new Map([...Object.entries(meta).map(([key,value])=>[key,JSON.stringify(value)]),
   ...(corrupt?[['modelRosterV1','{ not json']]:[])]),
  get(key){return this.values.has(key)?JSON.parse(this.values.get(key)):null;},
  set(key,value){this.values.set(key,JSON.stringify(value));},
  bounds:()=>({since:1,through:2}),
  observedModels(){return this.names.map(model=>({model,requests:1,unpricedRequests:0}));}});
 const read=(providers,secrets=new Set())=>({providers,[MODEL_EXCLUSIONS]:secrets});
 const view=(roster,id,secrets=new Set())=>{
  const snapshot={providers:[{id,analytics:{}}],analytics:{}};
  roster.enrich(snapshot,secrets);
  return {provider:snapshot.providers[0].analytics.modelRoster,summary:snapshot.analytics.modelRoster};
 };

 // A recorded name that is a configured credential never enters the roster, and the
 // same filter runs again on publication.
 const keyed=source({observed:['SECRET_AS_MODEL','glm-5.3']});
 const guarded=createModelRoster({store:keyed,now:()=>now});
 guarded.record(read([{id:'p',supportedModels:['k3']}],new Set(['SECRET_AS_MODEL'])),now);
 assert.deepEqual(view(guarded,'p',new Set(['SECRET_AS_MODEL'])).provider.models.map(m=>m.model),['glm-5.3','k3']);
 assert.equal(keyed.values.get('modelRosterV1').includes('SECRET_AS_MODEL'),false);
 // A name stored while it was an ordinary model is withheld once the configuration
 // holds it as a credential, so the filter has to run again on publication and not
 // only when the name was recorded.
 now+=60000;
 guarded.record(read([{id:'p',supportedModels:['k3','later-key']}],new Set(['SECRET_AS_MODEL'])),now);
 assert.ok(view(guarded,'p').provider.changes.some(c=>c.model==='later-key'));
 const withheld=view(guarded,'p',new Set(['later-key'])).provider;
 assert.equal(withheld.models.some(m=>m.model==='later-key'),false);
 assert.equal(withheld.changes.some(c=>c.model==='later-key'),false);

 // An explicit guarantee that the list is complete is believed as it stands. This is the
 // seam a verified configuration read fills; nothing sets it yet.
 const verified=createModelRoster({store:source(),now:()=>now});
 verified.record(read([{id:'p',supportedModels:['a','b']}]),now);
 now+=60000;
 verified.record(read([{id:'p',supportedModels:[]}]),now);
 assert.equal(view(verified,'p').provider.status,'suspect');
 now+=60000;
 verified.record(read([{id:'p',supportedModels:[],modelListStatus:'ok'}]),now);
 const confirmed=view(verified,'p').provider;
 assert.equal(confirmed.status,'ok');
 assert.equal(confirmed.listedCount,0);
 assert.deepEqual(confirmed.models.map(m=>[m.model,m.state]),[['a','removed'],['b','removed']]);

 // A provider whose only model is also its default selector has the shape of a list that
 // failed to parse. It still reads normally, because nothing is being dropped.
 const single=createModelRoster({store:source(),now:()=>now});
 for (let reading=0;reading<3;reading++){
  now+=60000;
  single.record(read([{id:'p',supportedModels:['only'],defaultModel:'only'}]),now);
 }
 const steady=view(single,'p').provider;
 assert.equal(steady.status,'ok');
 assert.equal(steady.listedCount,1);
 assert.deepEqual(steady.changes,[]);

 // A model is forgotten only once a lookup that actually ran shows the usage log no
 // longer holds it. A name the log still returns stays however old the record is, or the
 // next reading would find it new again.
 const aging=source({observed:['gone-model','still-logged']});
 const pruner=createModelRoster({store:aging,now:()=>now});
 now+=60000;
 pruner.record(read([{id:'p',supportedModels:['keep']}]),now);
 assert.equal(view(pruner,'p').provider.knownCount,3);
 aging.names=['still-logged'];
 aging.values.set('usageExcludedBefore',JSON.stringify(now+30000));
 now+=60000;
 pruner.record(read([{id:'p',supportedModels:['keep']}]),now);
 assert.deepEqual(view(pruner,'p').provider.models.map(m=>m.model),['keep','still-logged']);
 const settled=view(pruner,'p').provider.changes.length;
 now+=60000;
 pruner.record(read([{id:'p',supportedModels:['keep']}]),now);
 assert.equal(view(pruner,'p').provider.changes.length,settled);

 // A failed lookup is not evidence of absence, so it forgets nothing — including a
 // model the boundary would otherwise make a candidate.
 aging.observedModels=()=>{throw new Error('observed');};
 aging.values.set('usageExcludedBefore',JSON.stringify(now+120000));
 now+=60000;
 pruner.record(read([{id:'p',supportedModels:['keep']}]),now);
 assert.deepEqual(view(pruner,'p').provider.models.map(m=>m.model),['keep','still-logged']);

 // An old observation followed by a removal now must not be read as old activity: the
 // model has to survive to be recognized when it returns.
 const returning=source({observed:['seldom']});
 const memory=createModelRoster({store:returning,now:()=>now});
 memory.record(read([{id:'p',supportedModels:['seldom','other']}]),now);
 const born=view(memory,'p').provider.models.find(m=>m.model==='seldom').firstSeenAt;
 returning.names=[];
 returning.values.set('usageExcludedBefore',JSON.stringify(now+30000));
 now+=60000;
 memory.record(read([{id:'p',supportedModels:['other']}]),now);
 assert.equal(view(memory,'p').provider.models.find(m=>m.model==='seldom').state,'removed');
 now+=60000;
 memory.record(read([{id:'p',supportedModels:['seldom','other']}]),now);
 const back=view(memory,'p').provider;
 assert.equal(back.changes[0].change,'returned');
 assert.equal(back.models.find(m=>m.model==='seldom').firstSeenAt,born);

 // The change log is bounded while the models it describes are not: dropping the oldest
 // entry must not drop the model, or the next reading would find it new again.
 const busy=createModelRoster({store:source(),now:()=>now,changeLimit:3});
 busy.record(read([{id:'p',supportedModels:['m1','m2','m3','m4','m5']}]),now);
 for (const listed of [['m1','m2'],['m1','m2','m3','m4','m5'],['m1','m2'],['m1','m2','m3','m4','m5']]) {
  now+=60000;
  busy.record(read([{id:'p',supportedModels:listed}]),now);
 }
 const bounded=view(busy,'p').provider;
 assert.equal(bounded.changes.length,3);
 assert.equal(bounded.knownCount,5);
 assert.equal(bounded.changes[0].at,new Date(now).toISOString());

 // A model named like an inherited object property is a valid id and must not take the
 // rest of the reading down with it.
 const inherited=createModelRoster({store:source(),now:()=>now});
 now+=60000;
 inherited.record(read([{id:'p',supportedModels:['toString','constructor','real-model']}]),now);
 assert.deepEqual(view(inherited,'p').provider.models.map(m=>m.model),['constructor','real-model','toString']);

 // Corrupt stored state costs a new baseline, never an exception in the collector.
 const corrupt=createModelRoster({store:source({corrupt:true}),now:()=>now});
 assert.doesNotThrow(()=>corrupt.record(read([{id:'p',supportedModels:['a']}]),now));
 assert.equal(view(corrupt,'p').provider.listedCount,1);

 // A cycle whose observed lookup failed is the roster's own error even though the write
 // that followed it succeeded.
 const halfBroken=source();
 halfBroken.observedModels=()=>{throw new Error('observed');};
 const partial=createModelRoster({store:halfBroken,now:()=>now});
 now+=60000;
 partial.record(read([{id:'p',supportedModels:['a']}]),now);
 assert.equal(view(partial,'p').summary.status,'error');

 // A store that fails on every call is reported as the roster's own error and nothing
 // more. The collection around it keeps its own result.
 const hostile={get(){throw new Error('read');},set(){throw new Error('write');},
  bounds(){throw new Error('bounds');},observedModels(){throw new Error('observed');}};
 const failing=createModelRoster({store:hostile,now:()=>now});
 assert.doesNotThrow(()=>failing.record(read([{id:'p',supportedModels:['a']}]),now));
 assert.doesNotThrow(()=>failing.fail(now));
 const reported=view(failing,'p');
 assert.equal(reported.summary.status,'error');
 assert.equal(reported.provider.status,'unknown');
});

test('an isolated install collects and serves a snapshot with no OpenCodex files at all',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-isolated-')),native=join(dir,'native');
 await mkdir(native);
 const now=1800000000000;
 // No config.json, no auth.json, no admin token and no usage.jsonl. Only the native login.
 await writeFile(join(native,'auth.json'),JSON.stringify({tokens:{account_id:'main-physical',access_token:'PRIVATE_SENTINEL'}}));
const endpoints={openai:{'synthetic-usage':{host:'quota.invalid',path:'/usage',
   configuredOrigins:['https://quota.invalid'],acceptsDefaultBase:true,
   authorize:c=>({Authorization:`Bearer ${c.value}`})}}};
 const adapter={provider:'openai',endpointId:'synthetic-usage',sourceVersion:'synthetic-1',
   appliesTo:b=>b.accountId==='__main__',
   parse:json=>json.windows.map(w=>({windowId:w.id,label:w.id,resetAt:null,raw:{scopeKey:'account:all',...w}}))};
 const collector=await createCollector({home:dir,codexHome:native,dataDir:join(dir,'state'),now:()=>now,
   directAdapters:[adapter],directEndpoints:endpoints,
   directFetcher:async()=>({status:200,headers:{get:()=>null},
     text:async()=>JSON.stringify({windows:[{id:'weekly',used:123.4,limit:1000}]})})});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 await collector.collect();
 const snapshot=await collector.snapshot();
 // A usage log that was never present is the normal state here, not a collection failure.
 assert.notEqual(snapshot.analytics.status,'error');
 assert.equal(snapshot.analytics.directQuota.enabled,true);
 const account=snapshot.providers.find(p=>p.id==='openai').accounts.find(a=>a.id==='__main__');
 assert.equal(account.windows[0].usedPercent,12.34);
 assert.equal(account.windows[0].measurement.calculatedPercent,12.34);
 assert.equal(account.directQuota.status,'ok');
 assert.equal(JSON.stringify(snapshot).includes('PRIVATE_SENTINEL'),false);
});

test('a usage log that existed and then vanished is still a collection failure',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-lost-log-')),native=join(dir,'native');
 await mkdir(native);
 let now=1800000000000;
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{openai:{}},codexAccounts:[{id:'pool',logLabel:'pabcdef'}]}));
 await writeFile(join(dir,'auth.json'),'{}');
 await writeFile(join(dir,'codex-accounts.json'),JSON.stringify({pool:{credential:{accessToken:'PRIVATE_SENTINEL'}}}));
 await writeFile(join(native,'auth.json'),'{}');
 const usage=join(dir,'usage.jsonl');
 await writeFile(usage,JSON.stringify({requestId:'a',timestamp:now-1000,provider:'openai-pabcdef',model:'gpt-6-astra',usageStatus:'reported',usage:{inputTokens:1,outputTokens:1}})+'\n');
 const collector=await createCollector({home:dir,codexHome:native,dataDir:join(dir,'state'),now:()=>now});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 await collector.collect();
 const healthy=await collector.snapshot();
 assert.notEqual(healthy.analytics.status,'error');
 // No adapters are registered here, so the published analytics must be exactly what they
 // were before direct collection existed.
 assert.equal('directQuota' in healthy.analytics,false);
 // Removing a log we had already read is a real gap, and treating it as normal would let a
 // collection outage read as idle time.
 await rm(usage);
 now+=60000;
 await collector.collect();
 const broken=await collector.snapshot();
 assert.equal(broken.analytics.status,'error');
 // The model list was read before the usage log failed, so the roster keeps its own
 // result. A failure downstream must not retract a lookup that did succeed.
 assert.notEqual(broken.analytics.modelRoster.status,'failed');
});

const PRICE_NOW = Date.parse('2026-09-15T12:30:00Z');
const goCall = (requestId,model,at=PRICE_NOW-1000) => JSON.stringify({requestId,provider:'opencode-go',model,
 timestamp:at,usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}});
async function priceFixture(t,{config,calls,catalog}) {
 const dir=await mkdtemp(join(tmpdir(),'quota-price-surface-')),catalogPath=join(dir,'models.json');
 let clock=PRICE_NOW;
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:config}));
 await writeFile(join(dir,'auth.json'),'{}');
 await writeFile(join(dir,'usage.jsonl'),calls.join('\n')+'\n');
 await writeFile(catalogPath,JSON.stringify(catalog));
 const collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),catalogPath,now:()=>clock});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 return {dir,catalogPath,collector,advance:ms=>{clock+=ms;},at:()=>clock};
}
const evidenceOf = (snapshot,provider) => snapshot.providers.find(p=>p.id===provider).analytics.priceEvidence;

test('a model the catalog dropped keeps the price that valued its calls while its price row goes quiet',async t=>{
 const f=await priceFixture(t,{config:{'opencode-go':{models:['future-model']}},
  calls:[goCall('listed','future-model')],
  catalog:{'opencode-go':{models:{'future-model':{cost:{input:2,output:4,cache_read:.5}}}}}});
 await f.collector.collect();
 const listed=evidenceOf(await f.collector.snapshot(),'opencode-go');
 assert.equal(listed.length,1);
 assert.equal(listed[0].model,'future-model');
 assert.equal(listed[0].evidence.rates.input,2);
 assert.equal(listed[0].requests,1);
 assert.equal(listed[0].storedApiUsd,.0024);
 // The model leaves the catalog. The current price list loses it; the record does not.
 await writeFile(f.catalogPath,JSON.stringify({'opencode-go':{models:{other:{cost:{input:3,output:4}}}}}));
 f.advance(6*60000);
 await f.collector.collect();
 const after=await f.collector.snapshot();
 const prices=after.providers.find(p=>p.id==='opencode-go').analytics.modelPrices;
 assert.equal(prices.find(p=>p.model==='future-model').status,'unpriced');
 const kept=evidenceOf(after,'opencode-go');
 assert.equal(kept[0].evidence.rates.input,2);
 assert.equal(kept[0].evidence.status,'local-catalog');
 assert.ok(after.analytics.priceEvidenceComputedAt);
});

test('a configured key is still a secret when it is the canonical name a call was priced under',async t=>{
 // The configured key spells a real model id, and the call records the alias of that id.
 // The recorded name is not the key, so it passes on its own; the name the price was
 // selected under is the key exactly.
 const key='gpt-oss:120b';
 const f=await priceFixture(t,{config:{'ollama-cloud':{apiKey:key,models:['gpt-oss:20b']}},
  calls:[JSON.stringify({requestId:'aliased',provider:'ollama-cloud',model:key+'-cloud',
   timestamp:PRICE_NOW-1000,usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}})],
  catalog:{}});
 await f.collector.collect();
 const snapshot=await f.collector.snapshot();
 // The row is withheld entirely, the way a configured name that fails the gate is.
 assert.deepEqual(evidenceOf(snapshot,'ollama-cloud'),[]);
 // And the key is never published as the name a price was selected under. Checking the
 // whole body for the string would not work here: the alias legitimately contains the key
 // as a substring, and that alias reaches modelPrices exactly as it did before this field
 // existed. This assertion is about the channel this change adds.
 const priced=[];
 for (const provider of snapshot.providers)
  for (const row of provider.analytics.priceEvidence)
   if (row.evidence) priced.push(row.evidence.pricedModel);
 assert.equal(priced.includes(key),false,'the configured key must not be published as a priced name');
});

test('the published record follows the collection cycle, and an unreadable one is reported as unreadable',async t=>{
 const f=await priceFixture(t,{config:{'opencode-go':{models:['future-model']}},
  calls:[goCall('one','future-model')],
  catalog:{'opencode-go':{models:{'future-model':{cost:{input:2,output:4,cache_read:.5}}}}}});
 // Asked before anything was collected, it answers with nothing and says when: never.
 const cold=await f.collector.snapshot();
 assert.deepEqual(evidenceOf(cold,'opencode-go'),[]);
 assert.equal(cold.analytics.priceEvidenceComputedAt,null);
 await f.collector.collect();
 const first=await f.collector.snapshot();
 assert.equal(evidenceOf(first,'opencode-go').length,1);
 const computedAt=first.analytics.priceEvidenceComputedAt;
 // Damage the stored record from outside, then collect again inside the refresh interval.
 const raw=new DatabaseSync(join(f.dir,'state','history.sqlite'));
 raw.exec("UPDATE price_evidence SET rates='{broken', conditions='[broken'");
 raw.close();
 f.advance(60000);
 await f.collector.collect();
 const held=await f.collector.snapshot();
 assert.equal(held.analytics.priceEvidenceComputedAt,computedAt,'still inside the interval');
 assert.equal(evidenceOf(held,'opencode-go')[0].evidence.rates.input,2);
 // Past the interval it is read again, and what cannot be parsed is reported as absent
 // rather than taking the row or the rest of the response with it.
 f.advance(6*60000);
 await f.collector.collect();
 const reread=await f.collector.snapshot();
 assert.notEqual(reread.analytics.priceEvidenceComputedAt,computedAt);
 const [row]=evidenceOf(reread,'opencode-go');
 assert.equal(row.evidence.rates,null);
 assert.equal(row.evidence.conditions,null);
 assert.equal(row.evidence.status,'local-catalog');
 assert.equal(row.requests,1);
});
const priceCall = (requestId,provider,model) => JSON.stringify({requestId,provider,model,
 timestamp:PRICE_NOW-1000,usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}});
test('a price row names the id its rate came from, and withholds that id when it is a configured key',async t=>{
 const open=await priceFixture(t,{config:{'ollama-cloud':{models:['gpt-oss:120b-cloud','gpt-oss:20b']}},
  calls:[priceCall('aliased','ollama-cloud','gpt-oss:120b-cloud')],catalog:{}});
 await open.collector.collect();
 const row=(await open.collector.snapshot()).providers.find(p=>p.id==='ollama-cloud')
  .analytics.modelPrices.find(r=>r.model==='gpt-oss:120b-cloud');
 // 목록이 끊기지 않게 하는 연결이다. 요청된 이름과 단가가 실제로 선택된 이름이 한 줄에 있다.
 assert.equal(row.pricedModel,'gpt-oss:120b');
 assert.equal(row.rates.input,.15);
 // 별칭이 아닌 모델은 자기 이름 그대로 답한다. 화면은 두 이름이 다를 때만 별칭이라고 적는다.
 const plain=(await open.collector.snapshot()).providers.find(p=>p.id==='ollama-cloud')
  .analytics.modelPrices.find(r=>r.model==='gpt-oss:20b');
 assert.equal(plain.pricedModel,'gpt-oss:20b');
 assert.equal(plain.pricedModel===plain.model,true);
 // 같은 별칭이지만 이번에는 그 정식 이름이 설정된 키다. 바깥 이름만 막으면 새 필드로 키가 샌다.
 const secret='gpt-oss:120b';
 const closed=await priceFixture(t,{config:{'ollama-cloud':{models:['gpt-oss:120b-cloud']},
   cursor:{apiKey:secret,models:['claude-opus-5']}},
  calls:[priceCall('aliased','ollama-cloud','gpt-oss:120b-cloud')],catalog:{}});
 await closed.collector.collect();
 const guarded=await closed.collector.snapshot();
 const alias=guarded.providers.find(p=>p.id==='ollama-cloud')
  .analytics.modelPrices.find(r=>r.model==='gpt-oss:120b-cloud');
 assert.equal(alias.pricedModel,null);
 // 단가는 그대로 답한다. 숨기는 것은 이름이지 값이 아니다.
 assert.equal(alias.rates.input,.15);
 const published=[];
 for(const provider of guarded.providers)
  for(const priced of provider.analytics.modelPrices)
   published.push(priced.pricedModel);
 assert.equal(published.includes(secret),false,'a configured key must not be published as a priced name');
});
test('every billing condition of a listed model reaches the response with its own threshold and multiplier',async t=>{
 const f=await priceFixture(t,{config:{openai:{models:['gpt-6-astra','gpt-5.4-mini','never-priced-model']}},
  calls:[priceCall('priced','openai','gpt-6-astra')],catalog:{}});
 await f.collector.collect();
 const snapshot=await f.collector.snapshot();
 // 분석 필드만 늘었다. 응답 계약은 그대로다.
 assert.equal(snapshot.schemaVersion,1);
 const prices=snapshot.providers.find(p=>p.id==='openai').analytics.modelPrices;
 const astra=prices.find(r=>r.model==='gpt-6-astra');
 assert.deepEqual(astra.priceConditions.map(c=>c.id),
  ['default','long-context','service-tier-priority','service-tier-discount']);
 // 줄 머리의 단가는 기본 조건의 단가다. 둘이 어긋나면 화면이 다른 조건의 값을 머리에 건다.
 assert.deepEqual(astra.priceConditions[0].rates,astra.rates);
 const long=astra.priceConditions.find(c=>c.id==='long-context');
 assert.equal(long.inputTokensFrom,272001);
 assert.equal(long.rates.input,astra.rates.input*2);
 assert.equal(astra.priceConditions.find(c=>c.id==='service-tier-priority').tierMultiplier,2);
 assert.equal(astra.priceConditions.find(c=>c.id==='service-tier-discount').tierMultiplier,.5);
 // 조건은 있는데 그 조건의 단가가 없는 경우. 기본 단가를 물려주지 않는다.
 const mini=prices.find(r=>r.model==='gpt-5.4-mini');
 const miniLong=mini.priceConditions.find(c=>c.id==='long-context');
 assert.equal(miniLong.status,'unpriced');
 assert.deepEqual(miniLong.rates,{input:null,output:null,cacheRead:null,cacheWrite:null});
 assert.notEqual(mini.rates.input,null);
 // 단가를 못 구한 모델도 목록에 남고 기본 조건 한 줄로 그 사실을 말한다.
 const unpriced=prices.find(r=>r.model==='never-priced-model');
 assert.equal(unpriced.status,'unpriced');
 assert.deepEqual(unpriced.rates,{input:null,output:null,cacheRead:null,cacheWrite:null});
 assert.deepEqual(unpriced.priceConditions.map(c=>c.id),['default']);
});
test('the model price surface the UI check assumes is the shape a real collector produces',async t=>{
 const f=await priceFixture(t,{config:{openai:{models:['gpt-6-astra','never-priced-model']},
   'ollama-cloud':{models:['gpt-oss:120b-cloud']}},
  calls:[priceCall('priced','openai','gpt-6-astra'),priceCall('aliased','ollama-cloud','gpt-oss:120b-cloud')],
  catalog:{}});
 await f.collector.collect();
 const real=await f.collector.snapshot();
 const world=buildFixture();
 const keys=value=>Object.keys(value).sort();
 const realOf=(id,model)=>real.providers.find(p=>p.id===id).analytics.modelPrices.find(r=>r.model===model);
 const worldOf=(id,model)=>world.providers.find(p=>p.id===id).analytics.modelPrices.find(r=>r.model===model);
 const realRow=realOf('openai','gpt-6-astra'),worldRow=worldOf('openai','gpt-6-astra');
 // 같은 키를 쓰는가. check:ui 는 fixture 서버를 쓰므로 화면 단언만으로는 이것이 증명되지 않는다.
 assert.deepEqual(keys(worldRow),keys(realRow));
 assert.deepEqual(keys(worldRow.rates),keys(realRow.rates));
 assert.deepEqual(keys(worldRow.priceConditions[0]),keys(realRow.priceConditions[0]));
 assert.deepEqual(keys(worldRow.priceConditions[0].rates),keys(realRow.priceConditions[0].rates));
 // 같은 뜻으로 쓰는가. 조건의 순서, 임계값, 배수가 실제 응답과 같아야 화면 단언이 옳은 이유로 통과한다.
 assert.deepEqual(worldRow.priceConditions.map(c=>c.id),realRow.priceConditions.map(c=>c.id));
 const at=(row,id)=>row.priceConditions.find(c=>c.id===id);
 assert.equal(at(worldRow,'long-context').inputTokensFrom,at(realRow,'long-context').inputTokensFrom);
 assert.equal(at(worldRow,'service-tier-priority').tierMultiplier,at(realRow,'service-tier-priority').tierMultiplier);
 assert.deepEqual(worldRow.rates,realRow.rates);
 const realAlias=realOf('ollama-cloud','gpt-oss:120b-cloud'),worldAlias=worldOf('ollama-cloud','gpt-oss:120b-cloud');
 assert.equal(worldAlias.pricedModel,realAlias.pricedModel);
 assert.deepEqual(worldAlias.unsupported,realAlias.unsupported);
 assert.deepEqual(worldAlias.rates,realAlias.rates);
 // 미확인은 어느 쪽에서도 0 이 아니다.
 const realUnpriced=realOf('openai','never-priced-model');
 const worldUnpriced=world.providers.find(p=>p.id==='openai').analytics.modelPrices.find(r=>r.status==='unpriced');
 assert.deepEqual(keys(worldUnpriced),keys(realUnpriced));
 assert.deepEqual(realUnpriced.rates,{input:null,output:null,cacheRead:null,cacheWrite:null});
 assert.deepEqual(worldUnpriced.rates,realUnpriced.rates);
 assert.deepEqual(worldUnpriced.priceConditions.map(c=>c.id),realUnpriced.priceConditions.map(c=>c.id));
 // 화면은 이 세 자료를 한 줄로 합쳐 읽는다. 셋 다 같은 키를 써야 그 합치기가 성립한다.
 const realEvidence=evidenceOf(real,'openai').find(r=>r.evidence);
 const worldEvidence=world.providers.find(p=>p.id==='anthropic').analytics.priceEvidence[0];
 assert.deepEqual(keys(worldEvidence),keys(realEvidence));
 assert.deepEqual(keys(worldEvidence.evidence),keys(realEvidence.evidence));
 assert.deepEqual(keys(worldEvidence.evidence.rates),keys(realEvidence.evidence.rates));
 const realRoster=real.providers.find(p=>p.id==='openai').analytics.modelRoster;
 const worldRoster=world.providers.find(p=>p.id==='openai').analytics.modelRoster;
 assert.deepEqual(keys(worldRoster),keys(realRoster));
 assert.deepEqual(keys(worldRoster.models[0]),keys(realRoster.models[0]));
 assert.deepEqual(['listed','observed-only','removed'].includes(worldRoster.models[0].state),true);
 // 조건 코드의 설명은 서버가 한곳에서 내려준다. fixture 가 그 목록을 복제하면 화면 글자가 갈린다.
 assert.deepEqual(Object.keys(world.analytics.modelPriceConditions).sort(),
  Object.keys(real.analytics.modelPriceConditions).sort());
});
