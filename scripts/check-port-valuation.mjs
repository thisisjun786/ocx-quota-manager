// Node/Go storage-contract comparison. QUOTA_PARITY_DB must be a stopped scratch copy.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,copyFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {openHistory} from '../src/history.mjs';
const scratch=process.env.QUOTA_PARITY_TMPDIR;
assert(scratch?.startsWith('/scratch/'), 'explicit verified scratch root required');
const root=await mkdtemp(join(scratch,'valuation-'));
const closeTo=(a,b)=>a===null||b===null?assert.equal(a,b):assert.ok(Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
let h;
try{
 const data=join(root,'data');await mkdir(data);
 if(process.env.QUOTA_PARITY_DB)await copyFile(process.env.QUOTA_PARITY_DB,join(data,'history.sqlite'));
 h=await openHistory(data);
 if(!process.env.QUOTA_PARITY_DB){
  h.set('claudeCacheAssumption',{ttl:'1h',from:1800000000000});
  h.set('cursorCacheReference',{appliedRate:.25});
  for(const [id,provider,at,usd] of [['before','anthropic',1799999999999,1],['at','anthropic',1800000000000,2],['cursor','cursor',1800000000000,5],['unknown','openai',1800000000000,null],['zero','openai',1800000000000,0]])h.db.prepare('INSERT INTO usage(id,at,provider,usd,basis) VALUES(?,?,?,?,?)').run(id,at,provider,usd,'official');
  h.db.prepare('INSERT INTO claude_cache_costs VALUES(?,?,?,?)').run('before',1,1.5,50);
  h.db.prepare('INSERT INTO claude_cache_costs VALUES(?,?,?,?)').run('at',2,3,100);
  h.db.prepare('INSERT INTO cursor_cache_costs VALUES(?,?,?,?)').run('cursor',10,2,100);
  h.db.prepare(`INSERT INTO price_evidence(digest,provider,model,status,rates,conditions,unsupported,firstRevision,firstSeenAt) VALUES(?,?,?,?,?,?,?,?,?)`).run('synthetic','anthropic','m','official',JSON.stringify({input:10,output:50,cacheRead:.25,cacheWrite:12.5}),'[]','[]','test',1800000000000);
 }
 const baseline=h.db.prepare('SELECT id,usd,basis,cacheEstimated,estimatedCachedTokens,noCacheUsd FROM usage_valued ORDER BY id').all();
 const evidence=h.db.prepare('SELECT provider,model,rates FROM price_evidence ORDER BY id').all();
 const raw=h.db.prepare('SELECT id,usd FROM usage ORDER BY id').all();h.close();h=null;
 const result=spawnSync(process.env.QUOTA_PORT_HARNESS??resolve('dist/port-harness'),{input:JSON.stringify({mode:'db-read',data}),encoding:'utf8',maxBuffer:128*1024*1024});
 assert.equal(result.status,0,result.stderr);const got=JSON.parse(result.stdout);assert.equal(got.ok,true);assert.equal(got.schemaOK,true);
 const rows=new Map(got.usage.map(r=>[r.id,r]));assert.equal(rows.size,baseline.length);
 for(const before of baseline){const after=rows.get(before.id);assert(after);closeTo(before.usd,after.usd);assert.equal(after.basis,before.basis);assert.equal(after.cacheEstimated,!!before.cacheEstimated);closeTo(before.estimatedCachedTokens,after.estimatedCachedTokens);closeTo(before.noCacheUsd,after.noCacheUsd)}
 assert.equal(got.evidence.length,evidence.length);
 for(let i=0;i<evidence.length;i++){const x=JSON.parse(evidence[i].rates),want=Array.isArray(x)?x:['input','output','cacheRead','cacheWrite'].map(k=>x[k]??null);assert.deepEqual(got.evidence[i].rates,want)}
 h=await openHistory(data);assert.deepEqual(h.db.prepare('SELECT id,usd FROM usage ORDER BY id').all(),raw);assert.equal(h.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');h.close();h=null;
 console.log(JSON.stringify({status:'PASS',rows:baseline.length,evidence:evidence.length,nodeReopen:true,rawStoredUsdUnchanged:true,source:process.env.QUOTA_PARITY_DB?'private stopped copy':'synthetic'}));
}finally{h?.close();await rm(root,{recursive:true,force:true})}
