import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {priceUsage} from '../src/pricing.mjs';
import {openHistory} from '../src/history.mjs';
const dir=await mkdtemp(join(tmpdir(),'quota-account-test-'));
const store=await openHistory(dir);
try {
 const now=Date.now();
 const row={timestamp:now-1000,requestId:'alias-replay',provider:'openai-main',model:'gpt-daybreak-blue-latest',usageStatus:'reported',usage:{inputTokens:100000,outputTokens:1000,cachedInputTokens:80000}};
 const identities={labels:new Map([['openai\0main','__main__']])};
 const file=join(dir,'usage.jsonl');await writeFile(file,JSON.stringify(row)+'\n');
 await store.ingest(file,identities,()=>({usd:null,basis:'unknown'}),now);
 store.db.prepare('DELETE FROM meta WHERE key=?').run('codexAliasPricingReplayV1');
 assert.equal(store.stats('openai','__main__',now-3600000,now).apiUsd,null);
 assert.equal(priceUsage(row).usd,.132);
 assert.equal(priceUsage(row).basis,'local-catalog');
 await store.ingest(file,identities,priceUsage,now);
 const actual=store.stats('openai','__main__',now-3600000,now);
 assert.equal(actual.apiUsd,.132);assert.equal(actual.requests,1);
 await store.ingest(file,identities,priceUsage,now);
 assert.equal(store.stats('openai','__main__',now-3600000,now).requests,1);
 assert.equal(priceUsage({...row,provider:'xai'}).usd,null);
 console.log('PASS: native alias priced; historical main-account USD repaired; replay idempotent; unrelated provider rejected');
}finally{store.close();await rm(dir,{recursive:true,force:true});}
