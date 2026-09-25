// Token prices a reselling surface publishes for models it forwards. A model ID alone never
// selects one of these: the reseller's tariff differs from the upstream vendor's, so the
// provider is part of the key. Transcribed from the installed OpenCodex 2.56.0 overlay
// (src/usage/expected-prices.ts), which reads Devin's own published modelCostData table.
export const DEVIN='https://docs.devin.ai/desktop/models';
export const COMMAND_CODE='https://commandcode.ai/docs/resources/pricing-limits';
const OCX_RELEASE='OpenCodex 2.56.0 expected-prices.ts';
const DEVIN_CHECKED_AT='2026-09-13';
// USD per million: input, output, cache read. Cache write is deliberately absent. This
// repository read no cache-write rate for swe-2 on 2026-09-15 while the OCX transcription
// carries one for some rows, and an unreconciled rate is not published as 0 -- which would
// claim the write is free -- nor borrowed from the upstream vendor, which would price a
// Devin call with another provider's number.
const devinRates={
 'swe-1-7':[.5,2.5,.2],'swe-1-7-lightning':[2.5,12.5,1],
 'gpt-5-6-sol':[4,20,.4],'gpt-5-6-luna':[.2,1.2,.02],'gpt-5-6-terra':[2,12,.2],'gpt-6-astra':[10,50,1],
 'claude-opus-5':[5,25,.5],'claude-opus-4-8':[5,25,.5],'claude-fable-5-1':[10,50,.25],'claude-sonnet-5':[2,10,.2],
 'glm-5-2':[1.4,4.4,.26],'glm-5-3':[1.4,4.4,.26],'kimi-k2-7':[.95,4,.19],'kimi-k3':[3,15,.3],
 'grok-4-5':[2,6,.3],'grok-4-6':[2,6,.3],
};
// swe-2 is absent on purpose too: it already resolves from this repository's own reading of
// the same page, and moving it here would downgrade first-hand evidence to a transcription.
// Both Devin surfaces bill the same published table, and ROUTES already pairs them for swe-2.
const DEVIN_PROVIDERS=['devin','devin-cli'];

// Devin publishes this model as a dated pair rather than one rate: an introductory tariff
// through 2026-12-31 and a regular one from 2027-01-01, both stated on the same page
// (rechecked 2026-09-17). Recording both prices a call by when it happened instead of letting
// an ended promotion persist, which is why it is not folded into the flat table above.
// Only input and output are published for it. No cache rate is, so cache tokens stay unpriced
// rather than borrowing the upstream vendor's cache numbers.
const DEVIN_DATED_CHECKED_AT='2026-09-17';
const DEVIN_DATED={
 'gemini-3-8-flash':{until:Date.parse('2027-01-01T00:00:00Z'),introductory:[.75,3.75],regular:[1.5,7.5]},
};
// Cognition spells reasoning effort and service variants as a suffix on the model ID and
// collapses them to the base ID, so a suffixed row takes the base row's price.
const EFFORT_TOKENS=new Set(['low','medium','high','xhigh','max','none','fast','priority','1m']);
const collapseDevinId=uid=>{
 const parts=String(uid??'').split('-');
 while(parts.length>1&&EFFORT_TOKENS.has(parts[parts.length-1]))parts.pop();
 return parts.join('-');
};
const moment=n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<8.64e15;

// Command Code publishes its own per-token table for the DeepSeek models it forwards, with the
// same off-peak figures and the same weekday UTC peak windows DeepSeek states. Its credit
// plans additionally advertise per-model multipliers, but those describe how prepaid credit is
// valued, not the token rate, so only the published table is recorded here.
// The published peak statement raises input and output. It says nothing about cache read, so
// cache read keeps its single published figure rather than inheriting the doubling.
const commandCodeRates={
 'deepseek/deepseek-v4-flash':[.15,.6,.003],
 'deepseek/deepseek-v4.1-flash':[.15,.6,.003],
};
const commandCodePeak=timestamp=>{
 if(!moment(timestamp))return null;
 const time=new Date(timestamp),day=time.getUTCDay(),hour=time.getUTCHours();
 return day>=1&&day<=5&&((hour>=1&&hour<4)||(hour>=6&&hour<10));
};

export const PROVIDER_SCOPED_EVIDENCE=Object.fromEntries(
 DEVIN_PROVIDERS.flatMap(provider=>Object.keys(devinRates).map(model=>[`${provider}\0${model}`,
  {detail:`${OCX_RELEASE} · Devin modelCostData 표`,checkedAt:DEVIN_CHECKED_AT,conditions:['list-price-reference']}])));

// Same shape as opencode-pricing's providerModelPricing so pricing.mjs keeps one selection
// order. 'local-catalog' in slot 5 keeps the estimate flag on, matching every other row whose
// price came from the installed OCX rather than from opening the provider's page here.
// OCX expected-prices.ts, verifiedAt 2026-07-20. These are API list-price
// references for the OAuth surface, not subscription charges. Cache-write is
// left unknown because the upstream tuple labels it derived.
const kimiRates={k3:[3,15,.3], 'k3[1m]':[3,15,.3],
 'kimi-k2.7-code':[.95,4,.19],'kimi-k2.7-code-highspeed':[1.9,8,.38],
 'kimi-k2.6':[.95,4,.16],'kimi-k2.5':[.6,3,.1],'kimi-for-coding':[.95,4,.19],
 // User-confirmed alias of kimi-k2.7-code-highspeed.
 'kimi-for-coding-highspeed':[1.9,8,.38]};
for(const model of Object.keys(kimiRates))PROVIDER_SCOPED_EVIDENCE[`kimi\0${model}`]={detail:'설치된 OpenCodex expected-prices.ts 참고 단가',checkedAt:'2026-07-20',conditions:['list-price-reference']};
PROVIDER_SCOPED_EVIDENCE['kimi\0kimi-for-coding-highspeed']={detail:'kimi-k2.7-code-highspeed 단가를 사용합니다(사용자 확인 별칭).',checkedAt:'2026-07-20',conditions:['alias-derived','list-price-reference']};
export function providerScopedPricing(provider,model,timestamp) {
 if(provider==='kimi'&&Object.hasOwn(kimiRates,model??'')) {
  const [input,output,read]=kimiRates[model];
  return {rate:[input,output,read,null,'https://platform.kimi.ai/docs/pricing','local-catalog'],
   checkedAt:'2026-07-20',conditions:['list-price-reference'],unsupported:['cache-write'],peak:false};
 }

 if(provider==='command-code') {
  if(!Object.hasOwn(commandCodeRates,model??''))return null;
  const peak=commandCodePeak(timestamp);
  // Without an instant the peak window cannot be decided, and guessing either way would
  // misprice by a factor of two.
  if(peak===null)return {reason:'피크 시간 확인에 필요한 호출 시각 없음'};
  const [input,output,cacheRead]=commandCodeRates[model],multiplier=peak?2:1;
  return {rate:[input*multiplier,output*multiplier,cacheRead,null,COMMAND_CODE],
   conditions:['peak-hours'],peak,effectiveFrom:null,effectiveTo:null,unsupported:['cache-write']};
 }
 if(!DEVIN_PROVIDERS.includes(provider))return null;
 const id=collapseDevinId(model);
 const dated=Object.hasOwn(DEVIN_DATED,id)?DEVIN_DATED[id]:null;
 if(dated) {
  // An absent timestamp cannot prove the promotion has ended, so it keeps the current tariff,
  // the same way the built-in promotional rows treat a missing instant.
  const promotional=!(moment(timestamp)&&timestamp>=dated.until);
  const [input,output]=promotional?dated.introductory:dated.regular;
  const boundary=new Date(dated.until).toISOString();
  return {model:id,checkedAt:DEVIN_DATED_CHECKED_AT,rate:[input,output,null,null,DEVIN],
   conditions:promotional?['promotional','list-price-reference']:['list-price-reference'],
   peak:false,effectiveFrom:promotional?null:boundary,effectiveTo:promotional?boundary:null,
   unsupported:['cache-read','cache-write']};
 }
 if(!Object.hasOwn(devinRates,id))return null;
 const [input,output,cacheRead]=devinRates[id];
 // The collapsed ID is reported so the evidence entry is found for a suffixed request too.
 return {model:id,checkedAt:null,rate:[input,output,cacheRead,null,DEVIN,'local-catalog'],conditions:['list-price-reference'],
  peak:false,effectiveFrom:null,effectiveTo:null,unsupported:['cache-write']};
}

// Why one specific target has no price. Takes the REQUESTED model ID rather than the
// canonical one: an unrecognised Ollama tag becomes undefined during alias resolution, so a
// note keyed on the canonical name would never be reached for exactly the models it explains.
export function missingPriceNote(provider,model) {
 const id=typeof model==='string'?model:'';
 if(provider==='command-code')
  return '이 제공자의 공개 단가표에서 이 모델의 행을 확인하지 못해 미확인입니다. 원 모델 제공자의 API 단가나 크레딧 배수로 대체하지 않습니다.';
 if(provider==='ollama-cloud'&&id.includes(':'))
  return '공식 가격표에서 이 크기·태그 변형의 단가를 확인하지 못해 미확인입니다. 재판매 집계 수치로 대체하지 않습니다.';
 return null;
}
