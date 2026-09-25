import test from 'node:test';
import assert from 'node:assert/strict';
import {priceUsage} from '../src/pricing.mjs';
const at = s => Date.parse(s);
const row = (model='deepseek-flash', timestamp=at('2026-09-10T12:20:50Z')) => ({provider:'opencode-go',model,timestamp,usageStatus:'reported',usage:{inputTokens:20000,outputTokens:100,cachedInputTokens:10000,reasoningOutputTokens:80}});
const close = (actual,expected) => assert.ok(Number.isFinite(actual)&&Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);

test('Go Flash launch ID prices reported tokens without adding cache or reasoning twice',()=>{
 close(priceUsage(row()).usd,.00159);
 assert.equal(priceUsage(row()).basis,'official');
 assert.equal(priceUsage(row()).sourceUrl,'https://opencode.ai/docs/go/');
 close(priceUsage({...row(),provider:'opencode-go-kabcdef'}).usd,.00159);
});
test('DeepSeek peak boundaries use UTC weekdays and each request timestamp',()=>{
 for(const [stamp,mult] of [['2026-09-11T00:59:59Z',1],['2026-09-11T01:00:00Z',2],['2026-09-11T04:00:00Z',1],['2026-09-11T06:00:00Z',2],['2026-09-11T10:00:00Z',1],['2026-09-12T02:00:00Z',1]])close(priceUsage(row('deepseek-flash',at(stamp))).usd,.00159*mult);
 assert.equal(priceUsage(row('deepseek-flash',undefined)).usd,.00159);
 assert.equal(priceUsage({...row(),timestamp:null}).usd,null);
});
test('release boundary keeps pre-release prices unknown and retires Pro by provider policy',()=>{
 for(const model of ['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp']){
  assert.equal(priceUsage(row(model,at('2026-09-10T03:59:59Z'))).usd,null);
  close(priceUsage(row(model,at('2026-09-10T04:00:00Z'))).usd,.00159);
 }
 const before=row('deepseek-v4-pro',at('2026-09-14T03:59:59Z')),after=row('deepseek-v4-pro',at('2026-09-14T04:00:00Z'));
 close(priceUsage(before).usd,.014036);
 // Go has not yet confirmed its post-transition tariff; direct API has.
 assert.equal(priceUsage(after).usd,null);
 close(priceUsage({...after,provider:'deepseek'}).usd,.00159);
 assert.equal(priceUsage(row('deepseek-v4.1-flash-expires-on-0910')).usd,null);
});
test('Go prices are isolated from Zen and Ollama and respect context/cache/tier limits',()=>{
 assert.equal(priceUsage({...row(),provider:'opencode'}).usd,null);
 close(priceUsage({...row('deepseek-v4-flash'),provider:'ollama-cloud'}).usd,.004672);
 close(priceUsage({...row('grok-4.6'),usage:{inputTokens:200000,outputTokens:0}}).usd,.4);
 close(priceUsage({...row('grok-4.6'),usage:{inputTokens:200001,outputTokens:0}}).usd,.800004);
 close(priceUsage({...row('qwen3.6-plus'),usage:{inputTokens:256001,outputTokens:100}}).usd,.512602);
 assert.equal(priceUsage({...row(),responseServiceTier:'fast'}).usd,null);
 assert.equal(priceUsage({...row(),usageStatus:'unreported'}).usd,null);
 assert.equal(priceUsage({...row(),usage:{inputTokens:1,outputTokens:0,cachedInputTokens:2}}).usd,null);
 assert.equal(priceUsage({...row(),usage:{inputTokens:1,outputTokens:0,cacheCreationInputTokens:1}}).usd,null);
});
