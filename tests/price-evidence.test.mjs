import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPricingCatalog} from '../src/pricing-catalog.mjs';
import {openHistory} from '../src/history.mjs';

const NOW = Date.parse('2026-09-15T12:30:00Z');
const ids = {labels:new Map()};
const call = (requestId,model='future-model',extra={}) => ({requestId,provider:'opencode-go',model,
 timestamp:NOW,usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100},...extra});
const catalogOf = models => JSON.stringify({'opencode-go':{models}});
const rate = input => ({cost:{input,output:4,cache_read:.5}});
// One attempt per entry, so the stored identity is the request id at index zero.
const rowId = requestId => createHash('sha256').update(requestId+'\0'+0).digest('hex');
const recordFor = (s,requestId) => s.db.prepare(
 'SELECT e.* FROM usage_prices p JOIN price_evidence e ON e.id=p.evidence WHERE p.id=?').get(rowId(requestId)) ?? null;
const amountOf = (s,requestId) => s.db.prepare('SELECT usd FROM usage WHERE id=?').get(rowId(requestId))?.usd;
const count = (s,table) => s.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

async function fixture(t,options) {
 const dir = await mkdtemp(join(tmpdir(),'quota-price-evidence-'));
 const file = join(dir,'models.json'), log = join(dir,'usage.jsonl'), state = join(dir,'state');
 const catalog = await createPricingCatalog({file,now:()=>NOW});
 const store = await openHistory(state,options);
 t.after(async()=>{try{store.close();}catch{} await rm(dir,{recursive:true,force:true});});
 return {dir,file,log,state,catalog,store};
}

// The schema as it stood before price evidence existed, written directly so the test reads
// a database this release has never touched rather than one it created and then emptied.
const LEGACY_SCHEMA = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, at INTEGER NOT NULL, provider TEXT NOT NULL,
   account TEXT, model TEXT, input REAL, output REAL, cached REAL, tokens REAL, usd REAL, basis TEXT);
 CREATE INDEX IF NOT EXISTS usage_time ON usage(at,provider,account);
 CREATE TABLE IF NOT EXISTS samples (provider TEXT, account TEXT, window TEXT, at INTEGER,
   reset INTEGER, used REAL, PRIMARY KEY(provider,account,window,at));
 CREATE INDEX IF NOT EXISTS samples_time ON samples(at);
 CREATE TABLE IF NOT EXISTS usage_timings (id TEXT PRIMARY KEY, durationMs REAL, firstOutputMs REAL, tokensReported INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS cursor_cache_costs (id TEXT PRIMARY KEY, noCacheUsd REAL NOT NULL, fullCacheUsd REAL NOT NULL, eligibleInputTokens REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS claude_cache_costs (id TEXT PRIMARY KEY, fiveMinuteUsd REAL NOT NULL, oneHourUsd REAL NOT NULL, cacheWriteTokens REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS identity_epochs (provider TEXT NOT NULL, account TEXT NOT NULL,
   epoch INTEGER NOT NULL, basis TEXT NOT NULL, physicalDigest TEXT,
   startedAt INTEGER NOT NULL, endedAt INTEGER, reason TEXT NOT NULL, PRIMARY KEY(provider,account,epoch));
 CREATE INDEX IF NOT EXISTS identity_epochs_open ON identity_epochs(provider,account,endedAt);`;

async function legacyDatabase(t,{pages=0}={}) {
 const dir = await mkdtemp(join(tmpdir(),'quota-legacy-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const db = new DatabaseSync(join(dir,'history.sqlite'));
 db.exec(LEGACY_SCHEMA);
 db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)')
   .run(rowId('settled-before-evidence'),NOW,'opencode-go','a','future-model',1000,100,0,1100,.0024,'local-catalog');
 db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('historyStartedAt',JSON.stringify(NOW-1000));
 if (pages) {
  db.exec('CREATE TABLE ballast (payload BLOB)');
  const fill = db.prepare('INSERT INTO ballast VALUES (zeroblob(4000))');
  while (db.prepare('PRAGMA page_count').get().page_count < pages) fill.run();
 }
 const pageSize = db.prepare('PRAGMA page_size').get().page_size;
 const pageCount = db.prepare('PRAGMA page_count').get().page_count;
 db.close();
 return {dir,pageSize,pageCount};
}

test('a tariff change gives later calls their own price record and leaves settled amounts alone',async t=>{
 const {file,log,catalog:c,store:s} = await fixture(t);
 await writeFile(file,catalogOf({'future-model':rate(2)}));await c.refresh();
 await writeFile(log,JSON.stringify(call('before'))+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW);
 const first = recordFor(s,'before');
 assert.equal(JSON.parse(first.rates).input,2);
 assert.equal(first.status,'local-catalog');
 const settled = amountOf(s,'before');
 assert.equal(settled,.0024);
 // The published price moves. A call made after it is valued and explained by the new one.
 await writeFile(file,catalogOf({'future-model':rate(10)}));await c.refresh();
 await appendFile(log,JSON.stringify(call('after'))+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW+1000);
 const second = recordFor(s,'after');
 assert.equal(JSON.parse(second.rates).input,10);
 assert.notEqual(second.id,first.id);
 // Following each request to its own record is the assertion. Counting records alone would
 // pass on two records that no usage row points at.
 assert.equal(amountOf(s,'before'),settled);
 assert.deepEqual(recordFor(s,'before'),first);
 assert.equal(amountOf(s,'after'),.0104);
});

test('a catalog rewrite that leaves a price alone reuses its record',async t=>{
 const {file,log,catalog:c,store:s} = await fixture(t);
 await writeFile(file,catalogOf({'future-model':rate(2),other:rate(3)}));await c.refresh();
 await writeFile(log,JSON.stringify(call('one'))+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW);
 const revision = c.priceUsage.revision;
 // Another model's price moves, so the catalog revision moves with it.
 await writeFile(file,catalogOf({'future-model':rate(2),other:rate(9)}));await c.refresh();
 assert.notEqual(c.priceUsage.revision,revision);
 await appendFile(log,JSON.stringify(call('two'))+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW+1000);
 // A record is identified by what it says. An unchanged price is not a second record.
 assert.equal(recordFor(s,'two').id,recordFor(s,'one').id);
 assert.equal(count(s,'price_evidence'),1);
 assert.equal(recordFor(s,'two').firstRevision,recordFor(s,'one').firstRevision);
});

test('a record appears only with the write that settles the amount',async t=>{
 const {file,log,catalog:c,store:s} = await fixture(t);
 await c.refresh();
 await writeFile(log,JSON.stringify(call('pending'))+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW);
 assert.equal(amountOf(s,'pending'),null);
 assert.equal(count(s,'usage_prices'),0);
 assert.equal(count(s,'price_evidence'),0);
 // The price arrives later. Filling the amount is what attaches the record.
 await writeFile(file,catalogOf({'future-model':rate(2)}));await c.refresh();
 await s.ingest(log,ids,c.priceUsage,NOW+1000);
 assert.equal(amountOf(s,'pending'),.0024);
 assert.equal(recordFor(s,'pending').status,'local-catalog');
 assert.equal(count(s,'usage_prices'),1);
});

test('rows priced before evidence existed stay unrecorded rather than borrowing a current price',async t=>{
 const {file,log,catalog:c,store:s} = await fixture(t);
 // A row exactly as an earlier release stored it: an amount, and nothing that explains it.
 s.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  .run(rowId('settled-before-evidence'),NOW,'opencode-go',null,'future-model',1000,100,0,1100,.0024,'local-catalog');
 await writeFile(file,catalogOf({'future-model':rate(2)}));await c.refresh();
 await writeFile(log,JSON.stringify(call('settled-before-evidence'))+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW);
 assert.equal(count(s,'usage_prices'),0);
 assert.equal(recordFor(s,'settled-before-evidence'),null);
 const [row] = s.priceEvidence('opencode-go',0,NOW+1);
 assert.equal(row.evidence,null);
 assert.equal(row.requests,1);
 assert.equal(row.model,'future-model');
});

test('a model the catalog no longer carries keeps the price that valued its calls',async t=>{
 const {file,log,catalog:c,store:s} = await fixture(t);
 await writeFile(file,catalogOf({'future-model':rate(2)}));await c.refresh();
 await writeFile(log,JSON.stringify(call('while-listed'))+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW);
 // The model leaves the catalog entirely.
 await writeFile(file,catalogOf({other:rate(3)}));await c.refresh();
 await s.ingest(log,ids,c.priceUsage,NOW+1000);
 assert.equal(c.lookupModelPrice('opencode-go','future-model',{timestamp:NOW}).status,'unpriced');
 const [row] = s.priceEvidence('opencode-go',0,NOW+1);
 assert.equal(row.model,'future-model');
 assert.equal(row.evidence.rates.input,2);
 assert.equal(row.evidence.status,'local-catalog');
 assert.equal(row.storedApiUsd,.0024);
 assert.equal(row.requests,1);
});

test('a provider-published rate is recorded with its own evidence grade and survives a revision',async t=>{
 const {file,log,catalog:c,store:s} = await fixture(t);
 await writeFile(file,catalogOf({'future-model':rate(2)}));await c.refresh();
 const devin = {requestId:'devin-call',provider:'devin',model:'gpt-6-astra',timestamp:NOW,
  usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}};
 await writeFile(log,JSON.stringify(devin)+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW);
 const record = recordFor(s,'devin-call');
 assert.equal(record.status,'ocx-provided');
 assert.equal(record.sourceUrl,'https://docs.devin.ai/desktop/models');
 assert.deepEqual(JSON.parse(record.conditions),['list-price-reference']);
 assert.equal(JSON.parse(record.rates).input,10);
 const settled = amountOf(s,'devin-call');
 await writeFile(file,catalogOf({'future-model':rate(10)}));await c.refresh();
 await s.ingest(log,ids,c.priceUsage,NOW+1000);
 assert.equal(amountOf(s,'devin-call'),settled);
 assert.deepEqual(recordFor(s,'devin-call'),record);
});

test('the recorded rates reproduce the amount that was stored',async t=>{
 const {log,catalog:c,store:s} = await fixture(t);
 await c.refresh();
 const openai = (requestId,extra={}) => ({requestId,provider:'openai',model:'gpt-5.6-terra',timestamp:NOW,
  usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100},...extra});
 await writeFile(log,[openai('plain'),
  openai('fast',{responseServiceTier:'priority'}),
  // The tier that was actually applied wins over the one that was asked for, and the
  // record has to follow the same precedence. Reading only the requested field here
  // would quote the discount rate for a call billed at double.
  openai('settled-tier',{tierOutcome:{responseServiceTier:'priority'},responseServiceTier:'flex'}),
  {...openai('long'),usage:{inputTokens:300000,outputTokens:100}}].map(JSON.stringify).join('\n')+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW);
 const recomputed = (requestId,input,output,cached=0) => {
  const record = recordFor(s,requestId);
  const rates = JSON.parse(record.rates);
  return {record,usd:((input-cached)*rates.input+output*rates.output+cached*rates.cacheRead)/1e6*record.tierMultiplier};
 };
 for (const [requestId,input,output] of [['plain',1000,100],['fast',1000,100],
   ['settled-tier',1000,100],['long',300000,100]]) {
  const {usd} = recomputed(requestId,input,output);
  assert.ok(Math.abs(usd-amountOf(s,requestId))<=1e-9*Math.max(1,usd),requestId+' recomputes to '+usd);
 }
 // The service tier and the long-input threshold are part of the price, so they are part
 // of the record. Recording the plain rate for all three would still pass a source check.
 assert.equal(recordFor(s,'fast').tierMultiplier,2);
 assert.equal(recordFor(s,'settled-tier').tierMultiplier,2);
 assert.equal(amountOf(s,'settled-tier'),.0064);
 assert.equal(JSON.parse(recordFor(s,'long').rates).input,4);
 const distinct = new Set(['plain','fast','long'].map(id=>recordFor(s,id).id));
 assert.equal(distinct.size,3);
});

test('stored amounts and the valued view are reported as the different numbers they are',async t=>{
 const {log,catalog:c,store:s} = await fixture(t);
 await c.refresh();
 await writeFile(log,JSON.stringify({requestId:'blend',provider:'cursor',model:'gpt-5.6-terra',
  timestamp:NOW,usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}})+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW);
 const stored = amountOf(s,'blend');
 assert.equal(stored,.0032);
 // Half the eligible input assumed cached: the view reprices on read, the record does not.
 s.set('cursorCacheReference',{appliedRate:.5});
 const [row] = s.priceEvidence('cursor',0,NOW+1);
 assert.equal(row.storedApiUsd,stored);
 const valued = s.stats('cursor',undefined,0,NOW+1).apiUsd;
 assert.notEqual(valued,stored);
 assert.equal(valued,.0023);
 assert.equal(row.evidence.rates.input,2);
});


test('an interrupted replay keeps what it committed, and the retry adds no duplicate row or record',async t=>{
 const {file,log,state,catalog:c,store:s} = await fixture(t);
 await writeFile(file,catalogOf({'future-model':rate(2),'other-model':rate(3)}));await c.refresh();
 // Longer than one read batch, so the first batch is committed before the second one fails.
 const pad = 'x'.repeat(300);
 const rows = Array.from({length:5000},(unused,i)=>
  JSON.stringify(call('r'+i, i===4999?'other-model':'future-model', {pad})));
 await writeFile(log,rows.join('\n')+'\n');
 const failing = Object.assign(row=>{if(row.model==='other-model')throw new Error('interrupted');
  return c.priceUsage(row);},{revision:c.priceUsage.revision});
 await assert.rejects(s.ingest(log,ids,failing,NOW),/interrupted/);
 assert.equal(s.db.isTransaction,false);
 const committed = count(s,'usage');
 assert.ok(committed>0 && committed<5000,'one batch committed, the next rolled back: '+committed);
 assert.equal(count(s,'usage_prices'),committed);
 // The retry finishes the file. Counting rows alone would pass on a link pointing at the
 // wrong record, so the recorded rates are read back per request as well.
 await s.ingest(log,ids,c.priceUsage,NOW+1000);
 await s.ingest(log,ids,c.priceUsage,NOW+2000);
 await s.ingest(log,ids,c.priceUsage,NOW+3000);
 assert.equal(count(s,'usage'),5000);
 assert.equal(count(s,'usage_prices'),5000);
 assert.equal(count(s,'price_evidence'),2);
 assert.equal(JSON.parse(recordFor(s,'r0').rates).input,2);
 assert.equal(JSON.parse(recordFor(s,'r4999').rates).input,3);
 assert.equal(s.get('invalidUsageLines'),0);
 s.close();
 const reopened = await openHistory(state);
 t.after(()=>reopened.close());
 assert.equal(count(reopened,'usage'),5000);
 assert.equal(count(reopened,'usage_prices'),5000);
});

test('a failed price-record write takes the amount back with it and the retry stores both',async t=>{
 for (const table of ['price_evidence','usage_prices']) {
  const {file,log,catalog:c,store:s} = await fixture(t);
  await writeFile(file,catalogOf({'future-model':rate(2)}));await c.refresh();
  await writeFile(log,JSON.stringify(call('one'))+'\n');
  s.db.exec(`CREATE TRIGGER reject BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'storage interrupted'); END`);
  await assert.rejects(s.ingest(log,ids,c.priceUsage,NOW),/storage interrupted/,table);
  assert.equal(s.db.isTransaction,false,table);
  // An amount we could not explain is not kept: the row goes back with its record.
  assert.equal(count(s,'usage'),0,table);
  assert.equal(count(s,'usage_prices'),0,table);
  assert.equal(count(s,'price_evidence'),0,table);
  assert.equal(s.get('usageReadAt'),null,table);
  s.db.exec('DROP TRIGGER reject');
  await s.ingest(log,ids,c.priceUsage,NOW+1000);
  assert.equal(count(s,'usage'),1,table);
  assert.equal(amountOf(s,'one'),.0024,table);
  assert.equal(JSON.parse(recordFor(s,'one').rates).input,2,table);
 }
});

test('a repricing replay does not restart the observation run, across a close and reopen',async t=>{
 const {file,log,state,catalog:c,store:s} = await fixture(t);
 await writeFile(file,catalogOf({'future-model':rate(2)}));await c.refresh();
 await writeFile(log,JSON.stringify(call('first'))+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW);
 const since = s.get('usageObservedSince');
 assert.equal(since,NOW);
 const before = s.get('pricingRevision');
 // A real catalog change, so a real replay: the cursor rewinds and the file is read again.
 // Deleting a replay flag would exercise the same branch without proving the same thing.
 await writeFile(file,catalogOf({'future-model':rate(10)}));await c.refresh();
 await s.ingest(log,ids,c.priceUsage,NOW+60000);
 assert.notEqual(s.get('pricingRevision'),before);
 assert.equal(s.get('usageObservedSince'),since);
 await writeFile(file,catalogOf({'future-model':rate(12)}));await c.refresh();
 await appendFile(log,JSON.stringify(call('second'))+'\n');
 await s.ingest(log,ids,c.priceUsage,NOW+120000);
 assert.equal(s.get('usageObservedSince'),since);
 // The run has to survive the process, not only the open handle.
 s.close();
 const reopened = await openHistory(state);
 t.after(()=>reopened.close());
 assert.equal(reopened.get('usageObservedSince'),since);
 assert.equal(reopened.get('usageObservedThrough'),NOW+120000);
});

test('a database from before this change opens without loss, and a failed schema add leaves it readable',async t=>{
 const {dir,pageSize,pageCount} = await legacyDatabase(t,{pages:300});
 // Exactly at the page cap: the size guard lets it open, and then there is no page left
 // for the new tables. This is the migration failing, not the file being rejected.
 await assert.rejects(openHistory(dir,{maxBytes:pageCount*pageSize}),/full/i);
 const raw = new DatabaseSync(join(dir,'history.sqlite'));
 assert.equal(raw.prepare('SELECT count(*) n FROM usage').get().n,1);
 assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='price_evidence'").get().n,0);
 assert.equal(raw.prepare('SELECT usd FROM usage').get().usd,.0024);
 raw.close();
 // Room to grow, and the same file opens with the new tables beside the old rows.
 const store = await openHistory(dir,{maxBytes:(pageCount+2000)*pageSize});
 t.after(()=>store.close());
 assert.equal(count(store,'usage'),1);
 assert.equal(count(store,'price_evidence'),0);
 assert.equal(count(store,'usage_prices'),0);
 assert.equal(store.get('historyStartedAt'),NOW-1000);
 // The row it already held keeps its amount and stays unexplained, rather than being
 // handed whatever the model costs today.
 const [row] = store.priceEvidence('opencode-go',0,NOW+1);
 assert.equal(row.evidence,null);
 assert.equal(row.storedApiUsd,.0024);
});

test('a price record id does not outlive the batch that read it',async t=>{
 const {file,log,state,catalog:c,store:s} = await fixture(t);
 await writeFile(file,catalogOf({'future-model':rate(2)}));await c.refresh();
 const pad='x'.repeat(300);
 await writeFile(log,Array.from({length:5000},(unused,i)=>
  JSON.stringify(call('r'+i,'future-model',{pad}))).join('\n')+'\n');
 // Retention runs on another connection while ingestion is between batches, and takes the
 // record the first batch wrote. A cache that outlived its batch would hand the next one an
 // id that is gone -- or, once the integer key is reassigned, one belonging to another price.
 // The sweep is scheduled from the first priced row, so it lands on ingest's own yield.
 const other=new DatabaseSync(join(state,'history.sqlite'));
 t.after(()=>{try{other.close();}catch{}});
 let scheduled=false,swept=0;
 const sweeping=Object.assign(row=>{
  if(!scheduled){scheduled=true;setImmediate(()=>{swept=other.prepare('DELETE FROM price_evidence').run().changes;});}
  return c.priceUsage(row);
 },{revision:c.priceUsage.revision});
 await s.ingest(log,ids,sweeping,NOW);
 assert.equal(swept,1,'the sweep removed the record the first batch wrote');
 assert.equal(count(s,'usage'),5000);
 const dangling=s.db.prepare(`SELECT count(*) n FROM usage_prices p
   WHERE NOT EXISTS (SELECT 1 FROM price_evidence e WHERE e.id=p.evidence)`).get().n;
 assert.equal(dangling,0,'every link still resolves to a record');
 for (const row of s.priceEvidence('opencode-go',0,NOW+1))
  assert.notEqual(row.evidence,null,row.model+' keeps a readable record');
});

test('a dated tariff keeps the window and check date that applied when the call was made',async t=>{
 const at = Date.parse('2027-01-01T02:00:00Z');
 const dir = await mkdtemp(join(tmpdir(),'quota-dated-'));
 const file = join(dir,'models.json'), log = join(dir,'usage.jsonl');
 await writeFile(file,'{}');
 const c = await createPricingCatalog({file,now:()=>at});
 await c.refresh();
 const store = await openHistory(join(dir,'state'));
 t.after(async()=>{try{store.close();}catch{} await rm(dir,{recursive:true,force:true});});
 // Devin publishes this model as a dated pair. One call falls inside the promotion and one
 // after it, so the boundary, the check date and the rate have to travel with the row.
 const devin=(requestId,when)=>JSON.stringify({requestId,provider:'devin',model:'gemini-3-8-flash',
  timestamp:Date.parse(when),usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}});
 await writeFile(log,[devin('promo','2026-12-31T23:00:00Z'),devin('regular','2027-01-01T01:00:00Z')].join('\n')+'\n');
 await store.ingest(log,ids,c.priceUsage,at);
 const byRates = Object.fromEntries(store.priceEvidence('devin',0,at).map(row=>[row.evidence.rates.input,row.evidence]));
 const promotional = byRates[0.75], regular = byRates[1.5];
 assert.ok(promotional && regular,'both tariffs recorded');
 assert.equal(promotional.effectiveTo,'2027-01-01T00:00:00.000Z');
 assert.equal(promotional.effectiveFrom,null);
 assert.ok(promotional.conditions.includes('promotional'));
 assert.equal(regular.effectiveFrom,'2027-01-01T00:00:00.000Z');
 assert.equal(regular.effectiveTo,null);
 assert.equal(regular.conditions.includes('promotional'),false);
 for (const record of [promotional,regular]) {
  assert.equal(record.checkedAt,'2026-09-17');
  assert.equal(record.sourceUrl,'https://docs.devin.ai/desktop/models');
  assert.equal(record.status,'official');
 }
 assert.equal(amountOf(store,'promo'),.001125);
 assert.equal(amountOf(store,'regular'),.00225);
 // Reopening reads the same dates back: they are stored, not recomputed from today.
 store.close();
 const reopened = await openHistory(join(dir,'state'));
 t.after(()=>reopened.close());
 const again = Object.fromEntries(reopened.priceEvidence('devin',0,at).map(row=>[row.evidence.rates.input,row.evidence]));
 assert.equal(again[0.75].effectiveTo,'2027-01-01T00:00:00.000Z');
 assert.equal(again[1.5].effectiveFrom,'2027-01-01T00:00:00.000Z');
 assert.equal(again[0.75].checkedAt,'2026-09-17');
});

