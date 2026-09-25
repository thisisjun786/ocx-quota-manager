// Go's token valuation is provider-specific; monthly limits are a separate metric.
export const GO_PRICING = 'https://opencode.ai/docs/go/';
export const DEEPSEEK_PRICING = 'https://api-docs.deepseek.com/quick_start/pricing/';
export const DEEPSEEK_RELEASE = 'https://api-docs.deepseek.com/news/news260910';
const FLASH_START = Date.parse('2026-09-10T04:00:00Z');
const PRO_END = Date.parse('2026-09-14T04:00:00Z');
// USD per million: input, output, cache read, cache write. Checked 2026-09-10.
const goRates = {
 'glm-5.3-flash':[.15,.5,.03,null], 'glm-5.3':[1.4,4.4,.26,null],
 'glm-5.2':[1.4,4.4,.26,null], 'glm-5.1':[1.4,4.4,.26,null],
 'kimi-k3':[3,15,.3,null], 'kimi-k2.7-code':[.95,4,.19,null], 'kimi-k2.6':[.95,4,.16,null],
 'longcat-2.0':[.3,1.2,.006,null], 'mimo-v2.5':[.14,.28,.0028,null], 'mimo-v2.5-pro':[.435,.87,.003625,null],
 'minimax-m3':[.3,1.2,.06,null], 'minimax-m2.7':[.3,1.2,.06,.375], 'minimax-m2.5':[.3,1.2,.06,.375],
 'muse-spark-1.3-contributor':[.1,.2,.002,null], 'muse-spark-1.2-contributor':[.1,.2,.002,null],
 'qwen3.8-max':[2,6,.25,2.5], 'qwen3.8-flash':[.15,.47,.016,.2], 'qwen3.7-max':[2.5,7.5,.5,3.125],
 'qwen3.7-plus':[.4,1.6,.04,.5], 'qwen3.6-plus':[.5,3,.05,.625],
 'hy4-preview':[.834,2.501,.042,null], 'hy3':[.14,.58,.035,null],
 'grok-4.6':[2,6,.5,null], 'gpt-5.6-luna':[.2,1.2,.02,.25],
};
const longContext = {
 'qwen3.7-plus':[256000,1.2,4.8,.12,1.5], 'qwen3.6-plus':[256000,2,6,.2,2.5],
 'grok-4.6':[200000,4,12,1,null], 'gpt-5.6-luna':[272000,.4,1.8,.04,.5],
};
const flashIds = new Set(['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp']);
export function providerModelPricing(provider, model, timestamp, inputTokens) {
 if (!['opencode-go','deepseek'].includes(provider)) return null;
 const source = provider === 'opencode-go' ? GO_PRICING : DEEPSEEK_PRICING;
 if (model === 'deepseek-v4.1-flash-expires-on-0910') return {reason:'종료된 DeepSeek 시험 모델의 당시 단가 미확인'};
 if (flashIds.has(model) || model === 'deepseek-v4-pro') {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp >= 8.64e15) return {reason:'피크 시간 확인에 필요한 호출 시각 없음'};
  // Do not apply today's alias/rates to older calls with no verified historical tariff.
  if (timestamp < FLASH_START) return {reason:'DeepSeek 변경 전 단가 미확인'};
  if (model === 'deepseek-v4-pro' && timestamp >= PRO_END && provider === 'opencode-go') return {reason:'Go의 V4 Pro 전환 후 단가 미확인'};
  const pro = model === 'deepseek-v4-pro' && timestamp < PRO_END;
  const date = new Date(timestamp), day = date.getUTCDay(), hour = date.getUTCHours();
  const peak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const rate = (pro ? [.66,1.98,.022,null] : [.15,.6,.003,null]).map(n => n === null ? null : n * (peak ? 2 : 1));
  // peak is reported, not only applied: a caller comparing this quote with a source
  // that has no time dimension needs to know whether a time multiplier is active now.
  return {rate:[...rate,source],conditions:['peak-hours'],peak,
   effectiveFrom:new Date(FLASH_START).toISOString(),
   effectiveTo:pro && provider === 'opencode-go' ? new Date(PRO_END).toISOString() : null};
 }
 if (provider !== 'opencode-go' || !Object.hasOwn(goRates,model)) return null;
 const tier = longContext[model];
 return {rate:[...(tier && inputTokens > tier[0] ? tier.slice(1) : goRates[model]),source],
  conditions:tier?['long-context']:[],peak:false,effectiveFrom:null,effectiveTo:null};
}
