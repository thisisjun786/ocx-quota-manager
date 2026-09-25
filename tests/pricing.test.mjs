import test from 'node:test';import assert from 'node:assert/strict';import {OLLAMA_CREDIT_PLANS,USER_SUBSCRIPTIONS,ollamaModelPricing,priceUsage,lookupSubscription,lookupModelPrice,listModelPriceConditions,PRICE_CONDITIONS} from '../src/pricing.mjs';
const row=(model,usage,provider='openai',extra={})=>({model,provider,usageStatus:'reported',usage,...extra});
test('unknown models, missing and contradictory tokens remain unpriced',()=>{
 for(const r of [row('no-model',{}),row('gpt-6-astra',{}),row('gpt-6-astra',{inputTokens:2,outputTokens:1,cacheReadInputTokens:5})])assert.equal(priceUsage(r).usd,null);
 assert.equal(priceUsage(row('gpt-6-astra',{inputTokens:1,outputTokens:2},'xai')).usd,null);
});
test('cache included in input and reasoning included in output are never counted twice',()=>{
 const r=priceUsage(row('gpt-6-astra',{inputTokens:100000,outputTokens:1000,cacheReadInputTokens:80000,reasoningOutputTokens:500}));
 assert.equal(r.usd,.33);
});
test('OpenAI long context and confirmed fast tier apply correct rates',()=>{
 const r=priceUsage(row('gpt-6-astra',{inputTokens:300000,outputTokens:1000},'openai',{tierOutcome:{responseServiceTier:'priority'}}));assert.equal(r.usd,12.15);
});
test('Fable cache writes are an explicit 5-minute estimate; cache hits use 0.025x',()=>{
 const r=priceUsage(row('claude-fable-5-1',{inputTokens:100000,outputTokens:1000,cacheReadInputTokens:80000,cacheCreationInputTokens:10000},'anthropic'));assert.equal(r.usd,.295);assert.equal(r.basis,'local-catalog');
});
test('Grok >=200k doubles all token rates and unsupported tier combinations stay unknown',()=>{
 assert.equal(priceUsage(row('grok-4.6',{inputTokens:200000,outputTokens:1000},'xai')).usd,.812);
 assert.equal(priceUsage(row('grok-4.6',{inputTokens:200000,outputTokens:1000},'xai',{responseServiceTier:'priority'})).usd,null);
});
test('ambiguous Pro and unknown plans are not guessed; exact tiers use verified list prices',()=>{
 assert.equal(lookupSubscription('openai','pro').monthlyUsd,null);assert.equal(lookupSubscription('anthropic',null).monthlyUsd,null);
 assert.equal(lookupSubscription('anthropic','default_claude_max_20x').monthlyUsd,200);assert.equal(lookupSubscription('cursor','ultra').monthlyUsd,200);
});

test('requested priority alone does not prove a billed priority tier',()=>{
 assert.equal(priceUsage(row('gpt-6-astra',{inputTokens:1000,outputTokens:1000},'openai',{requestedServiceTier:'priority'})).usd,null);
});

test('Ollama reference prices preserve model sizes and cache discounts with provider isolation',()=>{
 const usage={inputTokens:1000000,outputTokens:1000000,cachedInputTokens:500000};
 assert.equal(priceUsage(row('glm-5.3-flash',usage,'ollama-cloud')).usd,.59);
 assert.equal(priceUsage(row('gpt-oss:120b-cloud',{inputTokens:1000000,outputTokens:0},'ollama-cloud')).usd,.15);
 assert.equal(priceUsage(row('gpt-oss:20b',{inputTokens:1000000,outputTokens:0},'ollama-cloud')).usd,.07);
 assert.equal(priceUsage(row('glm-5.3-flash',usage,'openai')).usd,null);
 assert.equal(priceUsage(row('glm-5.3-flash:unverified',usage,'ollama-cloud')).usd,null);
 assert.equal(priceUsage(row('mistral-large-3',usage,'ollama-cloud')).usd,null);
 assert.equal(priceUsage(row('glm-5.3-flash',usage,'ollama-cloud',{usageStatus:'unreported'})).usd,null);
});
test('Ollama DeepSeek peak applies only weekdays 12 through 18 UTC and requires timestamp',()=>{
 const usage={inputTokens:1000000,outputTokens:1000000};
 const cost=time=>priceUsage(row('deepseek-v4-flash:0731',usage,'ollama-cloud',{timestamp:Date.parse(time)})).usd;
 assert.equal(cost('2026-09-09T11:59:59Z'),.88);
 assert.equal(cost('2026-09-09T12:00:00Z'),1.76);
 assert.equal(cost('2026-09-09T17:59:59Z'),1.76);
 assert.equal(cost('2026-09-09T18:00:00Z'),.88);
 assert.equal(cost('2026-09-12T13:00:00Z'),.88);
 assert.equal(priceUsage(row('deepseek-v4-flash',usage,'ollama-cloud')).usd,null);
 assert.equal(priceUsage(row('deepseek-v4-pro:0813-cloud',usage,'ollama-cloud',{timestamp:Date.parse('2026-09-09T06:00Z')})).usd,2.64);
});

// Cursor forwards known models; token estimates affect confidence, not provider eligibility.
test('Cursor Grok uses API-equivalent rates and preserves estimated-token basis',()=>{
 const result=priceUsage(row('grok-4.6',{inputTokens:100000,outputTokens:1000,estimated:true},'cursor',{usageStatus:'estimated'}));
 assert.equal(result.usd,.206);assert.equal(result.basis,'local-catalog');
 assert.equal(priceUsage(row('grok-4.6',{inputTokens:100000,outputTokens:1000},'anthropic')).usd,null);
});

test('all 19 published Ollama model prices have their published input, cache-read and output rates',()=>{
 const expected=[
  ['deepseek-v4-flash',.22,.007,.66],['deepseek-v4-pro',.66,.022,1.98],['gemma4',.14,.05,.4],['glm-5.3',1.4,.26,4.4],['glm-5.3-flash',.15,.03,.5],['glm-5.2',1.4,.26,4.4],['glm-5.1',1,.2,3.2],['gpt-oss:120b',.15,.014,.6],['gpt-oss:20b',.07,.035,.3],['kimi-k3',3,.3,15],['kimi-k2.7-code',.95,.19,4],['kimi-k2.6',.95,.16,4],['minimax-m3',.6,.12,2.4],['minimax-m2.7',.3,.06,1.2],['mistral-large-3',.5,null,1.5],['nemotron-3-nano',.06,null,.24],['nemotron-3-super',.015,.015,.6],['nemotron-3-ultra',.1,.1,3],['qwen3.5:397b',.6,null,3.6],
 ];
 for(const [model,inputUsdPerMillion,cachedInputUsdPerMillion,outputUsdPerMillion] of expected){
  const actual=ollamaModelPricing(model,Date.parse('2026-09-09T11:59:59Z'));
  assert.deepEqual(actual,{model,inputUsdPerMillion,cachedInputUsdPerMillion,outputUsdPerMillion,peak:false,sourceUrl:'https://ollama.com/pricing',checkedAt:'2026-09-10'});
 }
});

test('Ollama aliases canonicalize and DeepSeek rates change only at official peak boundaries',()=>{
 const before=ollamaModelPricing('deepseek-v4-flash:0731-cloud',Date.parse('2026-09-09T11:59:59Z'));
 const starts=ollamaModelPricing('deepseek-v4-flash:0731',Date.parse('2026-09-09T12:00:00Z'));
 const ends=ollamaModelPricing('deepseek-v4-flash',Date.parse('2026-09-09T18:00:00Z'));
 const weekend=ollamaModelPricing('deepseek-v4-flash',Date.parse('2026-09-12T13:00:00Z'));
 assert.equal(ollamaModelPricing('gpt-oss:120b-cloud',Date.parse('2026-09-09T12:00:00Z')).model,'gpt-oss:120b');
 assert.deepEqual([before.inputUsdPerMillion,before.cachedInputUsdPerMillion,before.outputUsdPerMillion,before.peak],[.22,.007,.66,false]);
 assert.deepEqual([starts.inputUsdPerMillion,starts.cachedInputUsdPerMillion,starts.outputUsdPerMillion,starts.peak],[.44,.014,1.32,true]);
 assert.deepEqual([ends.inputUsdPerMillion,ends.cachedInputUsdPerMillion,ends.outputUsdPerMillion,ends.peak],[.22,.007,.66,false]);
 assert.equal(weekend.peak,false);
 assert.equal(ollamaModelPricing('deepseek-v4-flash'),null);
 assert.equal(ollamaModelPricing('unpublished-model',Date.now()),null);
});

test('all account-provider suffixes use the same price-validation provider',()=>{
 const usage={inputTokens:100000,outputTokens:1000};
 for(const provider of ['openai-main','openai-pabcdef','openai-oabcdef','openai-kabcdef'])assert.equal(priceUsage(row('gpt-6-astra',usage,provider)).usd,1.05);
 assert.equal(priceUsage(row('gpt-6-astra',usage,'xai-oabcdef')).usd,null);
});

test('user-confirmed subscription overrides are opt-in and win over conflicting detected plans',()=>{
 const generic=lookupSubscription('openai','plus');
 const actual=lookupSubscription('openai','plus',USER_SUBSCRIPTIONS);
 assert.equal(generic.monthlyUsd,20);
 assert.deepEqual(actual,{monthlyUsd:200,label:'ChatGPT Pro',basis:'user-confirmed',sourceUrl:null,checkedAt:'2026-09-10',reason:'사용자가 확인한 월 구독료 기준'});
 assert.equal(lookupSubscription('opencode-go',null,USER_SUBSCRIPTIONS).monthlyUsd,10);
 assert.equal(lookupSubscription('ollama-cloud','pro',USER_SUBSCRIPTIONS).label,'Ollama Cloud Max (구버전)');
 assert.deepEqual(OLLAMA_CREDIT_PLANS.pro,{monthlyUsd:20,includedCreditsUsd:60,sourceUrl:'https://ollama.com/pricing',checkedAt:'2026-09-10'});
 assert.deepEqual(OLLAMA_CREDIT_PLANS.max,{monthlyUsd:100,includedCreditsUsd:300,sourceUrl:'https://ollama.com/pricing',checkedAt:'2026-09-10'});
 assert.deepEqual(OLLAMA_CREDIT_PLANS.team,{monthlyUsd:500,includedCreditsUsd:1000,sourceUrl:'https://ollama.com/pricing',checkedAt:'2026-09-10'});
});

test('verified GPT-5.4 mini and Composer 2.5 Fast rates avoid unsupported cache writes and tiers',()=>{
 const usage={inputTokens:1000000,outputTokens:1000000,cachedInputTokens:500000};
 assert.equal(priceUsage(row('gpt-5.4-mini',{inputTokens:100000,outputTokens:100000,cachedInputTokens:50000})).usd,.49125);
 assert.equal(priceUsage(row('gpt-5.4-mini',{inputTokens:300000,outputTokens:1000})).usd,null);
 assert.equal(priceUsage(row('gpt-5.4-mini',{inputTokens:1000,outputTokens:1000},'openai',{responseServiceTier:'fast'})).usd,null);
 assert.equal(priceUsage(row('gpt-5.4-mini',{inputTokens:1000,outputTokens:1000,cacheCreationInputTokens:1})).usd,null);
 assert.equal(priceUsage(row('composer-2.5-fast',usage,'cursor')).usd,16.75);
 assert.equal(priceUsage(row('composer-2.5-fast',{inputTokens:1000,outputTokens:1000,cacheCreationInputTokens:1},'cursor')).usd,null);
});

const AT=Date.parse('2026-09-11T12:00:00Z');

test('a unit price belongs to one provider and never crosses to another',()=>{
 // Same model ID, two providers, two published tariffs and two different schedules.
 const ollama=lookupModelPrice('ollama-cloud','deepseek-v4-flash',{timestamp:AT});
 const go=lookupModelPrice('opencode-go','deepseek-v4-flash',{timestamp:AT});
 assert.deepEqual([ollama.rates.input,ollama.rates.output],[.44,1.32]);
 assert.deepEqual([go.rates.input,go.rates.output],[.15,.6]);
 // Anthropic's rate reaches Cursor only because a route says Cursor forwards it.
 assert.equal(lookupModelPrice('anthropic','claude-opus-5').rates.input,5);
 assert.equal(lookupModelPrice('cursor','claude-opus-5').rates.input,5);
 for(const provider of ['xai','opencode-go','google'])assert.equal(lookupModelPrice(provider,'claude-opus-5').status,'unpriced',provider);
 // An account suffix is the same provider; another vendor is not.
 assert.equal(lookupModelPrice('openai-pabcdef','gpt-6-astra').rates.input,10);
 assert.equal(lookupModelPrice('xai-oabcdef','gpt-6-astra').status,'unpriced');
 assert.equal(lookupModelPrice('openai',null).status,'unpriced');
 // Asking without conditions is a question, not an error.
 assert.equal(lookupModelPrice('openai','gpt-6-astra',null).rates.input,10);
 assert.equal(lookupModelPrice('openai','gpt-6-astra',undefined).rates.input,10);
});

test('the quoted unit price reproduces the recorded amount for the same conditions',()=>{
 const cases=[
  [{provider:'openai',model:'gpt-6-astra',usage:{inputTokens:300000,outputTokens:1000},tierOutcome:{responseServiceTier:'priority'}},12.15],
  [{provider:'openai',model:'gpt-6-astra',usage:{inputTokens:100000,outputTokens:1000,cacheReadInputTokens:80000}},.33],
  [{provider:'anthropic',model:'claude-fable-5-1',usage:{inputTokens:100000,outputTokens:1000,cacheReadInputTokens:80000,cacheCreationInputTokens:10000}},.295],
  [{provider:'xai',model:'grok-4.6',usage:{inputTokens:200000,outputTokens:1000}},.812],
  [{provider:'opencode-go',model:'deepseek-flash',usage:{inputTokens:20000,outputTokens:100,cachedInputTokens:10000}},.00159],
  [{provider:'ollama-cloud',model:'glm-5.3-flash',usage:{inputTokens:1000000,outputTokens:1000000,cachedInputTokens:500000}},.59],
 ];
 for(const [partial,expected] of cases){
  const r={timestamp:AT,usageStatus:'reported',...partial},u=r.usage;
  const price=lookupModelPrice(r.provider,r.model,{timestamp:r.timestamp,inputTokens:u.inputTokens,tierOutcome:r.tierOutcome});
  let read=u.cacheReadInputTokens??u.cachedInputTokens??0;
  const write=u.cacheCreationInputTokens??0;
  if(read+write>u.inputTokens&&u.cacheReadInputTokens===undefined&&u.cachedInputTokens!==undefined)read=Math.max(0,read-write);
  const quoted=((u.inputTokens-read-write)*price.rates.input+u.outputTokens*price.rates.output
   +read*price.rates.cacheRead+write*(price.rates.cacheWrite??0))/1e6*price.tierMultiplier;
  // The hand-written expectation, the quote and the valuation must all be the same number.
  assert.equal(priceUsage(r).usd,expected,r.model);
  assert.equal(quoted,expected,`quoted ${r.model}`);
 }
});

test('a missing cache price stays missing and an unsupported field is never advertised as free',()=>{
 const mistral=lookupModelPrice('ollama-cloud','mistral-large-3',{timestamp:AT});
 assert.equal(mistral.rates.cacheRead,null);
 assert.equal(mistral.rates.cacheWrite,null);
 assert.deepEqual(mistral.unsupported,['cache-write']);
 // The Ollama tuple stores 0 in that slot, but the valuation refuses any positive write.
 assert.equal(priceUsage({provider:'ollama-cloud',model:'mistral-large-3',timestamp:AT,usageStatus:'reported',
  usage:{inputTokens:1000,outputTokens:0,cacheCreationInputTokens:1}}).usd,null);
 assert.equal(lookupModelPrice('openai','gpt-5.4-mini').rates.cacheWrite,null);
 assert.equal(lookupModelPrice('cursor','composer-2.5-fast').rates.cacheWrite,null);
 // A published zero is a real free rate and stays zero.
 assert.equal(lookupModelPrice('xai','grok-4.6').rates.cacheWrite,0);
});

test('a promotional rate stops at its published end instead of being assumed onward',()=>{
 const before=Date.parse('2026-12-31T23:59:59Z'),ends=Date.parse('2027-01-01T00:00:00Z');
 const promo=lookupModelPrice('google','gemini-3.8-flash',{timestamp:before});
 assert.equal(promo.rates.input,.75);
 assert.equal(promo.effectiveTo,'2027-01-01T00:00:00.000Z');
 assert.ok(promo.conditions.includes('promotional'));
 for(const provider of ['google','cursor']){
  assert.equal(lookupModelPrice(provider,'gemini-3.8-flash',{timestamp:ends}).status,'unpriced',provider);
  assert.equal(lookupModelPrice(provider,'gemini-3.8-flash',{timestamp:ends+86400000}).status,'unpriced',provider);
 }
 // No timestamp is not evidence of a future call. A one-way cliff is not a peak schedule.
 assert.equal(lookupModelPrice('google','gemini-3.8-flash',{}).rates.input,.75);
 const at=t=>({provider:'google',model:'gemini-3.8-flash',timestamp:t,usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}});
 assert.equal(priceUsage(at(before)).usd,.001125);
 assert.equal(priceUsage(at(ends)).usd,null);
});

test('the new evidence grade leaves the persisted estimate flag untouched',()=>{
 // basis is stored on every usage row and counted as localPriceRequests, so it keeps
 // its two values. The finer provenance lives only on the lookup.
 const daybreak={provider:'openai-main',model:'gpt-daybreak-blue-latest',usageStatus:'reported',
  usage:{inputTokens:100000,outputTokens:1000,cachedInputTokens:80000}};
 assert.equal(priceUsage(daybreak).basis,'local-catalog');
 assert.equal(priceUsage({provider:'google',model:'gemini-3.8-flash',timestamp:AT,usageStatus:'reported',
  usage:{inputTokens:1000,outputTokens:100}}).basis,'local-catalog');
 assert.equal(lookupModelPrice('openai','gpt-daybreak-blue-latest').status,'ocx-provided');
 assert.equal(lookupModelPrice('openai','gpt-daybreak-blue-latest').checkedAt,'2026-08-11');
 assert.equal(lookupModelPrice('google','gemini-3.8-flash').status,'ocx-provided');
 assert.equal(lookupModelPrice('google','gemini-3.8-flash').checkedAt,'2026-09-03');
 assert.equal(lookupModelPrice('openai','gpt-6-astra').status,'official');
 assert.equal(lookupModelPrice('openai','gpt-6-astra').checkedAt,'2026-09-10');
 assert.equal(lookupModelPrice('openai','gpt-6-astra').unit,'usd-per-million-tokens');
});

test('the lookup applies the same service-tier rule as the valuation',()=>{
 // An ordinary requested tier is acceptable; an unproven priority is not.
 assert.equal(lookupModelPrice('openai','gpt-6-astra',{requestedServiceTier:'default'}).rates.input,10);
 assert.equal(lookupModelPrice('openai','gpt-6-astra',{requestedServiceTier:'priority'}).status,'unpriced');
 assert.equal(priceUsage(row('gpt-6-astra',{inputTokens:1000,outputTokens:1000},'openai',{requestedServiceTier:'default'})).usd,.06);
 assert.equal(lookupModelPrice('openai','gpt-6-astra',{responseServiceTier:'priority'}).tierMultiplier,2);
 assert.equal(lookupModelPrice('openai','gpt-6-astra',{responseServiceTier:'flex'}).tierMultiplier,.5);
 assert.equal(lookupModelPrice('anthropic','claude-opus-5',{responseServiceTier:'priority'}).status,'unpriced');
 assert.equal(lookupModelPrice('xai','grok-4.6',{responseServiceTier:'priority',inputTokens:200000}).status,'unpriced');
 assert.equal(lookupModelPrice('openai','gpt-5.4-mini',{inputTokens:300000}).status,'unpriced');
});

test('a declared tier condition means that tier is actually priced, and none is omitted',()=>{
 // The label used to promise flex and batch at half price for xAI, which the valuation
 // refuses. Conditions are derived from real support instead of a shared sentence.
 const providers=['openai','openai-apikey','chatgpt','openai-multi','cursor','xai','anthropic','google','opencode-go'];
 const models=['gpt-6-astra','gpt-5.4-mini','gpt-5.6-luna','grok-4.6','claude-opus-5','gemini-3.8-flash','composer-2.5-fast'];
 let compared=0;
 for(const provider of providers)for(const model of models)for(const inputTokens of [1000,199999,200000,272001]){
  const quote=lookupModelPrice(provider,model,{timestamp:AT,inputTokens});
  if(quote.status==='unpriced')continue;
  const at=tier=>lookupModelPrice(provider,model,{timestamp:AT,inputTokens,responseServiceTier:tier});
  assert.equal(quote.conditions.includes('service-tier-priority'),at('priority').tierMultiplier===2,`priority ${provider}/${model}@${inputTokens}`);
  assert.equal(quote.conditions.includes('service-tier-priority'),at('fast').tierMultiplier===2,`fast ${provider}/${model}@${inputTokens}`);
  assert.equal(quote.conditions.includes('service-tier-discount'),at('flex').tierMultiplier===.5,`flex ${provider}/${model}@${inputTokens}`);
  assert.equal(quote.conditions.includes('service-tier-discount'),at('batch').tierMultiplier===.5,`batch ${provider}/${model}@${inputTokens}`);
  for(const id of quote.conditions)assert.ok(PRICE_CONDITIONS[id],`missing label for ${id}`);
  compared++;
 }
 assert.ok(compared>=80,`compared ${compared}`);
 // The three shapes that motivated the split.
 const xai=lookupModelPrice('xai','grok-4.6',{timestamp:AT,inputTokens:1000});
 assert.deepEqual([xai.conditions.includes('service-tier-priority'),xai.conditions.includes('service-tier-discount')],[true,false]);
 assert.equal(lookupModelPrice('xai','grok-4.6',{timestamp:AT,inputTokens:1000,responseServiceTier:'flex'}).status,'unpriced');
 const longXai=lookupModelPrice('xai','grok-4.6',{timestamp:AT,inputTokens:200000});
 assert.equal(longXai.conditions.includes('service-tier-priority'),false);
 const mini=lookupModelPrice('openai','gpt-5.4-mini',{timestamp:AT,inputTokens:1000});
 assert.deepEqual([mini.conditions.includes('service-tier-priority'),mini.conditions.includes('service-tier-discount')],[false,true]);
});

test('source conflict compares two prices conditioned the same way',()=>{
 const catalog=tuple=>()=>tuple;
 const astra=(inputTokens,tuple)=>lookupModelPrice('openai','gpt-6-astra',{timestamp:AT,inputTokens,catalog:catalog(tuple)});
 const base=[10,50,1,12.5,null,'local-catalog'],long=[20,75,2,25,null,'local-catalog'];
 // Below the threshold both sides state the base tuple: agreement.
 assert.equal(astra(100000,base).conflict,null);
 // Above it the built-in effective rate is 20/75 while the catalog still states 10/50.
 // Comparing the catalog against the built-in BASE tuple used to hide this.
 const differs=astra(300000,base);
 assert.deepEqual([differs.rates.input,differs.rates.output],[20,75]);
 assert.deepEqual(differs.conflict.rates,{input:10,output:50,cacheRead:1,cacheWrite:12.5});
 // And when the catalog carries its own matching long-context tier the two agree, even
 // though the catalog tuple differs from the built-in base tuple.
 assert.equal(astra(300000,long).conflict,null);
 // An omitted field is absence of a claim, not disagreement.
 assert.equal(astra(1000,[10,50,null,null,null,'local-catalog']).conflict,null);
 // The catalog has no service tier and no peak schedule, so under either it states
 // nothing comparable and silence must not be published as agreement or disagreement.
 const priority=lookupModelPrice('openai','gpt-6-astra',{timestamp:AT,inputTokens:1000,responseServiceTier:'priority',catalog:catalog([9,9,9,9,null,'local-catalog'])});
 assert.equal(priority.tierMultiplier,2);
 assert.equal(priority.conflict,null);
 const nine=catalog([9,9,9,null,null,'local-catalog']);
 const offPeak=lookupModelPrice('opencode-go','deepseek-flash',{timestamp:Date.parse('2026-09-14T14:00:00Z'),inputTokens:1000,catalog:nine});
 const onPeak=lookupModelPrice('opencode-go','deepseek-flash',{timestamp:Date.parse('2026-09-14T02:00:00Z'),inputTokens:1000,catalog:nine});
 assert.deepEqual([offPeak.rates.input,offPeak.rates.output],[.15,.6]);
 assert.notEqual(offPeak.conflict,null);
 assert.deepEqual([onPeak.rates.input,onPeak.rates.output],[.3,1.2]);
 assert.equal(onPeak.conflict,null);
 // Effective rates are products of published decimals: 1.2 * 1.5 is 1.7999999999999998.
 // That is the same price as 1.8, and a strict comparison would call it a disagreement.
 const luna=(tuple)=>lookupModelPrice('openai','gpt-5.6-luna',{timestamp:AT,inputTokens:300000,catalog:()=>tuple});
 const drifted=luna([.4,1.8,.04,.5,null,'local-catalog']);
 assert.equal(drifted.rates.output,1.7999999999999998);
 assert.equal(drifted.conflict,null);
 assert.notEqual(luna([.4,1.9,.04,.5,null,'local-catalog']).conflict,null);
});

// JUN-45 (a): a reselling surface publishes its own tariff for models it forwards, so the
// provider is part of the key. Devin's published cache read is 0.30 where xAI's own is 0.50.
test('Devin provider rates are keyed by provider and never bleed across surfaces',()=>{
 const usage={inputTokens:100000,outputTokens:10000,cacheReadInputTokens:20000};
 assert.equal(priceUsage(row('grok-4-6',usage,'devin')).usd,.226);
 assert.equal(priceUsage(row('grok-4.6',usage,'xai')).usd,.23);
 // Devin's dashed ID never bills at xAI, and xAI's dotted ID never bills at Devin.
 assert.equal(priceUsage(row('grok-4-6',usage,'xai')).usd,null);
 assert.equal(priceUsage(row('grok-4.6',usage,'devin')).usd,null);
});
test('Devin kimi-k3 prices input, cache read and output, and refuses unpublished conditions',()=>{
 const usage={inputTokens:1000000,outputTokens:100000,cacheReadInputTokens:200000};
 // (1M-200k)*3 + 100k*15 + 200k*0.3 = 2.40 + 1.50 + 0.06
 assert.equal(priceUsage(row('kimi-k3',usage,'devin')).usd,3.96);
 assert.equal(priceUsage(row('kimi-k3',usage,'devin-cli')).usd,3.96);
 // A transcribed price stays an explicit estimate; swe-2's first-hand reading does not.
 assert.equal(priceUsage(row('kimi-k3',usage,'devin')).basis,'local-catalog');
 assert.equal(priceUsage(row('swe-2',usage,'devin')).basis,'official');
 // Devin publishes no cache write here and no priced service tier.
 assert.equal(priceUsage(row('kimi-k3',{inputTokens:1000000,outputTokens:100000,cacheCreationInputTokens:50000},'devin')).usd,null);
 assert.equal(priceUsage(row('kimi-k3',usage,'devin',{responseServiceTier:'priority'})).usd,null);
 assert.equal(priceUsage(row('kimi-k3',usage,'openai')).usd,null);
 // The Ollama alias and peak paths keep working through the same shared lookup.
 assert.equal(priceUsage(row('glm-5.3-flash',{inputTokens:1000000,outputTokens:1000000,cachedInputTokens:500000},'ollama-cloud')).usd,.59);
 assert.equal(priceUsage(row('deepseek-v4-flash:0731',{inputTokens:1000000,outputTokens:1000000},'ollama-cloud',{timestamp:Date.parse('2026-09-09T12:00:00Z')})).usd,1.76);
});

// JUN-45 (b): three evidence grades stay distinguishable on one provider.
test('provider evidence grades separate first-hand, OCX-provided and unpriced',()=>{
 const own=lookupModelPrice('devin','swe-2');
 assert.equal(own.status,'official');
 assert.equal(own.checkedAt,'2026-09-15');
 const ocx=lookupModelPrice('devin','kimi-k3');
 assert.equal(ocx.status,'ocx-provided');
 assert.equal(ocx.checkedAt,'2026-09-13');
 assert.equal(ocx.sourceUrl,'https://docs.devin.ai/desktop/models');
 assert.deepEqual(ocx.rates,{input:3,output:15,cacheRead:.3,cacheWrite:null});
 assert.ok(ocx.conditions.includes('list-price-reference'));
 // A rate the provider does not publish is declared, not left as a silent null.
 assert.ok(ocx.unsupported.includes('cache-write'));
 assert.equal(lookupModelPrice('ollama-cloud','qwen3-coder:480b').status,'unpriced');
 // A normalized ID must keep the provenance of the row that actually priced it, or a
 // transcribed rate would quietly report itself as an anonymous catalog row.
 for(const provider of ['devin','devin-cli'])for(const id of ['kimi-k3-high','claude-opus-5-high']){
  const suffixed=lookupModelPrice(provider,id);
  assert.equal(suffixed.status,'ocx-provided',`${provider}/${id}`);
  assert.equal(suffixed.checkedAt,'2026-09-13',`${provider}/${id}`);
  assert.match(suffixed.reason,/expected-prices/,`${provider}/${id}`);
 }
 // The row read from the provider's page carries its own later date without moving swe-2's.
 assert.equal(lookupModelPrice('devin','gemini-3-8-flash',{timestamp:Date.parse('2026-09-17T00:00:00Z')}).checkedAt,'2026-09-17');
 assert.equal(lookupModelPrice('command-code','deepseek/deepseek-v4.1-flash',{timestamp:Date.parse('2026-09-17T12:00:00Z')}).checkedAt,'2026-09-17');
});

// JUN-45 (c): a target we could not confirm keeps usd null, carries its own reason, and is
// never filled from another provider's price or from a subscription fee.
test('unconfirmed targets record why, and no other price is substituted',()=>{
 const big={inputTokens:1000000,outputTokens:100000};
 // Command Code publishes its own table for the DeepSeek models it forwards, including the
 // weekday UTC peak windows, so those rows are priced from that table rather than excluded.
 const offPeak=Date.parse('2026-09-17T12:00:00Z'),peak=Date.parse('2026-09-17T02:00:00Z');
 assert.equal(priceUsage({...row('deepseek/deepseek-v4.1-flash',big,'command-code'),timestamp:offPeak}).usd,.21);
 assert.equal(priceUsage({...row('deepseek/deepseek-v4.1-flash',big,'command-code'),timestamp:peak}).usd,.42);
 // The published peak statement raises input and output only, so cache read keeps one figure.
 const quote=lookupModelPrice('command-code','deepseek/deepseek-v4.1-flash',{timestamp:peak});
 assert.equal(quote.rates.cacheRead,.003);
 assert.equal(quote.sourceUrl,'https://commandcode.ai/docs/resources/pricing-limits');
 // Without an instant the peak window cannot be decided, so nothing is guessed.
 assert.equal(priceUsage(row('deepseek/deepseek-v4.1-flash',big,'command-code')).usd,null);
 // A model with no row in that table is not filled from the upstream vendor or a credit multiplier.
 const absent=lookupModelPrice('command-code','vendor/model-with-no-published-row',{timestamp:offPeak});
 assert.equal(absent.status,'unpriced');
 assert.equal(absent.rates.input,null);
 assert.match(absent.reason,/공개 단가표에서 이 모델의 행을 확인하지 못해/);
 // An Ollama size tag with no published row is not filled from a reseller aggregator,
 // and the monthly subscription fee never becomes a token rate.
 const tag=priceUsage(row('qwen3-coder:480b',{inputTokens:1000000,outputTokens:0},'ollama-cloud'));
 assert.equal(tag.usd,null);
 assert.match(tag.reason,/재판매/);
 assert.equal(USER_SUBSCRIPTIONS['ollama-cloud'].monthlyUsd,100);
 assert.equal(lookupModelPrice('google','gemini-3.8-flash').status,'ocx-provided');
});


// JUN-45: a provider that publishes a dated pair is priced by when the call happened, so an
// ended introductory rate is neither extended nor left as the only known number.
test('a dated provider tariff prices each call by its own instant',()=>{
 const usage={inputTokens:1000000,outputTokens:100000};
 const during=Date.parse('2026-09-17T00:00:00Z'),after=Date.parse('2027-01-02T00:00:00Z');
 const intro=lookupModelPrice('devin','gemini-3-8-flash',{timestamp:during});
 assert.equal(intro.status,'official');
 assert.equal(intro.rates.input,.75);
 assert.equal(intro.rates.output,3.75);
 assert.equal(intro.effectiveTo,'2027-01-01T00:00:00.000Z');
 assert.ok(intro.conditions.includes('promotional'));
 const regular=lookupModelPrice('devin','gemini-3-8-flash',{timestamp:after});
 assert.equal(regular.rates.input,1.5);
 assert.equal(regular.rates.output,7.5);
 assert.equal(regular.effectiveFrom,'2027-01-01T00:00:00.000Z');
 assert.equal(regular.conditions.includes('promotional'),false);
 // 1M input at 0.75 plus 100k output at 3.75, then the same call after the step-up.
 assert.equal(priceUsage(row('gemini-3-8-flash',usage,'devin',{timestamp:during})).usd,1.125);
 assert.equal(priceUsage(row('gemini-3-8-flash',usage,'devin',{timestamp:after})).usd,2.25);
 // Effort suffixes collapse to the base ID the way the provider's own catalog does.
 for(const id of ['gemini-3-8-flash-high','gemini-3-8-flash-low','gemini-3-8-flash-medium'])
  assert.equal(lookupModelPrice('devin',id,{timestamp:during}).rates.input,.75,id);
 // Devin publishes no cache rate for this model, so cache tokens are declared and stay unpriced
 // instead of borrowing the upstream vendor's cache numbers.
 assert.ok(regular.unsupported.includes('cache-read'));
 assert.equal(priceUsage(row('gemini-3-8-flash',{...usage,cacheReadInputTokens:200000},'devin',{timestamp:during})).usd,null);
 // The upstream vendor's own row is unaffected and keeps its separate published end date.
 assert.equal(lookupModelPrice('google','gemini-3.8-flash',{timestamp:during}).rates.input,.75);
assert.equal(lookupModelPrice('google','gemini-3.8-flash',{timestamp:after}).status,'unpriced');
});
const CONDITIONS_AT = Date.parse('2026-09-16T09:00:00Z');
test('every billing condition is enumerated with its own threshold, multiplier and rates',()=>{
 const astra=listModelPriceConditions('openai','gpt-6-astra',{timestamp:CONDITIONS_AT});
 assert.deepEqual(astra.conditions.map(c=>c.id),['default','long-context','service-tier-priority','service-tier-discount']);
 // 열거한 단가는 그 조건에서 실제로 물리는 단가여야 한다. 같은 질문을 lookupModelPrice 에
 // 직접 던져 같은 답이 나오는지로 확인한다.
 const long=astra.conditions.find(c=>c.id==='long-context');
 assert.equal(long.inputTokensFrom,272001);
 assert.deepEqual(long.rates,lookupModelPrice('openai','gpt-6-astra',{timestamp:CONDITIONS_AT,inputTokens:272001}).rates);
 // 임계값 바로 아래는 여전히 기본 조건이다.
 assert.deepEqual(lookupModelPrice('openai','gpt-6-astra',{timestamp:CONDITIONS_AT,inputTokens:272000}).rates,astra.conditions[0].rates);
 const priority=astra.conditions.find(c=>c.id==='service-tier-priority');
 assert.equal(priority.serviceTier,'priority');
 assert.equal(priority.tierMultiplier,2);
 assert.equal(astra.conditions.find(c=>c.id==='service-tier-discount').tierMultiplier,.5);
 // 배수는 단가를 다시 쓰지 않는다. 같은 표에서 온 같은 단가에 곱이 붙을 뿐이다.
 assert.deepEqual(priority.rates,astra.conditions[0].rates);
 // 조건이 없는 모델은 기본 조건 하나뿐이고, 같은 값을 여러 줄로 부풀리지 않는다.
 assert.deepEqual(listModelPriceConditions('anthropic','claude-sonnet-5',{timestamp:CONDITIONS_AT})
  .conditions.map(c=>c.id),['default','cache-write-1h-assumed']);
});
test('a condition with no published price is enumerated as unpriced rather than dropped or filled in',()=>{
 const mini=listModelPriceConditions('openai','gpt-5.4-mini',{timestamp:CONDITIONS_AT});
 const long=mini.conditions.find(c=>c.id==='long-context');
 assert.equal(long.status,'unpriced');
 assert.equal(long.inputTokensFrom,272001);
 assert.deepEqual(long.rates,{input:null,output:null,cacheRead:null,cacheWrite:null});
 assert.equal(long.tierMultiplier,null);
 // 기본 조건의 단가를 물려받지 않는다. 그렇게 하면 화면이 모르는 값을 아는 값으로 적게 된다.
 assert.notEqual(mini.conditions[0].rates.input,null);
 assert.equal(typeof long.reason,'string');
 const none=listModelPriceConditions('anthropic','no-such-model',{timestamp:CONDITIONS_AT});
 assert.deepEqual(none.conditions.map(c=>c.id),['default']);
 assert.equal(none.conditions[0].status,'unpriced');
});
test('an alias keeps both names and a scheduled or optional price enumerates both of its phases',()=>{
 const alias=listModelPriceConditions('ollama-cloud','gpt-oss:120b-cloud',{timestamp:CONDITIONS_AT});
 assert.equal(alias.model,'gpt-oss:120b');
 assert.equal(alias.requestedModel,'gpt-oss:120b-cloud');
 assert.equal(alias.conditions[0].rates.input,.15);
 const peak=listModelPriceConditions('ollama-cloud','deepseek-v4-flash',{timestamp:CONDITIONS_AT});
 assert.deepEqual(peak.conditions.map(c=>c.id),['default','peak-hours']);
 assert.equal(peak.conditions[0].peak,false);
 assert.equal(peak.conditions[1].peak,true);
 assert.equal(peak.conditions[1].rates.input,peak.conditions[0].rates.input*2);
 // 피크 시간대 안에서 물으면 두 줄의 역할이 뒤바뀐다. 시각이 조건을 고르기 때문이다.
 const inPeak=listModelPriceConditions('ollama-cloud','deepseek-v4-flash',{timestamp:Date.parse('2026-09-16T13:00:00Z')});
 assert.deepEqual(inPeak.conditions.map(c=>c.id),['default','off-peak']);
 assert.equal(inPeak.conditions[0].peak,true);
 assert.equal(inPeak.conditions[1].rates.input,peak.conditions[0].rates.input);
 // 캐시 쓰기 보관 시간도 조건이다. 1시간은 입력 단가의 두 배로 청구된다.
 const claude=listModelPriceConditions('anthropic','claude-opus-5',{timestamp:CONDITIONS_AT});
 const hour=claude.conditions.find(c=>c.id==='cache-write-1h-assumed');
 assert.equal(hour.claudeCacheTtl,'1h');
 assert.equal(hour.rates.cacheWrite,claude.conditions[0].rates.input*2);
});
test('the catalog states its own context thresholds, and a table that states none is still enumerated',()=>{
 const base=[1,4,.1,.5],long=[2,8,.2,1];
 const tuple=(provider,model,input)=>provider!=='vendor'||model!=='big'?null
  :[...(input>200000?long:base),null,'local-catalog',['long-context']];
 const catalog=(provider,model,input)=>tuple(provider,model,input);
 catalog.thresholds=(provider,model)=>provider==='vendor'&&model==='big'?[200000]:[];
 const listed=listModelPriceConditions('vendor','big',{timestamp:CONDITIONS_AT,catalog});
 assert.deepEqual(listed.conditions.map(c=>c.id),['default','long-context']);
 assert.equal(listed.conditions[1].inputTokensFrom,200001);
 assert.deepEqual(listed.conditions[0].rates,{input:1,output:4,cacheRead:.1,cacheWrite:.5});
 assert.deepEqual(listed.conditions[1].rates,{input:2,output:8,cacheRead:.2,cacheWrite:1});
 // 카탈로그가 말한 임계값이 그대로 쓰인다. 여기에 임계값을 옮겨 적지 않았으므로, 이 값은
 // 카탈로그가 돌려준 것이지 pricing 이 기억한 것이 아니다.
 assert.deepEqual(catalog.thresholds('vendor','big'),[200000]);
 // 임계값을 말하지 않는 표라도 경계는 드러난다. 같은 lookupModelPrice 에 크기를 바꿔 묻기
 // 때문이며, 그래서 두 경로가 같은 답에 이른다.
 const silent=(provider,model,input)=>tuple(provider,model,input);
 assert.deepEqual(listModelPriceConditions('vendor','big',{timestamp:CONDITIONS_AT,catalog:silent})
  .conditions.map(c=>[c.id,c.inputTokensFrom]),[['default',null],['long-context',200001]]);
 // 임계값을 말해도 단가가 실제로 바뀌지 않으면 조건이 아니다.
 const flat=(provider,model,input)=>provider==='vendor'&&model==='flat'?[...base,null,'local-catalog',[]]:null;
 flat.thresholds=(provider,model)=>provider==='vendor'&&model==='flat'?[100000]:[];
 assert.deepEqual(listModelPriceConditions('vendor','flat',{timestamp:CONDITIONS_AT,catalog:flat})
  .conditions.map(c=>c.id),['default']);
 // 단가가 앞 구간의 값으로 돌아가도 그 경계는 사라지지 않는다. 지우면 가운데 구간이 끝없이
 // 이어지는 것처럼 읽힌다.
 const back=(provider,model,input)=>provider!=='vendor'||model!=='wide'?null
  :[...(input>200000?base:input>100000?long:base),null,'local-catalog',['long-context']];
 back.thresholds=(provider,model)=>provider==='vendor'&&model==='wide'?[100000,200000]:[];
 const ranges=listModelPriceConditions('vendor','wide',{timestamp:CONDITIONS_AT,catalog:back});
 assert.deepEqual(ranges.conditions.map(c=>[c.id,c.inputTokensFrom,c.rates.input]),
  [['default',null,1],['long-context',100001,2],['long-context',200001,1]]);
});
test('a scheduled price uses its own provider window, not another provider schedule',()=>{
 // Go 의 DeepSeek 피크 창은 평일 01-04, 06-10 UTC 이고 Ollama 는 12-18 UTC 다. 11:00 은 Go
 // 기준으로 비피크이며, 그 시각에 열거한 다른 국면이 실제 피크 단가와 같아야 한다.
 const at=Date.parse('2026-09-16T11:00:00Z');
 const go=listModelPriceConditions('opencode-go','deepseek-v4-flash',{timestamp:at});
 assert.deepEqual(go.conditions.map(c=>c.id),['default','peak-hours']);
 assert.equal(go.conditions[0].peak,false);
 assert.equal(go.conditions[1].peak,true);
 assert.equal(go.conditions[0].rates.input,lookupModelPrice('opencode-go','deepseek-v4-flash',{timestamp:at}).rates.input);
 assert.equal(go.conditions[1].rates.input,lookupModelPrice('opencode-go','deepseek-v4-flash',{timestamp:Date.parse('2026-09-16T02:00:00Z')}).rates.input);
 // 같은 시각에 Ollama 는 자기 창 기준으로 비피크가 아니다. 두 일정이 한 함수로 뭉개지지 않는다.
 const ollama=listModelPriceConditions('ollama-cloud','deepseek-v4-flash',{timestamp:at});
 assert.equal(ollama.conditions[0].peak,false);
 assert.equal(ollama.conditions[1].rates.input,ollama.conditions[0].rates.input*2);
});
test('an input boundary is found for any table, including one that never publishes it',()=>{
 // opencode-go 는 자기 long-context 임계값을 비공개로 들고 있다. 임계값을 여기 옮겨 적지 않고
 // 같은 lookupModelPrice 에 크기를 바꿔 물어 경계를 찾는다.
 const at=Date.parse('2026-09-16T09:00:00Z');
 const go=listModelPriceConditions('opencode-go','qwen3.7-plus',{timestamp:at});
 const long=go.conditions.find(c=>c.id==='long-context');
 assert.ok(long,'the provider-scoped context tier must be listed');
 assert.deepEqual(long.rates,lookupModelPrice('opencode-go','qwen3.7-plus',{timestamp:at,inputTokens:long.inputTokensFrom}).rates);
 // 경계 바로 아래는 여전히 기본 조건이다.
 assert.deepEqual(lookupModelPrice('opencode-go','qwen3.7-plus',{timestamp:at,inputTokens:long.inputTokensFrom-1}).rates,
  go.conditions[0].rates);
 assert.notEqual(long.rates.input,go.conditions[0].rates.input);
});
test('a combination the provider refuses to price is stated instead of left to be multiplied out',()=>{
 const at=Date.parse('2026-09-16T09:00:00Z');
 const grok=listModelPriceConditions('xai','grok-4.6',{timestamp:at});
 const combined=grok.conditions.find(c=>c.id==='long-context+service-tier-priority');
 assert.ok(combined,'the refused combination must be listed');
 assert.equal(combined.status,'unpriced');
 assert.equal(combined.inputTokensFrom,200000);
 assert.equal(combined.serviceTier,'priority');
 assert.deepEqual(combined.rates,{input:null,output:null,cacheRead:null,cacheWrite:null});
 assert.equal(lookupModelPrice('xai','grok-4.6',{timestamp:at,inputTokens:200000,responseServiceTier:'priority'}).status,'unpriced');
 // OpenAI 는 그 조합을 실제로 값매기므로 읽는 사람이 두 줄에서 계산할 수 있다. 같은 사실을
 // 한 줄 더 만들어 되풀이하지 않는다.
 const astra=listModelPriceConditions('openai','gpt-6-astra',{timestamp:at});
 assert.equal(astra.conditions.some(c=>c.id.includes('+')),false);
 const priced=lookupModelPrice('openai','gpt-6-astra',{timestamp:at,inputTokens:272001,responseServiceTier:'priority'});
 const long=astra.conditions.find(c=>c.id==='long-context');
 const priority=astra.conditions.find(c=>c.id==='service-tier-priority');
assert.deepEqual(priced.rates,long.rates);
assert.equal(priced.tierMultiplier,priority.tierMultiplier);
});
test('completeness follows what a table declares, never what the search happened to find',()=>{
 const base=[1,4,.1,.5],long=[2,8,.2,1];
 // 밖에서 들어온 표가 자기 경계를 말하지 않으면, 탐색이 무엇을 찾았든 그 목록이 전부라고
 // 말할 수 없다. 찾은 것이 있다는 사실은 못 찾은 것이 없다는 증거가 아니다.
 const hidden=(provider,model,input)=>provider!=='vendor'?null
  :[...(input>1700?base:input>1500?long:base),null,'local-catalog',['long-context']];
 const blind=listModelPriceConditions('vendor','m',{timestamp:CONDITIONS_AT,catalog:hidden});
 assert.equal(blind.complete,false);
 // 조건을 아예 선언하지 않아도 마찬가지다. 선언이 없다는 것이 경계가 없다는 뜻은 아니다.
 const quiet=(provider,model,input)=>provider!=='vendor'?null
  :[...(input>1700?base:input>1500?long:base),null,'local-catalog',[]];
 assert.equal(listModelPriceConditions('vendor','m',{timestamp:CONDITIONS_AT,catalog:quiet}).complete,false);
 // 경계를 하나 찾았다고 나머지를 다 찾은 것도 아니다.
 const partly=(provider,model,input)=>provider!=='vendor'?null
  :[(input>1500&&input<=1700)?3:(input>100?2:1),4,.1,.5,null,'local-catalog',['long-context']];
 assert.equal(listModelPriceConditions('vendor','m',{timestamp:CONDITIONS_AT,catalog:partly}).complete,false);
 // 카탈로그가 자기 임계값을 말하면 그 목록이 전부다. 그것이 이 인터페이스의 약속이다.
 const declared=(provider,model,input)=>hidden(provider,model,input);
 declared.thresholds=(provider,model)=>provider==='vendor'?[1500,1700]:[];
 const seen=listModelPriceConditions('vendor','m',{timestamp:CONDITIONS_AT,catalog:declared});
 assert.equal(seen.complete,true);
 assert.deepEqual(seen.conditions.map(c=>[c.id,c.inputTokensFrom,c.rates.input]),
  [['default',null,1],['long-context',1501,2],['long-context',1701,1]]);
 // 선언한 구간이 아무리 많아도 거짓 경고를 내지 않는다. 탐색을 하지 않으므로 한도에 걸리지 않는다.
 const many=(provider,model,input)=>{
  if(provider!=='vendor')return null;
  let step=1; for(let threshold=1000;threshold<=20000;threshold+=1000)if(input>threshold)step++;
  return [step,4,.1,.5,null,'local-catalog',['long-context']];
 };
 many.thresholds=(provider,model)=>provider==='vendor'?Array.from({length:20},(x,n)=>(n+1)*1000):[];
 const wide=listModelPriceConditions('vendor','m',{timestamp:CONDITIONS_AT,catalog:many});
 assert.equal(wide.complete,true);
 assert.equal(wide.conditions.length,21);
 // 기본 크기에서 값을 못 매겨도 그 위 구간이 값매겨질 수 있다. 거기서 그만두면 그 구간이
 // 통째로 사라진다.
 const late=(provider,model,input)=>provider!=='vendor'||!(input>2000)?null
  :[2,8,.2,1,null,'local-catalog',[]];
 late.thresholds=(provider,model)=>provider==='vendor'?[2000]:[];
const above=listModelPriceConditions('vendor','m',{timestamp:CONDITIONS_AT,catalog:late});
assert.deepEqual(above.conditions.map(c=>[c.id,c.inputTokensFrom,c.status]),
 [['default',null,'unpriced'],['long-context',2001,'local-catalog']]);
assert.equal(above.complete,true);
 // 기본 크기에서 값이 없다고 해서 그 표가 카탈로그가 아닌 것은 아니다. 출처는 나열한 모든
 // 크기에서 확인한다. 기본 하나만 보면 밖에서 온 관세가 완전하다는 주장을 얻어 간다.
 const lateBlind=(provider,model,input)=>{
  if(provider!=='vendor'||!(input>100))return null;
  return [(input>2000&&input<=2200)?3:1,4,.1,.5,null,'local-catalog',[]];
 };
 assert.equal(listModelPriceConditions('vendor','m',{timestamp:CONDITIONS_AT,catalog:lateBlind}).complete,false);
 // 카탈로그는 정수가 아닌 임계값도 받는다. 1000.1 에 1 을 더하면 1001.1 이 되어, 이미 높은
 // 단가로 청구되는 1001 토큰 호출이 앞 구간에 남는다.
 const fractional=(provider,model,input)=>provider!=='vendor'?null
  :[(input>1001.05?3:input>1000.1?2:1),4,.1,.5,null,'local-catalog',['long-context']];
 fractional.thresholds=(provider,model)=>provider==='vendor'?[1000.1,1001.05]:[];
 const rounded=listModelPriceConditions('vendor','m',{timestamp:CONDITIONS_AT,catalog:fractional});
 assert.deepEqual(rounded.conditions.map(c=>[c.inputTokensFrom,c.rates.input]),[[null,1],[1001,2],[1002,3]]);
 for(const [size,rate] of [[1001,2],[1002,3]])
  assert.equal(lookupModelPrice('vendor','m',{timestamp:CONDITIONS_AT,inputTokens:size,catalog:fractional}).rates.input,rate);
 // 이 저장소가 싣고 있는 표는 경계가 여기 소스에 있고 테스트가 고정한다. 거짓 경고가 없어야 한다.
 for(const [provider,model] of [['openai','gpt-6-astra'],['openai','gpt-5.4-mini'],['xai','grok-4.6'],
  ['opencode-go','qwen3.7-plus'],['anthropic','claude-opus-5'],['ollama-cloud','deepseek-v4-flash'],
  ['cursor','composer-2.5-fast'],['anthropic','no-such-model']])
  assert.equal(listModelPriceConditions(provider,model,{timestamp:CONDITIONS_AT}).complete,true,provider+'/'+model);
});
