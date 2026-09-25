import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdtemp,open,rename,rm,truncate,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openHistory} from '../src/history.mjs';
import {createModelRoster} from '../src/model-roster.mjs';
import {MEASURED_AT, IDENTITY_EPOCH} from '../src/time.mjs';
import {basisDigest} from '../src/quota-observations.mjs';
const DAY=86400000,NOW=1800000000000,TEN=600000,MIN=60000;
async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'quota-retention-'));
 const store=await openHistory(dir,options);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return {dir,store};
}
const usage=(requestId,timestamp)=>({requestId,timestamp,provider:'openai',model:'m',usage:{outputTokens:1}});
const snapshot=(at,used=10)=>({providers:[{id:'openai',accounts:[{id:'a1',updatedAt:new Date(at).toISOString(),windows:[{id:'weekly',usedPercent:used,resetAt:new Date(NOW+DAY).toISOString(),stale:false}]}]}]});
test('retention removes only expired records and their timings, preserving cutoff and metadata',async t=>{
 const {store:s}=await fixture(t);const cutoff=NOW-90*DAY;
 s.db.exec('CREATE TABLE ollama_observations (source TEXT,at INTEGER,payload TEXT,PRIMARY KEY(source,at))');
 for(const [id,at] of [['old',cutoff-1],['edge',cutoff],['new',NOW]]){
  s.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,at,'ollama-cloud','a','m',1,1,0,2,1,'official');
  s.db.prepare('INSERT INTO usage_timings VALUES (?,?,?,?)').run(id,1,1,1);
  s.db.prepare('INSERT INTO samples VALUES (?,?,?,?,?,?)').run('p','a','weekly',at,NOW+DAY,10);
  s.db.prepare('INSERT INTO ollama_observations VALUES (?,?,?)').run('test',at,'{}');
 }
 s.set('usageCursor',{offset:123});s.set('historyStartedAt',cutoff-1);
 s.maintain(NOW);
 for(const table of ['usage','samples','ollama_observations','usage_timings']) assert.equal(s.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,2);
 assert.deepEqual(s.get('usageCursor'),{offset:123});assert.equal(s.get('historyStartedAt'),cutoff-1);
 s.maintain(NOW);assert.equal(s.db.prepare('SELECT count(*) n FROM usage').get().n,2);
});
test('expired source rows stay excluded on reimport while recent usage remains idempotent',async t=>{
 const {store:s,dir}=await fixture(t),file=join(dir,'usage.jsonl');
 const rows=[['old',NOW-91*DAY],['new',NOW]].map(([requestId,timestamp])=>({requestId,timestamp,provider:'openai',model:'m',usage:{outputTokens:1}}));
 await writeFile(file,rows.map(JSON.stringify).join('\n')+'\n');
 const ids={labels:new Map()};await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,1);
 s.set('usageCursor',null);await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,1);
});
test('history reset keeps the exact boundary and excludes older sources across replay and rotation',async t=>{
 const {store:s,dir}=await fixture(t),file=join(dir,'usage.jsonl'),reset=NOW-DAY,ids={labels:new Map()};
 s.set('historyResetAt',reset);
 s.capture(snapshot(reset-1,9),NOW);s.capture(snapshot(reset,10),NOW);s.capture(snapshot(reset,10),NOW);s.capture(snapshot(reset+1,11),NOW);
 assert.deepEqual(s.points('openai','a1','weekly',0).map(row=>row.at),[reset,reset+1]);
 await writeFile(file,[usage('old',reset-1),usage('edge',reset),usage('new',reset+1)].map(JSON.stringify).join('\n')+'\n');
 await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,2);
 s.set('usageCursor',null);s.db.prepare('DELETE FROM meta WHERE key=?').run('ollamaPricingReplayV1');
 await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,2);
 await rename(file,join(dir,'usage.jsonl.1'));
 await writeFile(file,[usage('old-after-rotation',reset-1),usage('new-after-rotation',reset+2)].map(JSON.stringify).join('\n')+'\n');
 await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,3);
});
test('history reset rejects an old source line completed after the reset marker',async t=>{
 const {store:s,dir}=await fixture(t),file=join(dir,'usage.jsonl'),ids={labels:new Map()};
 const old=JSON.stringify(usage('old-partial',NOW-1));
 await writeFile(file,old.slice(0,-1));await s.ingest(file,ids,()=>({usd:1}),NOW);
 s.set('historyResetAt',NOW);
 await appendFile(file,old.slice(-1)+'\n'+JSON.stringify(usage('new-complete',NOW))+'\n');
 await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,1);
});
test('without a history reset marker, in-retention older sources are retained',async t=>{
 const {store:s,dir}=await fixture(t),file=join(dir,'usage.jsonl'),at=NOW-DAY;
 s.capture(snapshot(at),NOW);await writeFile(file,JSON.stringify(usage('pre-reset-default',at))+'\n');
 await s.ingest(file,{labels:new Map()},()=>({usd:1}),NOW);
 assert.equal(s.points('openai','a1','weekly',0).length,1);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,1);
});
test('database page cap stops growth and leaves committed records readable',async t=>{
 const {store:s}=await fixture(t,{maxBytes:1024*1024});
 s.set('sentinel','preserved');
 s.db.exec('CREATE TABLE fill (payload BLOB)');
 assert.throws(()=>{for(let i=0;i<100;i++)s.db.exec('INSERT INTO fill VALUES (zeroblob(65536))');},/full/i);
 assert.equal(s.get('sentinel'),'preserved');
 const size=s.db.prepare('PRAGMA page_count').get().page_count*s.db.prepare('PRAGMA page_size').get().page_size;
 assert.ok(size<=1024*1024);
});

test('failed maintenance rolls back every table and its completion timestamp',async t=>{
 const {store:s}=await fixture(t);
 s.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('old',NOW-91*DAY,'p','a','m',1,1,0,2,1,'official');
 s.db.prepare('INSERT INTO samples VALUES (?,?,?,?,?,?)').run('p','a','weekly',NOW-91*DAY,NOW+DAY,10);
 s.db.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON samples BEGIN SELECT RAISE(ABORT,'test interruption'); END");
 assert.throws(()=>s.maintain(NOW),/test interruption/);
 assert.equal(s.stats('p',undefined,0,NOW).requests,1);
 assert.equal(s.get('lastMaintenanceAt'),null);
});

test('full-disk ingestion preserves the committed cursor for retry',async t=>{
 const {store:s,dir}=await fixture(t,{maxBytes:1024*1024});
 s.set('usageCursor',{ino:'prior',offset:0});
 const file=join(dir,'usage.jsonl');
 const rows=Array.from({length:10000},(_,i)=>JSON.stringify({requestId:String(i),timestamp:NOW,provider:'openai',model:'m'.repeat(200),usage:{outputTokens:1}}));
 await writeFile(file,rows.join('\n')+'\n');
 await assert.rejects(s.ingest(file,{labels:new Map()},()=>({usd:1}),NOW),/full/i);
 assert.equal(s.db.isTransaction,false);
 const cursor=s.get('usageCursor');
 assert.ok(cursor.offset<Buffer.byteLength(rows.join('\n')+'\n'));
 assert.equal(s.get('usageReadAt'),null);
});

const HOUR=3600000;
const observation=s=>({since:s.get('usageObservedSince'),through:s.get('usageObservedThrough'),pending:s.get('usageTailPending')});

test('a rotated or rewritten log restarts the observation run; a pricing replay does not',async t=>{
 const {store:s,dir}=await fixture(t);
 const file=join(dir,'usage.jsonl');
 await writeFile(file,JSON.stringify(usage('one',NOW-HOUR))+'\n');
 await s.ingest(file,{labels:new Map()},()=>({usd:1,basis:'official'}),NOW-HOUR);
 assert.equal(observation(s).since,NOW-HOUR);
 // Re-reading the same file for a tariff change is not lost history.
 s.db.prepare('DELETE FROM meta WHERE key=?').run('ollamaPricingReplayV1');
 await s.ingest(file,{labels:new Map()},()=>({usd:1,basis:'official'}),NOW-HOUR/2);
 assert.equal(observation(s).since,NOW-HOUR);
 // A different file is a different history.
 await rename(file,file+'.old');
 await writeFile(file,JSON.stringify(usage('two',NOW))+'\n');
 await s.ingest(file,{labels:new Map()},()=>({usd:1,basis:'official'}),NOW);
 assert.equal(observation(s).since,NOW);
});

test('truncating the log in place restarts the observation run',async t=>{
 const {store:s,dir}=await fixture(t);
 const file=join(dir,'usage.jsonl');
 await writeFile(file,Array.from({length:200},(unused,i)=>JSON.stringify(usage('r'+i,NOW-HOUR))).join('\n')+'\n');
 await s.ingest(file,{labels:new Map()},()=>({usd:1,basis:'official'}),NOW-HOUR);
 assert.equal(observation(s).since,NOW-HOUR);
 await writeFile(file,'\n');
 await s.ingest(file,{labels:new Map()},()=>({usd:1,basis:'official'}),NOW);
 assert.equal(observation(s).since,NOW);
});

test('a record left unresolved holds the observed end, and losing it restarts the run',async t=>{
 const price=()=>({usd:1,basis:'official'});
 const ids={labels:new Map()};
 const complete=await fixture(t),vanished=await fixture(t);
 for(const {store:s,dir} of [complete,vanished]){
  const file=join(dir,'usage.jsonl');
  await writeFile(file,JSON.stringify(usage('first',NOW-2*HOUR))+'\n');
  await s.ingest(file,ids,price,NOW-2*HOUR);
  // A half-written final line: read, but not resolvable yet.
  await appendFile(file,JSON.stringify(usage('partial',NOW-HOUR)).slice(0,40));
  await s.ingest(file,ids,price,NOW-HOUR);
  assert.ok(observation(s).pending,'tail recorded');
  assert.equal(observation(s).through,NOW-2*HOUR,'end held at the last complete read');
 }
 // Finishing the line resolves it: the same bytes are still there.
 const file=join(complete.dir,'usage.jsonl');
 const line=JSON.stringify(usage('partial',NOW-HOUR));
 await appendFile(file,line.slice(40)+'\n');
 await complete.store.ingest(file,ids,price,NOW);
 assert.equal(observation(complete.store).since,NOW-2*HOUR);
 assert.equal(observation(complete.store).through,NOW);
 assert.equal(observation(complete.store).pending,null);
 // Dropping the pending record and appending an unrelated newline is not resolution.
 const other=join(vanished.dir,'usage.jsonl');
 await writeFile(other,JSON.stringify(usage('first',NOW-2*HOUR))+'\n'+'\n');
 await vanished.store.ingest(other,ids,price,NOW);
 assert.equal(observation(vanished.store).since,NOW);
});

test('a failed read records the break without inventing a successful read',async t=>{
 const {store:s,dir}=await fixture(t,{maxBytes:1024*1024});
 const file=join(dir,'usage.jsonl');
 const rows=Array.from({length:10000},(unused,i)=>JSON.stringify({requestId:String(i),timestamp:NOW,provider:'openai',model:'m'.repeat(200),usage:{outputTokens:1}}));
 await writeFile(file,rows.join('\n')+'\n');
 await assert.rejects(s.ingest(file,{labels:new Map()},()=>({usd:1}),NOW),/full/i);
 assert.equal(s.get('usageReadAt'),null);
 // The run start is recorded because the discontinuity is real; the endpoint is not,
 // so no span is claimed.
 assert.equal(s.get('usageObservedSince'),NOW);
 assert.equal(s.get('usageObservedThrough'),null);
});

const MiB=1024*1024,BATCH=MiB;
// Every 1 MiB chunk and the final partial chunk carry their own marker, so hashing one
// chunk repeatedly, or only a prefix, cannot produce the expected digest. No byte is a
// newline, so the whole body stays one unfinished record.
const tailBody=size=>{
 const body=Buffer.alloc(size);
 for(let i=0;i<size;i++)body[i]=97+(i%23);
 for(let off=0;off<size;off+=MiB)if(off+6<=size)body.write('CHUNK'+(off/MiB),off);
 if(size>=3)body.write('END',size-3);
 return body;
};
// Watch every buffer allocator the implementation could reach, so swapping Buffer.alloc
// for an unsafe variant cannot hide an allocation from the measurement.
const watchAllocations=()=>{
 const originals={alloc:Buffer.alloc,allocUnsafe:Buffer.allocUnsafe,allocUnsafeSlow:Buffer.allocUnsafeSlow};
 const sizes=[];
 for(const name of Object.keys(originals))
  Buffer[name]=function(length,...rest){if(typeof length==='number')sizes.push(length);return originals[name].call(Buffer,length,...rest);};
 return {sizes,restore(){for(const name of Object.keys(originals))Buffer[name]=originals[name];}};
};
const measure=async run=>{const watch=watchAllocations();try{await run();}finally{watch.restore();}return watch.sizes;};

test('verifying a tail hashes the whole range without allocating alongside it',async t=>{
 const ids={labels:new Map()},price=()=>({usd:1,basis:'official'});
 for(const size of [64,BATCH+1,2*MiB,8*MiB]){
  const {store:s,dir}=await fixture(t);
  const file=join(dir,'usage.jsonl');
  // The large cases sit behind one complete record so the tail does not start at zero;
  // an implementation that ignored the offset would still match a zero-offset fixture.
  const prefix=size>BATCH?JSON.stringify(usage('complete',NOW-HOUR))+'\n':'';
  const from=Buffer.byteLength(prefix);
  const body=tailBody(size);
  await writeFile(file,Buffer.concat([Buffer.from(prefix),body]));
  const first=await measure(()=>s.ingest(file,ids,price,NOW-HOUR));
  assert.ok(first.length>0,size+' allocations observed');
  assert.ok(Math.max(...first)<=BATCH,size+' first read peak '+Math.max(...first));
  if(size===64)assert.equal(Math.max(...first),64);
  const pending=s.get('usageTailPending');
  assert.equal(pending.from,from,size+' tail start');
  assert.equal(pending.length,size,size+' tail length');
  assert.equal(pending.digest,createHash('sha256').update(body).digest('hex'),size+' tail digest');
  assert.equal(s.get('usageObservedThrough'),null,size+' unresolved tail holds the end');
  // The next poll re-verifies the stored range; that path must stay bounded too.
  const second=await measure(()=>s.ingest(file,ids,price,NOW));
  assert.ok(second.length>0,size+' second allocations observed');
  assert.ok(Math.max(...second)<=BATCH,size+' second read peak '+Math.max(...second));
  assert.equal(s.get('usageObservedSince'),NOW-HOUR,size+' unchanged file keeps the run');
  assert.deepEqual(s.get('usageTailPending'),pending,size+' unchanged file keeps the record');
  if(size<=BATCH+1)continue;
  // Change one byte past the first chunk, keeping the size, the first bytes and the
  // consumed boundary. Only reading the range to its end can notice.
  const handle=await open(file,'r+');
  try{await handle.write(Buffer.from([0x21]),0,1,from+BATCH+12345);}finally{await handle.close();}
  await s.ingest(file,ids,price,NOW+HOUR);
  assert.equal(s.get('usageObservedSince'),NOW+HOUR,size+' a byte past the first chunk restarts the run');
 }
});

test('a tail digest we never managed to read is not a match',async t=>{
 const {store:s,dir}=await fixture(t);
 const ids={labels:new Map()},price=()=>({usd:1,basis:'official'});
 const file=join(dir,'usage.jsonl');
 await writeFile(file,'a'.repeat(100));
 await s.ingest(file,ids,price,NOW-HOUR);
 // The file shrank while the tail was being read, so the stored digest is null.
 s.set('usageTailPending',{from:0,length:100,digest:null});
 s.set('usageObservedSince',NOW-HOUR);
 await truncate(file,50);
 await s.ingest(file,ids,price,NOW);
 // Comparing one failed read against another must not read as an unbroken run.
 assert.equal(s.get('usageObservedSince'),NOW);
});


// Replace the file handle's read for the duration of one ingest so a read can come back
// short of what was asked without needing a filesystem that does that. Only reads larger
// than the 64-byte fingerprint are scripted, by the order in which they arrive.
const withReadFaults=async(file,script,run)=>{
 const probe=await open(file,'r');const proto=Object.getPrototypeOf(probe);await probe.close();
 const original=proto.read;
 let match=0,fired=0;
 proto.read=async function(buffer,offset,length,position){
  if(length>64){
   const behaviour=script[match++];
   if(behaviour==='short'){fired++;return original.call(this,buffer,offset,Math.max(1,Math.floor(length/2)),position);}
   if(behaviour==='none'){fired++;return {bytesRead:0,buffer};}
  }
  return original.call(this,buffer,offset,length,position);
 };
 try{await run();}finally{proto.read=original;}
 return fired;
};

test('a read that comes back short keeps hashing; one that stops short stays incomplete',async t=>{
 const ids={labels:new Map()},price=()=>({usd:1,basis:'official'});
 const body=tailBody(300);
 const start=async()=>{
  const {store:s,dir}=await fixture(t);
  const file=join(dir,'usage.jsonl');
  const prefix=JSON.stringify(usage('complete',NOW-2*HOUR))+'\n';
  await writeFile(file,Buffer.concat([Buffer.from(prefix),body]));
  return {s,file,from:Buffer.byteLength(prefix)};
 };
 const expected=createHash('sha256').update(body).digest('hex');
 // Writing the tail record: two reads finish the range that one read did not.
 const whole=await start();
 assert.equal(await withReadFaults(whole.file,[,,'short'],()=>whole.s.ingest(whole.file,ids,price,NOW)),1);
 assert.equal(whole.s.get('usageTailPending').digest,expected);
 assert.equal(whole.s.get('usageObservedThrough'),null,'the unresolved record still holds the end');
 // Stopping before the range ends leaves the record unverified, not verified.
 const stopped=await start();
 assert.equal(await withReadFaults(stopped.file,[,,'short','none'],()=>stopped.s.ingest(stopped.file,ids,price,NOW)),2);
 assert.equal(stopped.s.get('usageTailPending').digest,null);
 const empty=await start();
 assert.equal(await withReadFaults(empty.file,[,,'none'],()=>empty.s.ingest(empty.file,ids,price,NOW)),1);
 assert.equal(empty.s.get('usageTailPending').digest,null);
 // Re-verifying a stored record: the same two shapes, one poll later.
 const rechecked=await start();
 await rechecked.s.ingest(rechecked.file,ids,price,NOW-HOUR);
 assert.equal(rechecked.s.get('usageTailPending').digest,expected);
 assert.equal(await withReadFaults(rechecked.file,['short'],()=>rechecked.s.ingest(rechecked.file,ids,price,NOW)),1);
 assert.equal(rechecked.s.get('usageObservedSince'),NOW-HOUR,'a short read that finishes keeps the run');
 const broken=await start();
 await broken.s.ingest(broken.file,ids,price,NOW-HOUR);
 assert.equal(await withReadFaults(broken.file,['short','none'],()=>broken.s.ingest(broken.file,ids,price,NOW)),2);
 assert.equal(broken.s.get('usageObservedSince'),NOW,'a verification that stopped short restarts the run');
});

test('retention removes price links with their usage rows and drops records nothing points at',async t=>{
 const {store:s}=await fixture(t);const cutoff=NOW-90*DAY;
 const record=(id,digest)=>s.db.prepare(`INSERT INTO price_evidence (id,digest,provider,model,status,
   sourceUrl,checkedAt,effectiveFrom,effectiveTo,rates,tierMultiplier,conditions,unsupported,conflict,
   reason,firstRevision,firstSeenAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(id,digest,'openai','m','official',null,null,null,null,'{"input":1}',1,'[]','[]',null,null,'rev',NOW);
 // One record shared by an expired row and a live one, one used by an expired row alone.
 record(1,'shared');record(2,'expiring-only');
 for(const [id,at,evidence] of [['old',cutoff-1,1],['new',NOW,1],['old-only',cutoff-1,2]]){
  s.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,at,'openai','a','m',1,1,0,2,1,'official');
  s.db.prepare('INSERT INTO usage_prices VALUES (?,?,?)').run(id,evidence,at);
 }
 // A link whose usage row is already gone, as a release that did not know this table would leave it.
 s.db.prepare('INSERT INTO usage_prices VALUES (?,?,?)').run('vanished',2,NOW);
 s.maintain(NOW);
 assert.deepEqual(s.db.prepare('SELECT id FROM usage_prices ORDER BY id').all().map(r=>r.id),['new']);
 assert.deepEqual(s.db.prepare('SELECT id FROM price_evidence ORDER BY id').all().map(r=>r.id),[1]);
});

// --- JUN-123: the evidence behind a stored percentage ------------------------------------
// A window as the direct provider path publishes it: a measurement contract, the instant it was
// measured, and the epoch it was committed under. Both instants ride on symbols, so the shapes
// here are the shapes history actually receives.
const measured=(over={})=>({source:'openai/wham-usage',sourceVersion:'v1',method:'used_limit',
 reportedPercent:null,used:123.4,limit:1000,limitState:'present',unit:'credits',scopeKey:'all',
 cycleKey:'c1',windowSemantics:'fixed_reset',precisionEvidence:'observed_fraction',resolutionPp:null,
 reconciliation:'matched',usedAccumulation:'unknown',calculatedPercent:12.34,observedAt:null,fetchedAt:null,...over});
const directSnap=(at,{used=12.34,measurement={},epoch=1,reset=NOW+DAY,window='weekly'}={})=>({providers:[{id:'openai',
 accounts:[{id:'a1',updatedAt:new Date(at).toISOString(),windows:[{id:window,usedPercent:Math.min(100,used),
  resetAt:new Date(reset).toISOString(),stale:false,measurement:measured(measurement),
  [MEASURED_AT]:at,[IDENTITY_EPOCH]:epoch}]}]}]});
const obsRows=s=>s.db.prepare('SELECT * FROM quota_observations ORDER BY seq').all();

test('a stored percentage and the evidence for it are one transaction, or neither happens',async t=>{
 const {store:s}=await fixture(t);
 s.capture(directSnap(NOW-TEN,{used:12.34,measurement:{used:123.4,calculatedPercent:12.34}}),NOW);
 assert.equal(s.points('openai','a1','weekly',0).length,1);
 assert.equal(obsRows(s).length,1);
 // Make the evidence write fail. The sample beside it must not survive on its own.
 s.db.exec("CREATE TRIGGER refuse BEFORE INSERT ON quota_observations BEGIN SELECT RAISE(ABORT,'refused'); END");
 assert.throws(()=>s.capture(directSnap(NOW,{used:50}),NOW),/refused/);
 assert.equal(s.points('openai','a1','weekly',0).length,1,'the sample rolled back with its evidence');
 assert.equal(obsRows(s).length,1);
 s.db.exec('DROP TRIGGER refuse');
});

test('retention drops evidence on the same boundary as the samples it explains',async t=>{
 const {store:s}=await fixture(t);
 for(const [at,used] of [[NOW-89*DAY,9],[NOW-TEN,10],[NOW,11]]) s.capture(directSnap(at,{used}),NOW);
 assert.equal(obsRows(s).length,3);
 // Five days later the oldest row has fallen out of the 90-day window.
 const later=NOW+5*DAY, cutoff=later-90*DAY;
 s.maintain(later);
 assert.equal(obsRows(s).length,2,'only the expired row goes');
 assert.equal(s.db.prepare('SELECT count(*) n FROM samples').get().n,2);
 assert.ok(obsRows(s).every(row=>row.at>=cutoff));
});

test('a database written before this table existed opens, keeps its samples, and leaves them unknown',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-legacy-'));
 t.after(async()=>{await rm(dir,{recursive:true,force:true});});
 const older=await openHistory(dir);
 older.capture(snapshot(NOW-TEN,9),NOW);
 older.db.exec('DROP TABLE quota_observations');
 older.close();
 const s=await openHistory(dir);
 t.after(()=>s.close());
 assert.deepEqual(s.points('openai','a1','weekly',0).map(r=>r.used),[9],'the old sample still reads');
 assert.equal(obsRows(s).length,0);
 // No evidence means unknown, not the account that happens to hold the id now.
 assert.deepEqual(s.pointIdentities('openai','a1','weekly',0),[]);
});

test('evidence, its basis and its identity survive closing and reopening',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-restart-'));
 t.after(async()=>{await rm(dir,{recursive:true,force:true});});
 const first=await openHistory(dir);
 first.capture(directSnap(NOW-TEN,{used:12.34,epoch:7,measurement:{used:123.4,calculatedPercent:12.34}}),NOW);
 const before=obsRows(first)[0];
 first.close();
 const s=await openHistory(dir);
 t.after(()=>s.close());
 const after=s.observations('openai','a1','weekly',0)[0];
 assert.equal(after.epoch,7);
 assert.equal(after.basis,before.basis);
 assert.equal(after.observedPercent,12.34);
 assert.equal(after.used,123.4);
 assert.equal(after.usedAccumulation,'unknown');
 assert.deepEqual(s.pointIdentities('openai','a1','weekly',0),[{at:NOW-TEN,epoch:7}]);
});

test('a reading whose numbers repeat but whose basis changed is still recorded',async t=>{
 const {store:s}=await fixture(t);
 const at=NOW-TEN;
 s.capture(directSnap(at,{used:12.34,measurement:{used:123.4,calculatedPercent:12.34}}),NOW);
 // Same instant, same percentage, different denominator. The percentage alone says nothing changed.
 s.capture(directSnap(at,{used:12.34,measurement:{used:111.06,limit:900,calculatedPercent:12.34}}),NOW);
 const rows=obsRows(s);
 assert.equal(rows.length,2,'a changed basis at one instant is two observations');
 assert.notEqual(rows[0].basis,rows[1].basis);
 assert.deepEqual(rows.map(r=>r.limitValue),[1000,900]);
 assert.equal(s.points('openai','a1','weekly',0).length,1,'the samples table keeps one row per instant');
 // The surviving sample came from the first reading, and only that observation claims it.
 assert.deepEqual(rows.map(r=>r.pairsSample),[1,0]);
 assert.deepEqual(s.pointIdentities('openai','a1','weekly',0),[{at,epoch:1}]);
});

test('a correction above the limit is kept whole, not flattened by the hundred percent cap',async t=>{
 const {store:s}=await fixture(t);
 const reading=(at,percent)=>s.capture(directSnap(at,{used:percent,
  measurement:{method:'reported_percent',reportedPercent:percent,used:null,limit:null,
   limitState:'missing',calculatedPercent:null}}),NOW);
 reading(NOW-3*MIN,137.5); reading(NOW-2*MIN,137.1); reading(NOW-MIN,137.5);
 const rows=obsRows(s);
 // Every window published 100, so a rule reading the window would see no movement at all.
 assert.deepEqual(s.points('openai','a1','weekly',0).map(r=>r.used),[100]);
 assert.deepEqual(rows.map(r=>r.observedPercent),[137.5,137.1,137.5]);
 assert.deepEqual(rows.map(r=>r.reportedPercent),[137.5,137.1,137.5]);
});

test('a reading with no identity evidence is not credited to whoever holds the account now',async t=>{
 const {store:s}=await fixture(t);
 s.transact(()=>s.epochs.open('openai','a1',{basis:'oauth',digest:null,storable:false},NOW-DAY,'first'));
 assert.equal(s.epochs.current('openai','a1').epoch,1,'an epoch really is open');
 // A cached OpenCodex window: a percentage, and nothing that says who it was read from.
 s.capture(snapshot(NOW-TEN,9),NOW);
 const rows=obsRows(s);
 assert.equal(rows.length,1);
 assert.equal(rows[0].epoch,null,'unknown identity stays unknown');
 assert.equal(rows[0].precisionEvidence,'unknown');
 assert.equal(rows[0].usedAccumulation,'unknown');
 assert.equal(rows[0].observedPercent,9);
 assert.deepEqual(s.pointIdentities('openai','a1','weekly',0),[{at:NOW-TEN,epoch:null}]);
});

test('a repeated reading adds nothing; a timestamp that moves backwards is evidence',async t=>{
 const {store:s}=await fixture(t);
 const at=NOW-TEN;
 for(let i=0;i<3;i++) s.capture(directSnap(at,{used:12.34,measurement:{used:123.4,calculatedPercent:12.34}}),NOW);
 assert.equal(obsRows(s).length,1,'three identical captures are one observation');
 assert.equal(s.points('openai','a1','weekly',0).length,1);
 // The provider now hands us an earlier observation time with everything else unchanged.
 s.capture(directSnap(at-MIN,{used:12.34,measurement:{used:123.4,calculatedPercent:12.34}}),NOW);
 const rows=obsRows(s);
 assert.equal(rows.length,2,'time going backwards is recorded, or nothing downstream can see it');
 assert.deepEqual(rows.map(r=>r.at),[at,at-MIN]);
});

test('an upgraded database accepts a reading stored before the accumulation contract existed',async t=>{
 const {store:s}=await fixture(t);
 // A measurement persisted by an earlier release: no usedAccumulation key at all.
 const legacy=measured(); delete legacy.usedAccumulation;
const snap=directSnap(NOW-TEN,{used:12.34});
snap.providers[0].accounts[0].windows[0].measurement=legacy;
s.capture(snap,NOW);
assert.equal(obsRows(s)[0].usedAccumulation,'unknown','missing means unknown, not a binding failure');
});

// --- JUN-53: 한 고장을 네 보존 대상이 함께 통과하는가 --------------------------------------
// 사용량(usage), 가격 근거(price_evidence·usage_prices), 쿼타 원본 근거(quota_observations),
// 그리고 모델 목록(meta 의 modelRosterV1). 앞의 셋은 90일 경계로 지워지고 마지막 하나는 다른 규칙으로
// 잊는다. 그래서 셋만 확인하고 넘어가기 가장 쉬운 자리가 모델 목록이다.
const EVIDENCE={provider:'openai',model:'m',status:'official',sourceUrl:null,checkedAt:null,
 effectiveFrom:null,effectiveTo:null,rates:{input:1,output:1,cacheRead:null,cacheWrite:null},
 tierMultiplier:null,conditions:[],unsupported:[],conflict:null,reason:null};
const priced=()=>({usd:1,basis:'official',evidence:{...EVIDENCE}});
// 전 열을 담는다. id 나 digest 만 담으면 내용이 바뀌어도 통과한다.
const rows=s=>({
 usage:s.db.prepare('SELECT * FROM usage ORDER BY id').all(),
 samples:s.db.prepare('SELECT * FROM samples ORDER BY provider,account,window,at').all(),
 observations:s.db.prepare('SELECT * FROM quota_observations ORDER BY seq').all(),
 prices:s.db.prepare('SELECT * FROM usage_prices ORDER BY id').all(),
 evidence:s.db.prepare('SELECT * FROM price_evidence ORDER BY id').all(),
 roster:s.db.prepare("SELECT value FROM meta WHERE key='modelRosterV1'").get()?.value??null});
const rosterView=(roster,id='openai')=>{
 const snap={providers:[{id,analytics:{}}],analytics:{}};roster.enrich(snap,new Set());
 return {provider:snap.providers[0].analytics.modelRoster,summary:snap.analytics.modelRoster};};
const bulk=n=>Array.from({length:n},(unused,i)=>'bulk-model-'+String(i).padStart(5,'0'));
const listedAs=list=>({providers:[{id:'openai',supportedModels:list,defaultModel:list[0]}]});
// 네 대상을 전부 실제 쓰기 경로로 채운다. 손으로 INSERT 하면 record 가 실제로 만드는 모양과
// 같다는 보장이 없어 보존을 증명하지 못한다.
async function seedAll({dir,store:s},roster,models,extra=[]){
 const file=join(dir,'usage.jsonl');
 await writeFile(file,[usage('seed',NOW-TEN),...extra].map(JSON.stringify).join('\n')+'\n');
 await s.ingest(file,{labels:new Map()},priced,NOW);
 s.capture(directSnap(NOW-TEN,{used:12.34,measurement:{used:123.4,calculatedPercent:12.34}}),NOW);
 roster.record(listedAs(models),NOW);
 return file;
}

test('저장 공간이 꽉 차도 네 보존 대상은 그대로 남고, 모델 목록은 실패를 status 로 말한다',async t=>{
 const fx=await fixture(t,{maxBytes:1024*1024}),s=fx.store;
 const roster=createModelRoster({store:s,now:()=>NOW});
 await seedAll(fx,roster,bulk(400));
 // 400개가 admit 를 통과했는지 먼저 본다. 통과하지 못하면 이 시나리오 전체가 무의미하다.
 assert.equal(rosterView(roster).provider.knownCount,401,'400 listed plus the one only the log saw');
 const first=rosterView(roster).provider.models.find(m=>m.model==='bulk-model-00000').firstSeenAt;
 const before=rows(s);
 for(const key of ['usage','samples','observations','prices','evidence'])
  assert.ok(before[key].length,key+' seeded');
 assert.ok(before.roster.length>4096,'the stored roster needs more than one page');
 // 빈틈없이 채운다. 큰 블롭만 넣고 멈추면 페이지 여유가 남아 다음 단계가 그냥 통과한다.
 s.db.exec('CREATE TABLE fill (payload BLOB)');
 for(const size of [65536,4096,1024,256,64,8,1]){
  try{for(let i=0;i<20000;i++)s.db.exec('INSERT INTO fill VALUES (zeroblob('+size+'))');}catch{}}
 // 고장이 실제로 걸렸다는 증거를 먼저 세운다. capture() 는 여기서 던지지 않는다 -- 작은 행은 잎 페이지
 // 여유에 들어가 성공하고, 성공하면 샘플이 하나 늘어 아래 동일성 비교까지 무너진다.
 assert.equal(s.db.prepare('PRAGMA page_count').get().page_count,
  s.db.prepare('PRAGMA max_page_count').get().max_page_count);
 assert.equal(s.db.prepare('PRAGMA freelist_count').get().freelist_count,0);
 assert.throws(()=>s.db.exec('INSERT INTO fill VALUES (zeroblob(4096))'),/full/i,'the cap is engaged');
 // 로스터는 자기 실패를 삼키므로 던지지 않는다. status 가 고장이 거기까지 닿았다는 유일한 증거다.
 // 증분이 작으면 안 된다: INSERT OR REPLACE 가 방금 해제한 오버플로 페이지를 재사용해 성공한다.
 roster.record(listedAs(bulk(460)),NOW+MIN);
 assert.equal(rosterView(roster).summary.status,'error','the full database reached the roster');
 assert.deepEqual(rows(s),before,'nothing moved while the database was full');
 // 회복. PRAGMA 는 페이지를 한 장도 쓰지 않는다.
 s.db.exec('PRAGMA max_page_count='+s.db.prepare('PRAGMA max_page_count').get().max_page_count*40);
 roster.record(listedAs(bulk(460)),NOW+2*MIN);
 const view=rosterView(roster);
 assert.equal(view.summary.status,'ok');
 assert.equal(view.provider.knownCount,461);
 const changes=JSON.parse(rows(s).roster).providers.openai.changes;
 assert.equal(changes.length,60,'the deferred update publishes once, not once per attempt');
 assert.equal(new Set(changes.map(c=>c.model)).size,60);
 assert.ok(changes.every(c=>c.change==='added'));
 // 쓰기가 실패했다고 기존 모델의 신원이 새로 시작되거나 제거로 오해되지 않는다.
 assert.equal(view.provider.models.find(m=>m.model==='bulk-model-00000').firstSeenAt,first);
 assert.equal(view.provider.changes.filter(c=>c.change==='removed').length,0);
});

// 롤백과 완료를 한 fixture 에 이어 붙이면 대조가 성립하지 않는다. 롤백 뒤 record 를 한 번 하면
// lastObservedAt 이 LATER 로 다시 찍혀, 그 뒤의 성공한 maintain 으로도 그 모델은 잊히지 않는다.
// 그래서 같은 방식으로 씨를 뿌린 fixture 두 개로 가른다.
const seedMaintenance=async t=>{
 const fx=await fixture(t),s=fx.store;
 const roster=createModelRoster({store:s,now:()=>NOW});
 await seedAll(fx,roster,['glm-5.3'],[{...usage('legacy',NOW-TEN),model:'legacy-only'}]);
 assert.equal(rosterView(roster).provider.models.find(m=>m.model==='legacy-only').state,'observed-only');
 // 경계를 만들기 위해서가 아니라(ingest 가 이미 만든다) 롤백 전후로 비교할 lastMaintenanceAt 을
 // 남기기 위해서다.
 s.maintain(NOW);
 return {s,roster};
};
const LATER=NOW+91*DAY;

test('중단된 유지보수는 네 대상을 되돌리고, 완료된 같은 유지보수는 되돌리지 않는다',async t=>{
 const {s,roster}=await seedMaintenance(t);
 const before=rows(s),boundary=s.get('usageExcludedBefore');
 s.db.exec("CREATE TRIGGER reject_jun53 BEFORE DELETE ON samples BEGIN SELECT RAISE(ABORT,'test interruption'); END");
 assert.throws(()=>s.maintain(LATER),/test interruption/);
 assert.equal(s.get('lastMaintenanceAt'),NOW,'the completion stamp did not move');
 assert.equal(s.get('usageExcludedBefore'),boundary,'the forgetting boundary did not move');
 assert.deepEqual(rows(s),before,'all four targets rolled back together');
 roster.record(listedAs(['glm-5.3']),LATER);
 assert.ok(rosterView(roster).provider.models.some(m=>m.model==='legacy-only'),
  'a rolled back boundary forgets nothing');
});

test('완료된 유지보수는 같은 모델을 실제로 잊는다 (앞 테스트의 음성 대조)',async t=>{
 const {s,roster}=await seedMaintenance(t);
 s.maintain(LATER);
 assert.equal(s.get('lastMaintenanceAt'),LATER);
 roster.record(listedAs(['glm-5.3']),LATER);
 assert.equal(rosterView(roster).provider.models.some(m=>m.model==='legacy-only'),false,
  'the same operation, allowed to finish, does forget it');
});

test('로그가 회전해도 네 보존 대상은 남고 관측 구간만 다시 시작한다',async t=>{
 const fx=await fixture(t),s=fx.store;
 const roster=createModelRoster({store:s,now:()=>NOW});
 const file=await seedAll(fx,roster,['glm-5.3']);
 const before=rows(s),since=s.get('usageObservedSince');
 // 새 파일은 inode 가 다르므로 그것만으로도 연속성이 끊긴다. 첫 줄을 다르게 두는 것은 확실성을 위한 것이다.
 await rename(file,file+'.1');
 await writeFile(file,JSON.stringify(usage('after-rotation',NOW))+'\n');
 await s.ingest(file,{labels:new Map()},priced,NOW+MIN);
 const after=rows(s);
 for(const key of ['samples','observations','evidence']) assert.deepEqual(after[key],before[key],key);
 assert.equal(after.roster,before.roster,'the model roster is untouched by a rotation');
 assert.deepEqual(after.usage.filter(row=>before.usage.some(kept=>kept.id===row.id)),before.usage);
 assert.equal(after.usage.length,before.usage.length+1,'only the new line was added');
 assert.equal(after.prices.length,before.prices.length+1);
 assert.notEqual(s.get('usageObservedSince'),since,'a rotation restarts the observation run');
});
