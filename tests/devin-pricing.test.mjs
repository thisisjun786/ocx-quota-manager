import test from 'node:test';
import assert from 'node:assert/strict';

import {priceUsage,lookupModelPrice} from '../src/pricing.mjs';

const TS=Date.parse('2026-09-15T00:00:00Z');
const DEVIN_URL='https://docs.devin.ai/desktop/models';

const row=(provider,usage,extra={})=>({
 provider,
 model:'swe-2',
 timestamp:TS,
 usageStatus:'reported',
 usage,
 ...extra,
});

// Devin publishes swe-2 list prices ($3/$15 per million, $0.30 cache read) with
// no cache-write rate. Only devin and devin-cli may bill this tuple.

test('devin swe-2 prices input, cache read and output at list rates',()=>{
 const priced=priceUsage(row('devin',{
  inputTokens:1_000_000,outputTokens:100_000,cacheReadInputTokens:200_000,
 }));
 // (1M-200k)*3 + 100k*15 + 200k*0.3 = 2.40 + 1.50 + 0.06
 assert.strictEqual(priced.usd,3.96);
 assert.strictEqual(priced.basis,'official');
});

test('devin-cli swe-2 uses the same Devin rate',()=>{
 const priced=priceUsage(row('devin-cli',{
  inputTokens:1_000_000,outputTokens:100_000,cacheReadInputTokens:200_000,
 }));
 assert.strictEqual(priced.usd,3.96);
});

test('swe-2 does not bleed into other providers',()=>{
 assert.strictEqual(priceUsage(row('openai',{
  inputTokens:1_000_000,outputTokens:100_000,
 })).usd,null);
 assert.strictEqual(priceUsage(row('cursor',{
  inputTokens:1_000_000,outputTokens:100_000,
 })).usd,null);
 assert.strictEqual(lookupModelPrice('openai','swe-2').status,'unpriced');
});

test('devin swe-2 has no priced service tiers',()=>{
 const priced=priceUsage(row('devin',{
  inputTokens:1_000_000,outputTokens:100_000,
 },{responseServiceTier:'priority'}));
 assert.strictEqual(priced.usd,null);
 assert.strictEqual(
  lookupModelPrice('devin','swe-2',{responseServiceTier:'priority'}).status,
  'unpriced');
});

test('devin swe-2 cache writes are unpriced',()=>{
 const priced=priceUsage(row('devin',{
  inputTokens:1_000_000,outputTokens:100_000,cacheCreationInputTokens:50_000,
 }));
 assert.strictEqual(priced.usd,null);
});

test('devin swe-2 quote carries source provenance and list-price condition',()=>{
 const quote=lookupModelPrice('devin','swe-2');
 assert.strictEqual(quote.status,'official');
 assert.strictEqual(quote.sourceUrl,DEVIN_URL);
 assert.strictEqual(quote.checkedAt,'2026-09-15');
 assert.deepStrictEqual(quote.rates,{input:3,output:15,cacheRead:.3,cacheWrite:null});
 assert.ok(quote.conditions.includes('list-price-reference'));
});
