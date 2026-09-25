import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {lookupModelPrice,priceUsage} from '../src/pricing.mjs';

test('embedded Go conditional rules preserve source tariff and boundary selectors',async()=>{
 const rules=JSON.parse(await readFile(new URL('../internal/store/price_rules.json',import.meta.url),'utf8'));
 for(const r of rules){
 const timestamp=Date.parse(r.peak?'2026-09-22T02:00:00Z':'2026-09-22T00:00:00Z');
 assert.deepEqual(r.quote,lookupModelPrice(r.provider,r.model,{timestamp,inputTokens:r.inputFrom,responseServiceTier:r.tier}));
 }
 // Independent hand calculation: 800 ordinary input, 200 cached, 100 output.
 assert.equal(priceUsage({provider:'openai',model:'gpt-5.6-sol',timestamp:1800000000000,usage:{inputTokens:1000,outputTokens:100,cachedInputTokens:200}}).usd,.00528);
 assert(rules.some(r=>r.provider==='command-code'&&r.peak));
});
