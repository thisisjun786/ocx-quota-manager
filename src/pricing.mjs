// API-equivalent display prices, USD per million tokens. Never actual subscription billing.
import { providerModelPricing, GO_PRICING, DEEPSEEK_PRICING, DEEPSEEK_RELEASE } from './opencode-pricing.mjs';
import { providerScopedPricing, missingPriceNote, PROVIDER_SCOPED_EVIDENCE, COMMAND_CODE } from './provider-prices.mjs';
// API/Ollama/Composer pages rechecked 2026-09-10; other source dates are retained below.
const OAI='https://developers.openai.com/api/docs/pricing';
const CLAUDE='https://platform.claude.com/docs/en/about-claude/pricing';
const XAI='https://docs.x.ai/developers/pricing';
const GOOGLE='https://ai.google.dev/gemini-api/docs/pricing';
const PRO='https://help.openai.com/en/articles/9793128-what-is-chatgpt-pro';
const MAX='https://support.claude.com/en/articles/11049741-what-is-the-max-plan';
const CURSOR='https://cursor.com/pricing';
const OLLAMA='https://ollama.com/pricing';
const GROK='https://x.ai/pricing';
const COMPOSER='https://prod.cursor.com/docs/models/cursor-composer-2-5';
const MINI='https://developers.openai.com/api/docs/models/gpt-5.4-mini';
const DEVIN='https://docs.devin.ai/desktop/models';
const CHECKED_AT='2026-09-10';
export const pricingSources = [
 ['OpenCode Go 모델 단가',GO_PRICING],['DeepSeek API 단가',DEEPSEEK_PRICING],['DeepSeek V4.1 Flash 전환 공지',DEEPSEEK_RELEASE],
 ['OpenAI API',OAI],['Claude API',CLAUDE],['xAI API',XAI],['Gemini API',GOOGLE],
 ['ChatGPT Pro 요금제',PRO],['Claude Max 요금제',MAX],['Cursor 구독',CURSOR],['Ollama 토큰 단가·구독',OLLAMA],['Grok 구독',GROK],['Cursor Composer 2.5 토큰 단가',COMPOSER],['GPT-5.4 mini 토큰 단가',MINI],['Devin 모델 단가',DEVIN],['Command Code 토큰 단가',COMMAND_CODE],
].map(([label,url])=>({label,url,checkedAt:url===COMMAND_CODE?'2026-09-17':[DEVIN,CLAUDE].includes(url)?'2026-09-15':[OAI,XAI,OLLAMA,COMPOSER,MINI,GO_PRICING,DEEPSEEK_PRICING,DEEPSEEK_RELEASE].includes(url)?CHECKED_AT:'2026-09-09'}));
// Tuple: input, output, cache read, cache write. Only exact model IDs are accepted.
const rates = {
 'gpt-6-astra':[10,50,1,12.5,OAI],
 'gpt-5.6-sol':[4,20,.4,5,OAI],
 // Installed OpenCodex expected-prices.ts maps this native selector to Sol.
 // Keep it local-catalog until independently verified against a public price source.
 'gpt-daybreak-blue-latest':[4,20,.4,5,OAI,'local-catalog'],
 'gpt-5.6-terra':[2,12,.2,2.5,OAI],
 'gpt-5.6-luna':[.2,1.2,.02,.25,OAI],
 'gpt-6-sol':[2,10,.2,2.5,OAI],
 'gpt-6-luna':[.1,.5,.01,.125,OAI],
 // OpenAI documents a 400k context window but no long-context or Fast-mode tuple.
 'gpt-5.4-mini':[.75,4.5,.075,null,OAI,'unknown-long-context-and-fast'],
 'claude-fable-5-1':[10,50,.25,12.5,CLAUDE],
 'claude-fable-5':[10,50,1,12.5,CLAUDE],
 'claude-sonnet-5':[2,10,.2,2.5,CLAUDE],
 'claude-opus-5':[5,25,.5,6.25,CLAUDE],
 'claude-opus-4-6':[5,25,.5,6.25,CLAUDE],
 'grok-4.7':[2,6,.5,null,XAI],
 // Grok 4.7 Fast (Cursor / Grok Build only) is itself the fast tier: 2x standard, and
 // 1.5x of that at or above 200K input. It has no further priority tier.
 'grok-4.7-build-fast':[4,12,1,null,XAI,'xai-fast'],
 'grok-4.6':[2,6,.5,0,XAI],
 'grok-4.5':[2,6,.3,0,XAI],
 // Cursor documents its fast model and cache-read price, but no cache-write price.
 'composer-2.5-fast':[3,15,.5,null,COMPOSER,'cursor-composer'],
 // Exact installed OpenCodex 2.48.0 expected-prices.ts tuple. Official current row
 // was not located during source-open; therefore explicitly local-catalog, not official.
 'gemini-3.8-flash':[.75,3.75,.075,0,GOOGLE,'local-catalog'],
 // Devin publishes swe-2 list prices without a cache-write rate.
 'swe-2':[3,15,.3,null,DEVIN,undefined,['list-price-reference']],
};
// Ollama's new token prices are a reference for legacy GPU subscriptions.
const ollamaRates = {
 'deepseek-v4-flash':[.22,.66,.007,0,OLLAMA], 'deepseek-v4-pro':[.66,1.98,.022,0,OLLAMA],
 'gemma4':[.14,.4,.05,0,OLLAMA], 'glm-5.3':[1.4,4.4,.26,0,OLLAMA],
 'glm-5.3-flash':[.15,.5,.03,0,OLLAMA], 'glm-5.2':[1.4,4.4,.26,0,OLLAMA], 'glm-5.1':[1,3.2,.2,0,OLLAMA],
 'gpt-oss:120b':[.15,.6,.014,0,OLLAMA], 'gpt-oss:20b':[.07,.3,.035,0,OLLAMA],
 'kimi-k3':[3,15,.3,0,OLLAMA], 'kimi-k2.7-code':[.95,4,.19,0,OLLAMA], 'kimi-k2.6':[.95,4,.16,0,OLLAMA],
 'minimax-m3':[.6,2.4,.12,0,OLLAMA], 'minimax-m2.7':[.3,1.2,.06,0,OLLAMA],
 'mistral-large-3':[.5,1.5,null,0,OLLAMA], 'nemotron-3-nano':[.06,.24,null,0,OLLAMA],
 'nemotron-3-super':[.015,.6,.015,0,OLLAMA], 'nemotron-3-ultra':[.1,3,.1,0,OLLAMA],
 'qwen3.5:397b':[.6,3.6,null,0,OLLAMA],
};
const ollamaAliases = new Map();
for (const model of Object.keys(ollamaRates)) {
 ollamaAliases.set(model, model);
 ollamaAliases.set(model.includes(':') ? model+'-cloud' : model+':cloud', model);
}
for (const [tag,model] of [['deepseek-v4-flash:0731','deepseek-v4-flash'],['deepseek-v4-pro:0813','deepseek-v4-pro']]) {
 ollamaAliases.set(tag,model);ollamaAliases.set(tag+'-cloud',model);
}
export const OLLAMA_CREDIT_PLANS = Object.freeze({
 pro:Object.freeze({monthlyUsd:20,includedCreditsUsd:60,sourceUrl:OLLAMA,checkedAt:CHECKED_AT}),
 max:Object.freeze({monthlyUsd:100,includedCreditsUsd:300,sourceUrl:OLLAMA,checkedAt:CHECKED_AT}),
 team:Object.freeze({monthlyUsd:500,includedCreditsUsd:1000,sourceUrl:OLLAMA,checkedAt:CHECKED_AT}),
});
const USER_SUBSCRIPTION_REASON='사용자가 확인한 월 구독료 기준';
const userSubscription=(monthlyUsd,label)=>Object.freeze({monthlyUsd,label,basis:'user-confirmed',sourceUrl:null,checkedAt:CHECKED_AT,reason:USER_SUBSCRIPTION_REASON});
export const USER_SUBSCRIPTIONS = Object.freeze({
 openai:userSubscription(200,'ChatGPT Pro'),
 anthropic:userSubscription(200,'Claude Max'),
 xai:userSubscription(300,'Grok'),
 cursor:userSubscription(200,'Cursor Ultra'),
 'ollama-cloud':userSubscription(100,'Ollama Cloud Max (구버전)'),
 'opencode-go':userSubscription(10,'OpenCode Go'),
});
const valid = n => typeof n === 'number' && Number.isFinite(n) && n>=0;
const unknown = reason => ({usd:null,basis:'unknown',reason,sourceUrl:null});
const normalizedProvider = provider => typeof provider === 'string' ? provider.replace(/-(?:main|[pko][a-f0-9]{6})$/,'') : '';
const isOllamaPeak = timestamp => {
 if(!valid(timestamp)||timestamp<=0||timestamp>=8.64e15)return null;
 const time=new Date(timestamp),day=time.getUTCDay(),hour=time.getUTCHours();
 return day>=1&&day<=5&&hour>=12&&hour<18;
};
export function ollamaModelPricing(model,timestamp) {
 const canonical=ollamaAliases.get(model),rate=ollamaRates[canonical];
 if(!rate)return null;
 const peak=canonical.startsWith('deepseek-v4-')?isOllamaPeak(timestamp):false;
 if(peak===null)return null;
 const multiplier=peak?2:1;
 return {model:canonical,inputUsdPerMillion:rate[0]*multiplier,cachedInputUsdPerMillion:rate[2]===null?null:rate[2]*multiplier,outputUsdPerMillion:rate[1]*multiplier,peak,sourceUrl:OLLAMA,checkedAt:CHECKED_AT};
}
// Published input-size boundaries that change a rate. The valuation, the quote and the
// condition enumeration all read these, so an enumerated condition cannot name a boundary
// the calculation does not actually use. The comparisons differ by provider and stay where
// they are: OpenAI charges the long rate above its threshold, xAI from its threshold.
const LONG_INPUT={[OAI]:272000,[XAI]:200000};
// Rates checked later than their source's shared date.
const MODEL_CHECKED_AT={'gpt-6-sol':'2026-09-26','gpt-6-luna':'2026-09-26','grok-4.7':'2026-09-26','grok-4.7-build-fast':'2026-09-26'};
const xaiLongMult=r=>r[5]==='xai-fast'?1.5:2;
// A model ID alone never selects a price: a route names the providers that may bill a
// given source's rate. Cursor forwarding an upstream model is a deliberate entry here.
const ROUTES={
 [OAI]:['openai','openai-apikey','chatgpt','openai-multi','cursor'],
 [CLAUDE]:['anthropic','anthropic-apikey','cursor'],[XAI]:['xai','cursor'],[GOOGLE]:['cursor','google'],[COMPOSER]:['cursor'],
 [DEVIN]:['devin','devin-cli'],
};
// A promotional rate with a published end. The successor tariff is not verified here,
// so a call after the endpoint stays unpriced instead of inheriting the promotion.
// Same shape as the Go V4 Pro transition in opencode-pricing.mjs.
const PROMO_END={'gemini-3.8-flash':Date.parse('2027-01-01T00:00:00Z')};
const promoExpired=(model,timestamp)=>Object.hasOwn(PROMO_END,model??'')&&valid(timestamp)&&timestamp>=PROMO_END[model];

// The single selection order. priceUsage and lookupModelPrice both call this, so a
// quoted unit price cannot drift away from the amount actually charged.
function resolveModelRate(rawProvider,model,timestamp,inputTokens,catalog,isOllama,requestedModel) {
 // A reselling surface that publishes its own tariff is consulted before the model-ID table,
 // because the same model ID costs a different amount there.
 const scoped=providerModelPricing(rawProvider,model,timestamp,inputTokens)??providerScopedPricing(rawProvider,model,timestamp);
 if(scoped?.reason)return {rate:null,reason:scoped.reason};
 const nativeRate=isOllama ? Object.hasOwn(ollamaRates,model??'') ? ollamaRates[model] : null : Object.hasOwn(rates,model??'') ? rates[model] : null;
 const nativeApplies=nativeRate && (!ROUTES[nativeRate[4]] || ROUTES[nativeRate[4]].includes(rawProvider));
 // Hard rejection: an ended promotion must not quietly fall through to a catalog row.
 if(nativeApplies&&promoExpired(model,timestamp))return {rate:null,reason:'판촉 단가 적용 기간이 끝나 이후 단가 미확인'};
 const r=scoped?.rate ?? (nativeApplies ? nativeRate : null) ?? (!isOllama ? catalog?.(rawProvider,model,inputTokens) : null);
 // The requested ID, not the canonical one: alias resolution drops an unrecognised Ollama tag
 // to undefined, and that tag is exactly what the note explains.
 const note=()=>missingPriceNote(rawProvider,requestedModel??model);
 if(!r&&nativeRate)return {rate:null,reason:note()??'모델과 제공자 연결 미확인'};
 if(!r)return {rate:null,reason:note()??'모델 단가 미확인'};
 return {rate:r,reason:null,scoped,origin:scoped?.rate ? 'provider-scoped' : nativeApplies&&r===nativeRate ? 'builtin' : 'catalog'};
}

export function priceUsage(row, { catalog, claudeCacheTtl } = {}) {
 const rawProvider=normalizedProvider(row?.provider);
 const isOllama=rawProvider==='ollama-cloud';
 const model=isOllama ? ollamaAliases.get(row?.model) : row?.model;
 const u=row?.usage;
 const resolved=resolveModelRate(rawProvider,model,row?.timestamp,u?.inputTokens,catalog,isOllama,row?.model);
 if(!resolved.rate)return unknown(resolved.reason);
 const r=resolved.rate;
 if(!u||!valid(u.inputTokens)||!valid(u.outputTokens))return unknown('토큰 기록 미확인');
 if(['unreported','unsupported'].includes(row.usageStatus))return unknown('토큰 사용량 미보고');
 let read=u.cacheReadInputTokens??u.cachedInputTokens??0,write=u.cacheCreationInputTokens??0;
 if(!valid(read)||!valid(write))return unknown('캐시 기록 형식 오류');
 if(read+write>u.inputTokens&&u.cacheReadInputTokens===undefined&&u.cachedInputTokens!==undefined)read=Math.max(0,read-write);
 if(read+write>u.inputTokens)return unknown('캐시 토큰이 입력보다 큼');
 const isOpenAI=r[4]===OAI, isClaude=r[4]===CLAUDE, isXai=r[4]===XAI;
 const responseTier=row.tierOutcome?.responseServiceTier??row.responseServiceTier;
 const requestedTier=row.tierOutcome?.requestedServiceTier??row.requestedServiceTier;
 if(!responseTier&&requestedTier&&!['default','auto','standard'].includes(requestedTier))return unknown('요청한 서비스 등급의 실제 적용 여부 미확인');
 const tier=responseTier??'default';
 let mult=1;
 if(['priority','fast'].includes(tier)) {
  if(r[5]==='unknown-long-context-and-fast'||r[5]==='xai-fast')return unknown('서비스 등급 단가 미확인');
  if(isOpenAI||isXai)mult=2;else return unknown('서비스 등급 단가 미확인');
 } else if(tier==='flex'||tier==='batch') {
  if(isOpenAI)mult=.5;else return unknown('서비스 등급 단가 미확인');
 } else if(!['default','auto','standard'].includes(tier))return unknown('서비스 등급 미확인');
 let [inputRate,outputRate,readRate,writeRate]=r;
 // Claude cache writes bill differently by storage TTL: 5 minutes is the default
 // assumption, 1 hour costs twice the input rate. Any other requested TTL has no
 // published price, so the row stays unpriced instead of guessing.
 const claudeTtl=claudeCacheTtl??'5m';
 if(isClaude){
  if(claudeTtl!=='5m'&&claudeTtl!=='1h')return unknown('캐시 쓰기 보관 시간 단가 미확인');
  if(claudeTtl==='1h')writeRate=scaled(inputRate,2);
 }
 if(read>0&&readRate===null)return unknown('캐시 읽기 단가 미확인');
 if(write>0&&writeRate===null)return unknown('캐시 쓰기 단가 미확인');
 if (isOllama) {
  if (write>0 || (read>0 && readRate===null)) return unknown('Ollama 캐시 단가 미확인');
  const pricing=ollamaModelPricing(row?.model,row.timestamp);
  if(!pricing)return unknown(model.startsWith('deepseek-v4-')?'피크 시간 확인에 필요한 호출 시각 없음':'모델 단가 미확인');
  inputRate=pricing.inputUsdPerMillion;outputRate=pricing.outputUsdPerMillion;readRate=pricing.cachedInputUsdPerMillion;
 }

 if(isOpenAI&&u.inputTokens>LONG_INPUT[OAI]){
  if(r[5]==='unknown-long-context-and-fast')return unknown('긴 입력 단가 미확인');
  inputRate*=2;readRate*=2;writeRate*=2;outputRate*=1.5;
 }
 if(isXai&&u.inputTokens>=LONG_INPUT[XAI]){
  if(mult!==1)return unknown('긴 입력과 우선 처리 결합 단가 미확인');
  const m=xaiLongMult(r);inputRate*=m;readRate*=m;outputRate*=m;
 }
 // outputTokens already contains reasoning; inputTokens already contains cache reads/writes.
 const usd=((u.inputTokens-read-write)*inputRate+u.outputTokens*outputRate+read*readRate+write*writeRate)/1e6*mult;
 if(!valid(usd))return unknown('환산액 범위 초과');
 const assumed=(isClaude&&write>0)||u.estimated===true||row.usageStatus==='estimated'||r[5]==='local-catalog';
 return {usd,basis:assumed?'local-catalog':'official',sourceUrl:r[4],reason:assumed?`추정 토큰·로컬 단가 또는 ${claudeTtl==='1h'?'1시간':'5분'} 캐시 쓰기 가정 포함`:null};
}

// Evidence grade, kept separate from the calculation's own `basis`. `basis` stays a
// two-value estimate flag persisted with every usage row and read back as
// localPriceRequests, so it must not carry a third meaning. These rows are prices the
// installed OCX publishes with its own source and check date: weaker than opening the
// provider's page ourselves, stronger than an anonymous catalog row.
const OCX_RELEASE='OpenCodex 2.55.0 expected-prices.ts';
const OCX_EVIDENCE={
 ...PROVIDER_SCOPED_EVIDENCE,
 'openai\0gpt-daybreak-blue-latest':{detail:`${OCX_RELEASE} · gpt-5.6-sol 별칭에서 파생`,checkedAt:'2026-08-11',conditions:['alias-derived']},
 'google\0gemini-3.8-flash':{detail:`${OCX_RELEASE} · 확인 상태 verified`,checkedAt:'2026-09-03',conditions:[]},
 'cursor\0gemini-3.8-flash':{detail:`${OCX_RELEASE} · 확인 상태 verified`,checkedAt:'2026-09-03',conditions:[]},
};
const SOURCE_CHECKED_AT=new Map(pricingSources.map(s=>[s.url,s.checkedAt]));
export const PRICE_CONDITIONS=Object.freeze({
 'long-context':'입력이 임계값을 넘으면 단가가 오릅니다.',
 'service-tier-priority':'priority·fast 등급은 2배입니다.',
 'service-tier-discount':'flex·batch 등급은 0.5배입니다.',
 'peak-hours':'제공자가 정한 피크 시간대에는 단가가 2배입니다.',
 'promotional':'공표된 기간까지만 적용되는 판촉 단가입니다.',
 'alias-derived':'별칭이 가리키는 모델의 단가에서 파생했습니다.',
 'cache-write-assumed':'캐시 쓰기는 5분 보관 단가를 가정합니다.',
 'cache-write-1h-assumed':'캐시 쓰기는 1시간 보관 단가를 가정합니다.',
 'list-price-reference':'할인·무료 프로모션을 제외한 API 정가 환산입니다.',
});
// null is "not published" and 0 is "free". Plain multiplication would turn the first
// into the second, so every conditional rate adjustment goes through this.
const scaled=(n,m)=>n===null||n===undefined?null:n*m;
const tupleRates=t=>({input:t[0]??null,output:t[1]??null,cacheRead:t[2]??null,cacheWrite:t[3]??null});

/**
 * Unit price for one provider and one exact model ID, with its source, check date,
 * effective window and conditions. Answers whether a PRICE exists for the given
 * conditions; whether a given usage row can be valued is priceUsage's separate question.
 * Never returns another provider's rate: the provider is part of the key.
 */
export function lookupModelPrice(provider, model, options) {
 // A caller passing null is asking for the unconditioned price, not an exception.
 const given=options!==null&&typeof options==='object'?options:{};
 const {timestamp,inputTokens,catalog,claudeCacheTtl}=given;
 const rawProvider=normalizedProvider(provider);
 const isOllama=rawProvider==='ollama-cloud';
 const requestedModel=typeof model==='string'&&model?model:null;
 const canonical=isOllama?ollamaAliases.get(requestedModel)??null:requestedModel;
 const empty={provider:rawProvider,model:canonical??requestedModel,requestedModel,unit:'usd-per-million-tokens',
  status:'unpriced',rates:{input:null,output:null,cacheRead:null,cacheWrite:null},tierMultiplier:null,
  sourceUrl:null,checkedAt:null,effectiveFrom:null,effectiveTo:null,conditions:[],unsupported:[],conflict:null,reason:null};
 const no=reason=>({...empty,reason});
 if(!rawProvider)return no('제공자 ID가 없습니다.');
 if(!requestedModel)return no('모델 ID가 없습니다.');
 // Same tier precedence and same rule as priceUsage: a requested-only tier is fine
 // when it is an ordinary one, and unproven priority is not.
 const responseTier=given.tierOutcome?.responseServiceTier??given.responseServiceTier;
 const requestedTier=given.tierOutcome?.requestedServiceTier??given.requestedServiceTier;
 if(!responseTier&&requestedTier&&!['default','auto','standard'].includes(requestedTier))return no('요청한 서비스 등급의 실제 적용 여부 미확인');
 const tier=responseTier??'default';
 const resolved=resolveModelRate(rawProvider,canonical,timestamp,inputTokens,catalog,isOllama,requestedModel);
 if(!resolved.rate)return no(resolved.reason);
 const r=resolved.rate,fromCatalog=resolved.origin==='catalog';
 const isOpenAI=r[4]===OAI,isClaude=r[4]===CLAUDE,isXai=r[4]===XAI;
 let mult=1;
 if(['priority','fast'].includes(tier)){
  if(r[5]==='unknown-long-context-and-fast'||r[5]==='xai-fast')return no('서비스 등급 단가 미확인');
  if(isOpenAI||isXai)mult=2;else return no('서비스 등급 단가 미확인');
 } else if(tier==='flex'||tier==='batch'){
  if(isOpenAI)mult=.5;else return no('서비스 등급 단가 미확인');
 } else if(!['default','auto','standard'].includes(tier))return no('서비스 등급 미확인');
 let {input,output,cacheRead,cacheWrite}=tupleRates(r);
 const unsupported=[];
 // Same TTL rule as priceUsage: 1-hour Claude cache writes cost twice the input
 // rate, and an unsupported TTL prices nothing.
 const claudeTtl=claudeCacheTtl??'5m';
 if(isClaude){
  if(claudeTtl!=='5m'&&claudeTtl!=='1h')return no('캐시 쓰기 보관 시간 단가 미확인');
  if(claudeTtl==='1h')cacheWrite=scaled(input,2);
 }
 if(isOllama){
  const published=ollamaModelPricing(requestedModel,timestamp);
  if(!published)return no(canonical?.startsWith('deepseek-v4-')?'피크 시간 확인에 필요한 호출 시각 없음':'모델 단가 미확인');
  input=published.inputUsdPerMillion;output=published.outputUsdPerMillion;cacheRead=published.cachedInputUsdPerMillion;
  // The tuple slot reads 0, but the calculation refuses any positive cache write here.
  // Publishing 0 would advertise a free write the valuation will not honour.
  cacheWrite=null;unsupported.push('cache-write');
 }
 if(isOpenAI&&valid(inputTokens)&&inputTokens>LONG_INPUT[OAI]){
  if(r[5]==='unknown-long-context-and-fast')return no('긴 입력 단가 미확인');
  input=scaled(input,2);cacheRead=scaled(cacheRead,2);cacheWrite=scaled(cacheWrite,2);output=scaled(output,1.5);
 }
 if(isXai&&valid(inputTokens)&&inputTokens>=LONG_INPUT[XAI]){
  if(mult!==1)return no('긴 입력과 우선 처리 결합 단가 미확인');
  const m=xaiLongMult(r);input=scaled(input,m);cacheRead=scaled(cacheRead,m);output=scaled(output,m);
 }
 // A provider-scoped row may answer under a normalized ID, so its evidence is keyed by the ID
 // the rate actually came from rather than the spelling the caller used.
 const ocx=OCX_EVIDENCE[`${rawProvider}\0${resolved.scoped?.model??canonical}`];
 const conditions=new Set(resolved.scoped?.conditions??[]);
 if(isOpenAI&&r[5]!=='unknown-long-context-and-fast')conditions.add('long-context');
 if(isXai)conditions.add('long-context');
 // Declare only the tiers this provider, model and input size actually price. xAI has
 // no flex or batch, gpt-5.4-mini has no priced priority, and xAI above its long-input
 // threshold cannot combine the two, so none of those may be advertised.
 const tierUnknown=r[5]==='unknown-long-context-and-fast'||r[5]==='xai-fast';
 const longXai=isXai&&valid(inputTokens)&&inputTokens>=LONG_INPUT[XAI];
 if((isOpenAI||isXai)&&!tierUnknown&&!longXai)conditions.add('service-tier-priority');
 if(isOpenAI)conditions.add('service-tier-discount');
 if(isOllama&&canonical?.startsWith('deepseek-v4-'))conditions.add('peak-hours');
 if(isClaude&&cacheWrite!==null)conditions.add(claudeTtl==='1h'?'cache-write-1h-assumed':'cache-write-assumed');
 for(const id of ocx?.conditions??[])conditions.add(id);
 for(const id of Array.isArray(r[6])?r[6]:[])conditions.add(id);
 // A provider-scoped row can declare a rate it does not publish; say so rather than
 // letting a null read as an ordinary absent field.
 for(const id of resolved.scoped?.unsupported??[])if(!unsupported.includes(id))unsupported.push(id);
 let effectiveTo=resolved.scoped?.effectiveTo??null;
 if(!fromCatalog&&Object.hasOwn(PROMO_END,canonical??'')){conditions.add('promotional');effectiveTo=new Date(PROMO_END[canonical]).toISOString();}
 // A lower-priority source disagrees only when it states a different number for the
 // SAME conditions, so both sides are compared after their own conditions are applied.
 // The catalog expresses context thresholds and nothing else: under an applied service
 // tier or an active peak multiplier it makes no comparable claim, and its silence is
 // not agreement. An omitted field is likewise no claim at all.
 // Effective rates are products of published decimals, so 1.2 * 1.5 is 1.7999999999999998
 // and a strict comparison would call that a different price from 1.8.
 const differs=(a,b)=>Math.abs(a-b)>1e-9*Math.max(1,Math.abs(a),Math.abs(b));
 const comparable=['default','auto','standard'].includes(tier)&&resolved.scoped?.peak!==true;
 const alternate=!isOllama&&!fromCatalog&&comparable?catalog?.(rawProvider,canonical,inputTokens):null;
 const effective=[input,output,cacheRead,cacheWrite];
 // A 1-hour cache write is a different condition than the catalog's default write
 // rate, so under that option the write slot is not a comparable claim.
 const conflict=alternate&&[0,1,2,3].some(i=>!(isClaude&&claudeTtl==='1h'&&i===3)&&alternate[i]!=null&&effective[i]!=null&&differs(alternate[i],effective[i]))
  ? {status:'local-catalog',rates:tupleRates(alternate),reason:'로컬 카탈로그가 다른 단가를 제시합니다. 우선순위가 높은 근거를 사용했습니다.'} : null;
 return {...empty,
  status:fromCatalog?'local-catalog':ocx?'ocx-provided':r[5]==='local-catalog'?'local-catalog':'official',
  rates:{input,output,cacheRead,cacheWrite},tierMultiplier:mult,
  sourceUrl:fromCatalog?null:r[4]??null,
  checkedAt:fromCatalog?null:ocx?.checkedAt??resolved.scoped?.checkedAt??MODEL_CHECKED_AT[canonical]??SOURCE_CHECKED_AT.get(r[4])??null,
  effectiveFrom:resolved.scoped?.effectiveFrom??null,effectiveTo,
  conditions:[...conditions],unsupported,conflict,
 reason:ocx?.detail??null};
}


// Every billing condition this provider and model actually price, each with the input size,
// service tier or cache option that selects it, the rates that follow and the multiplier
// applied. Every row is produced by lookupModelPrice itself, so an enumerated condition
// cannot state a rate the valuation would not charge, and the catalog enumerates its own
// context boundaries rather than having its table read a second time here.
export function listModelPriceConditions(provider, model, options) {
 const given=options!==null&&typeof options==='object'?options:{};
 const {timestamp,catalog}=given;
 const rawProvider=normalizedProvider(provider);
 const isOllama=rawProvider==='ollama-cloud';
 const requestedModel=typeof model==='string'&&model?model:null;
 const canonical=isOllama?ollamaAliases.get(requestedModel)??null:requestedModel;
 // Only the axes below vary. A caller's own input size or service tier would make the
 // default row that caller's case rather than this model's unconditioned price.
 const shared={timestamp,catalog,claudeCacheTtl:given.claudeCacheTtl};
 const ask=extra=>lookupModelPrice(provider,model,{...shared,...extra});
 const head=ask({});
 // Which instant is peak is known only by whatever priced it: Ollama's own table reports
 // it, and a provider-scoped table reports it on its own result. Restating a schedule here
 // would flatten three different published windows into one. null means the question does
 // not apply to this model at all, which is not the same as an off-peak quote.
 const peakOf=at=>{
  if(!head.conditions.includes('peak-hours'))return null;
  if(isOllama)return ollamaModelPricing(requestedModel,at)?.peak??null;
  const scoped=resolveModelRate(rawProvider,canonical,at,undefined,catalog,isOllama,requestedModel).scoped;
  return typeof scoped?.peak==='boolean'?scoped.peak:null;
 };
 // Built field by field: these rows reach the snapshot, so they carry what the screen
 // needs rather than whatever the quote contract grows next.
 const describe=(id,selector,quote)=>({id,
  inputTokensFrom:selector.inputTokens??null,
  serviceTier:selector.responseServiceTier??null,
  claudeCacheTtl:selector.claudeCacheTtl??null,
  peak:peakOf(selector.timestamp??timestamp),
  status:quote.status,
  rates:{input:quote.rates.input,output:quote.rates.output,cacheRead:quote.rates.cacheRead,
   cacheWrite:quote.rates.cacheWrite},
  tierMultiplier:quote.tierMultiplier,sourceUrl:quote.sourceUrl,checkedAt:quote.checkedAt,
  effectiveFrom:quote.effectiveFrom,effectiveTo:quote.effectiveTo,
  conditions:[...quote.conditions],unsupported:[...quote.unsupported],
  conflict:quote.conflict===null?null:{status:quote.conflict.status,
   rates:{input:quote.conflict.rates.input,output:quote.conflict.rates.output,
    cacheRead:quote.conflict.rates.cacheRead,cacheWrite:quote.conflict.rates.cacheWrite},
   reason:quote.conflict.reason},
  reason:quote.reason});
 // Declared before the first return: a model with no price at all has nothing to enumerate,
 // and that is a complete answer rather than an unknown one.
 let complete=true;
 const rows=[describe('default',{},head)];
const answer=()=>({provider:head.provider,model:head.model,requestedModel:head.requestedModel,
  unit:head.unit,complete,conditions:rows});
 // No early return for an unpriced default. A table can refuse the ordinary size and price a
 // larger one, and leaving here would report that model as having no condition at all. Every
 // axis below is gated on a condition this quote declares, so a model that really has no
 // price costs one bounded search and nothing else.
 // Two rows state the same condition when they charge the same thing.
 const same=(a,b)=>a.status===b.status&&a.tierMultiplier===b.tierMultiplier&&
  ['input','output','cacheRead','cacheWrite'].every(key=>a.rates[key]===b.rates[key]);
 // Where an input size changes an answer. The catalog states its own boundaries; every other
 // table keeps them private, so the same lookupModelPrice is asked at different sizes until
 // its answer changes. No threshold is restated here, which is why a provider-scoped tier is
 // found by exactly the same code as an OpenAI one, and why a size that stops a model being
 // priced at all is found too -- gpt-5.4-mini has a context window it publishes no rate for,
 // and it never declares the condition that would have announced the boundary.
 const signature=quote=>[quote.status,quote.tierMultiplier,quote.rates.input,quote.rates.output,
  quote.rates.cacheRead,quote.rates.cacheWrite].join('|');
 // Asking a table cannot prove what it was not asked. A search reaches a boundary it steps
 // over only if some sample lands between, so this reports whether it believes it saw
 // everything instead of presenting a partial tariff as a whole one.
const MAX_INPUT=1<<24,MAX_BOUNDARIES=16;
function inputBoundaries(){
  const found=[];
  let low=0,lowSignature=signature(head);
  for(let ceiling=1024;ceiling<=MAX_INPUT;ceiling=Math.ceil(ceiling*1.5)){
   // Every boundary inside this span, not only the first: two tiers can share one span.
   while(found.length<MAX_BOUNDARIES&&signature(ask({inputTokens:ceiling}))!==lowSignature){
    let below=low,above=ceiling;
    while(above-below>1){
     const middle=Math.floor((below+above)/2);
     if(signature(ask({inputTokens:middle}))===lowSignature)below=middle;else above=middle;
    }
    found.push(above);low=above;lowSignature=signature(ask({inputTokens:above}));
   }
   if(found.length>=MAX_BOUNDARIES){complete=false;break;}
   low=ceiling;lowSignature=signature(ask({inputTokens:ceiling}));
  }
  return found;
 }
 // Completeness is a property of what a source declares, never of what a search happened to
 // find: sampling reaches a boundary only if some sample lands beside it, so a search that
 // found something has proved nothing about what it did not find. A catalog that supplies
 // thresholds is enumerating its own boundaries, and that list is taken as the whole set for
 // its rows. The tables inside this repository have their boundaries in this source and
 // pinned by its tests, so the search is how they are read rather than what vouches for them.
 const resolved=resolveModelRate(rawProvider,canonical,timestamp,undefined,catalog,isOllama,requestedModel);
 const enumerable=typeof catalog?.thresholds==='function';
 const declared=enumerable?(catalog.thresholds(rawProvider,canonical)??[]).filter(valid):[];
 const catalogAtDefault=resolved.origin==='catalog';
 // The smallest whole number of tokens past the boundary. A declared threshold need not be
 // an integer, and adding one to 1000.1 would start the row at 1001.1 and misplace the
 // 1001-token call that is already charged the higher rate.
 const sizes=new Set(declared.map(threshold=>Math.floor(threshold)+1));
 // The search is skipped only where the catalog both priced this model and enumerated its
 // own boundaries. Everywhere else a built-in boundary still has to be found.
 if(!(enumerable&&catalogAtDefault))for(const size of inputBoundaries())sizes.add(size);
 // Provenance is asked at every listed size, not only at the default one: a table can refuse
 // the ordinary size and price a larger one, and judging it by the default alone would let
 // an outside tariff keep a completeness claim it never earned.
 const catalogAnswers=catalogAtDefault||[...sizes].some(size=>
  resolveModelRate(rawProvider,canonical,timestamp,size,catalog,isOllama,requestedModel).origin==='catalog');
 // An outside table that never enumerated its boundaries was read by sampling alone.
 if(catalogAnswers&&!enumerable)complete=false;
 // A size row is compared with the row that would otherwise apply at that size rather than
 // with every earlier row: a tier that returns to an earlier price still ends the one before
 // it, and dropping it would leave that one looking open-ended.
 const sizeRows=[];
 let applying=rows[0];
 for(const size of [...sizes].sort((a,b)=>a-b)){
  const row=describe('long-context',{inputTokens:size},ask({inputTokens:size}));
  if(same(applying,row))continue;
  rows.push(row);sizeRows.push(row);applying=row;
 }
 const tierRows=[];
 for(const [id,tier] of [['service-tier-priority','priority'],['service-tier-discount','flex']]){
  if(!head.conditions.includes(id))continue;
  const row=describe(id,{responseServiceTier:tier},ask({responseServiceTier:tier}));
  if(same(rows[0],row))continue;
  rows.push(row);tierRows.push([id,tier,row]);
 }
 // A long input and a service tier can be asked for together, and the answer is not always
 // the two rows above multiplied: xAI prices neither of those combinations. A combination is
 // listed only when it says something those rows do not, so a reader who would otherwise
 // work it out for himself is not shown a price that would be refused.
 for(const sizeRow of sizeRows)for(const [id,tier,tierRow] of tierRows){
  const selector={inputTokens:sizeRow.inputTokensFrom,responseServiceTier:tier};
  const row=describe('long-context+'+id,selector,ask(selector));
  const derived=row.status===sizeRow.status&&row.tierMultiplier===tierRow.tierMultiplier&&
   ['input','output','cacheRead','cacheWrite'].every(key=>row.rates[key]===sizeRow.rates[key]);
  // A combination is also nothing new when the size alone was already refused: the reader
  // has been told there is no price at that size, whatever tier is asked for with it.
  if(!derived&&!(sizeRow.status==='unpriced'&&row.status==='unpriced'))rows.push(row);
 }
 if(head.conditions.includes('cache-write-assumed')){
  const row=describe('cache-write-1h-assumed',{claudeCacheTtl:'1h'},ask({claudeCacheTtl:'1h'}));
  if(!same(rows[0],row))rows.push(row);
 }
 if(head.conditions.includes('cache-write-1h-assumed')){
  const row=describe('cache-write-assumed',{claudeCacheTtl:'5m'},ask({claudeCacheTtl:'5m'}));
  if(!same(rows[0],row))rows.push(row);
 }
 // The other phase of a published schedule, found by asking that schedule rather than by
 // restating here when it runs.
 const phase=peakOf(timestamp);
 if(phase!==null)for(let hour=1;hour<=168;hour++){
  const at=timestamp+hour*3600000;
  if(peakOf(at)===phase)continue;
  const row=describe(phase?'off-peak':'peak-hours',{timestamp:at},ask({timestamp:at}));
  if(!same(rows[0],row))rows.push(row);
  break;
 }
 return answer();
}
export function lookupSubscription(provider, plan, overrides) {
 const override=overrides?.[provider];
 if(override&&valid(override.monthlyUsd)&&typeof override.label==='string')return {...override};
 const p=typeof plan==='string'?plan.toLowerCase():'';
 const table={
  openai:{plus:[20,'ChatGPT Plus'],pro_5x:[100,'ChatGPT Pro 5x'],pro_20x:[200,'ChatGPT Pro 20x']},
  anthropic:{pro:[20,'Claude Pro'],default_claude_max_5x:[100,'Claude Max 5x'],default_claude_max_20x:[200,'Claude Max 20x'],'max-5x':[100,'Claude Max 5x'],'max-20x':[200,'Claude Max 20x']},
  cursor:{pro:[20,'Cursor Pro'],'pro+':[60,'Cursor Pro+'],ultra:[200,'Cursor Ultra']},
  'ollama-cloud':{pro:[OLLAMA_CREDIT_PLANS.pro.monthlyUsd,'Ollama Pro'],max:[OLLAMA_CREDIT_PLANS.max.monthlyUsd,'Ollama Max'],team:[OLLAMA_CREDIT_PLANS.team.monthlyUsd,'Ollama Team']},
  xai:{supergrok:[30,'SuperGrok'],'supergrok-plus':[100,'SuperGrok Plus']},
 };
 const sourceUrl={openai:PRO,anthropic:MAX,cursor:CURSOR,'ollama-cloud':OLLAMA,xai:GROK}[provider]??null;
 const entry=table[provider]?.[p];
 if(entry)return {monthlyUsd:entry[0],label:entry[1],basis:'official',sourceUrl,reason:'웹 월간 정가 · 세금·할인·연간 결제 제외'};
 if(provider==='openai'&&p==='pro')return {monthlyUsd:null,label:'ChatGPT Pro ($100 / $200)',basis:'ambiguous',sourceUrl,reason:'Pro는 $100·$200 두 등급입니다. 저장된 pro만으로는 구분할 수 없습니다.'};
 return {monthlyUsd:null,label:plan||'플랜 미확인',basis:'unknown',sourceUrl,reason:'이 계정의 플랜 정보를 확인할 수 없어 구독료를 지정하지 않았습니다.'};
}
