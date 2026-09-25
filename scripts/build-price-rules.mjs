// Preserve the existing Node tariff selector as data consumed by the Go reader.
// This does not refresh prices or contact providers.
import {lookupModelPrice} from '../src/pricing.mjs';
import {writeFileSync} from 'node:fs';
const models=['gpt-6-astra','gpt-5.6-sol','gpt-daybreak-blue-latest','gpt-5.6-terra','gpt-5.6-luna','gpt-6-sol','gpt-6-luna','gpt-5.4-mini','grok-4.7','grok-4.7-build-fast','grok-4.6','grok-4.5','deepseek/deepseek-v4-flash','deepseek/deepseek-v4.1-flash','k3','k3[1m]','kimi-k2.7-code','kimi-k2.7-code-highspeed','kimi-k2.6','kimi-k2.5','kimi-for-coding','kimi-for-coding-highspeed'];
const providers=['openai','openai-apikey','cursor','xai','command-code','kimi'];
const rules=[];
for(const provider of providers)for(const model of models) {
 if(lookupModelPrice(provider,model,{timestamp:Date.parse('2026-09-22T00:00:00Z')}).status==='unpriced')continue;
 for(const [peak,timestamp] of [[false,'2026-09-22T00:00:00Z'],[true,'2026-09-22T02:00:00Z']])
 for(const inputTokens of [0,200000,272001])for(const tier of ['default','priority','flex']) {
 const quote=lookupModelPrice(provider,model,{timestamp:Date.parse(timestamp),inputTokens,responseServiceTier:tier});
 rules.push({provider,model,peak,inputFrom:inputTokens,tier,quote});
 }
}
writeFileSync(new URL('../internal/store/price_rules.json',import.meta.url),'[\n'+rules.map(r=>JSON.stringify(r)).join(',\n')+'\n]\n');
