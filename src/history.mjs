import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { attributeUsage } from './identity.mjs';
import { MEASURED_AT, IDENTITY_EPOCH, HISTORY_READING } from './time.mjs';
import { observationOf, shouldStore } from './quota-observations.mjs';
const BATCH_BYTES = 1024 * 1024;
const DAY = 86400000;
// While a quota reading is unchanged, keep one sample every four minutes instead of
// every collection. That stays well inside the twenty-minute gap threshold, so idle
// time still reads as observed rather than as a collection gap, while a month of
// history stops costing a quarter million rows per window.
const IDLE_SAMPLE_MS = 4 * 60000;
const num = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
const totalTokens = (usage, row) => num(usage.totalTokens ?? row.totalTokens ?? (num(usage.inputTokens) + num(usage.outputTokens)));
const cachedTokens = usage => num(usage.cacheReadInputTokens ?? usage.cachedInputTokens);
const modelName = row => typeof row.model === 'string' ? row.model.slice(0, 200) : null;
const rateTuple = r => [r.input ?? null, r.output ?? null, r.cacheRead ?? null, r.cacheWrite ?? null];
const sorted = list => [...list].sort();
// A price record is identified by what it says, not by the catalog revision that produced
// it. The revision changes every time the models.dev cache is rewritten, so folding it in
// would split one unchanged price into a fresh record every day. The revision that first
// produced this content is kept on the row instead. Fixed positions rather than the quote
// object, because object key order is not a stable string.
const evidenceDigest = e => createHash('sha256').update(JSON.stringify([e.provider, e.model, e.status,
  e.sourceUrl, e.checkedAt, e.effectiveFrom, e.effectiveTo, rateTuple(e.rates), e.tierMultiplier,
  sorted(e.conditions), sorted(e.unsupported),
  e.conflict === null ? null : [e.conflict.status, rateTuple(e.conflict.rates), e.conflict.reason],
  e.reason])).digest('hex');
// A record we can no longer read is reported as absent rather than thrown: one unreadable
// row must not take every other model's evidence out of the response with it.
const parsed = text => { try { return JSON.parse(text); } catch { return null; } };

export async function openHistory(directory, { retentionDays = 90, maxBytes = 512 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 31 || retentionDays > 3650 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 * 1024) throw new Error('Invalid history storage limits');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'history.sqlite');
  const db = new DatabaseSync(file); await chmod(file, 0o600);
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  const maxPages = Math.floor(maxBytes / pageSize);
  if (db.prepare('PRAGMA page_count').get().page_count > maxPages) {
    db.close(); throw new Error('Existing history exceeds the configured limit; preserve or archive it before lowering the limit');
  }
  db.exec(`PRAGMA max_page_count=${maxPages}; PRAGMA journal_size_limit=16777216; PRAGMA wal_autocheckpoint=1000;`);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, at INTEGER NOT NULL, provider TEXT NOT NULL,
      account TEXT, model TEXT, input REAL, output REAL, cached REAL, tokens REAL, usd REAL, basis TEXT);
    CREATE INDEX IF NOT EXISTS usage_time ON usage(at,provider,account);
    CREATE TABLE IF NOT EXISTS samples (provider TEXT, account TEXT, window TEXT, at INTEGER,
      reset INTEGER, used REAL, PRIMARY KEY(provider,account,window,at));
    CREATE INDEX IF NOT EXISTS samples_time ON samples(at);
    -- What a stored percentage was actually based on. samples holds the number; this holds the
    -- evidence for it, so a later reader can tell whether two readings are two points on one
    -- measurement or two different measurements that happen to share a unit.
    --
    -- The key is seq, the insertion order, rather than the instant. Two things depend on that.
    -- A provider can hand us an observation time earlier than the one before it, and ordering
    -- rows by that instant would sort the reversal away before anything could notice it. Two
    -- readings can also share an instant while disagreeing about the basis, and a timestamp key
    -- would silently drop the second. seq is the order of the rows still here, not a permanent
    -- number: SQLite reuses the largest rowid once it is deleted, and a reused one still sorts
    -- after everything that remains, which is all this is used for.
    CREATE TABLE IF NOT EXISTS quota_observations (seq INTEGER PRIMARY KEY,
      provider TEXT NOT NULL, account TEXT NOT NULL, window TEXT NOT NULL, at INTEGER NOT NULL,
      epoch INTEGER, basis TEXT NOT NULL,
      reportedPercent REAL, calculatedPercent REAL, observedPercent REAL NOT NULL,
      used REAL, limitValue REAL, limitState TEXT NOT NULL, unit TEXT,
      method TEXT, windowSemantics TEXT NOT NULL, scopeKey TEXT, cycleKey TEXT, reset INTEGER,
      source TEXT, sourceVersion TEXT, precisionEvidence TEXT NOT NULL, resolutionPp REAL,
      reconciliation TEXT NOT NULL, usedAccumulation TEXT NOT NULL, pairsSample INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS quota_observations_window ON quota_observations(provider,account,window,seq);
    CREATE INDEX IF NOT EXISTS quota_observations_time ON quota_observations(at);
    CREATE TABLE IF NOT EXISTS usage_timings (id TEXT PRIMARY KEY, durationMs REAL, firstOutputMs REAL, tokensReported INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cursor_cache_costs (id TEXT PRIMARY KEY, noCacheUsd REAL NOT NULL, fullCacheUsd REAL NOT NULL, eligibleInputTokens REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS claude_cache_costs (id TEXT PRIMARY KEY, fiveMinuteUsd REAL NOT NULL, oneHourUsd REAL NOT NULL, cacheWriteTokens REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_epochs (provider TEXT NOT NULL, account TEXT NOT NULL,
      epoch INTEGER NOT NULL, basis TEXT NOT NULL, physicalDigest TEXT,
      startedAt INTEGER NOT NULL, endedAt INTEGER, reason TEXT NOT NULL,
      PRIMARY KEY(provider,account,epoch));
    CREATE INDEX IF NOT EXISTS identity_epochs_open ON identity_epochs(provider,account,endedAt);
    CREATE TABLE IF NOT EXISTS price_evidence (id INTEGER PRIMARY KEY, digest TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, sourceUrl TEXT, checkedAt TEXT,
      effectiveFrom TEXT, effectiveTo TEXT, rates TEXT NOT NULL, tierMultiplier REAL,
      conditions TEXT NOT NULL, unsupported TEXT NOT NULL, conflict TEXT, reason TEXT,
      firstRevision TEXT NOT NULL, firstSeenAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_prices (id TEXT PRIMARY KEY, evidence INTEGER NOT NULL,
      pricedAt INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TEMP VIEW usage_valued AS
      WITH assumption AS (SELECT CASE WHEN json_type(value,'$.appliedRate') IN ('real','integer')
        AND json_extract(value,'$.appliedRate') BETWEEN 0 AND 1 THEN json_extract(value,'$.appliedRate') END rate
        FROM meta WHERE key='cursorCacheReference'),
      claude AS (SELECT CASE WHEN json_extract(value,'$.ttl')='1h'
        AND json_type(value,'$.from') IN ('real','integer') THEN json_extract(value,'$.from') END fromTs
        FROM meta WHERE key='claudeCacheAssumption')
      SELECT u.id,u.at,u.provider,u.account,u.model,u.input,u.output,u.cached,u.tokens,
        CASE WHEN c.id IS NOT NULL AND a.rate IS NOT NULL THEN c.noCacheUsd*(1-a.rate)+c.fullCacheUsd*a.rate
             WHEN cc.id IS NOT NULL AND cl.fromTs IS NOT NULL AND u.at>=cl.fromTs THEN cc.oneHourUsd
             ELSE u.usd END usd,
        CASE WHEN c.id IS NOT NULL AND a.rate IS NOT NULL THEN 'local-catalog'
             WHEN cc.id IS NOT NULL AND cl.fromTs IS NOT NULL AND u.at>=cl.fromTs THEN 'local-catalog'
             ELSE u.basis END basis,
        CASE WHEN c.id IS NOT NULL AND a.rate IS NOT NULL THEN 1 ELSE 0 END cacheEstimated,
        CASE WHEN c.id IS NOT NULL AND a.rate IS NOT NULL THEN c.eligibleInputTokens*a.rate ELSE 0 END estimatedCachedTokens,
        CASE WHEN c.id IS NOT NULL AND a.rate IS NOT NULL THEN c.noCacheUsd
             WHEN cc.id IS NOT NULL AND cl.fromTs IS NOT NULL AND u.at>=cl.fromTs THEN cc.oneHourUsd
             ELSE u.usd END noCacheUsd
      FROM usage u LEFT JOIN cursor_cache_costs c ON c.id=u.id AND u.provider='cursor'
      LEFT JOIN claude_cache_costs cc ON cc.id=u.id AND u.provider='anthropic'
      LEFT JOIN assumption a ON 1=1 LEFT JOIN claude cl ON 1=1;`);
  const get = key => { const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const set = (key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value));
  // A monotonic count of the transactions that changed usage rows, advanced inside the same
  // transaction as the rows themselves so it can never lag them or repeat a value they have
  // already passed. Every caller that caches a query over these rows keys on it.
  const bumpUsageRevision = () => set('usageDataRevision', (get('usageDataRevision') ?? 0) + 1);
  // Every write path commits or leaves the database untouched; a partial batch
  // would desynchronize the import cursor from the rows it claims to cover.
  const transact = run => {
    db.exec('BEGIN');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  const insert = db.prepare(`INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET usd=excluded.usd,basis=excluded.basis
    WHERE usage.usd IS NULL AND excluded.usd IS NOT NULL
    AND usage.provider=excluded.provider AND usage.model IS excluded.model AND usage.at=excluded.at
    AND usage.input=excluded.input AND usage.output=excluded.output AND usage.cached=excluded.cached AND usage.tokens=excluded.tokens`);
  const timing = db.prepare('INSERT OR IGNORE INTO usage_timings VALUES (?,?,?,?)');
  const cacheCost = db.prepare(`INSERT OR IGNORE INTO cursor_cache_costs
    SELECT id,?,?,? FROM usage WHERE id=? AND provider='cursor' AND model IS ? AND at=?
      AND input=? AND output=? AND cached=? AND tokens=?`);
  // The sidecar only attaches to the stored row it was priced from: same identity,
  // shape and the original 5m amount (a tiny float tolerance covers repricing noise).
  const claudeCacheCost = db.prepare(`INSERT OR IGNORE INTO claude_cache_costs
    SELECT id,?,?,? FROM usage WHERE id=? AND provider='anthropic' AND model IS ? AND at=?
      AND input=? AND output=? AND cached=? AND tokens=?
      AND usd IS NOT NULL AND abs(usd-?)<=1e-9*max(abs(usd),abs(?),1)`);
  const insertEvidence = db.prepare(`INSERT OR IGNORE INTO price_evidence
    (digest,provider,model,status,sourceUrl,checkedAt,effectiveFrom,effectiveTo,rates,tierMultiplier,
     conditions,unsupported,conflict,reason,firstRevision,firstSeenAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const evidenceKey = db.prepare('SELECT id FROM price_evidence WHERE digest=?');
  // Like the cache sidecars, the link attaches only to the stored row the price was computed
  // from: same identity, same shape, same amount. Unlike them it is never updated, so a later
  // tariff cannot restate what an already settled amount was calculated from.
  const linkPrice = db.prepare(`INSERT OR IGNORE INTO usage_prices(id,evidence,pricedAt)
    SELECT id,?,? FROM usage WHERE id=? AND provider=? AND model IS ? AND at=?
      AND input=? AND output=? AND cached=? AND tokens=?
      AND usd IS NOT NULL AND abs(usd-?)<=1e-9*max(abs(usd),abs(?),1)`);
  // The cache belongs to one ingest call. Held any longer it would survive a rolled back
  // batch, and since the key is an autoincrementing integer the number it remembers can be
  // handed to different content on the next insert.
  const evidenceRowId = (value, revision, now, cache) => {
    const digest = evidenceDigest(value);
    const known = cache.get(digest);
    if (known !== undefined) return known;
    insertEvidence.run(digest, value.provider, value.model, value.status, value.sourceUrl, value.checkedAt,
      value.effectiveFrom, value.effectiveTo, JSON.stringify(value.rates), value.tierMultiplier,
      JSON.stringify(sorted(value.conditions)), JSON.stringify(sorted(value.unsupported)),
      value.conflict === null ? null : JSON.stringify(value.conflict), value.reason, revision, now);
    const id = evidenceKey.get(digest).id;
    cache.set(digest, id);
    return id;
  };
  const sample = db.prepare('INSERT OR IGNORE INTO samples VALUES (?,?,?,?,?,?)');
  const lastSample = db.prepare('SELECT at,reset,used FROM samples WHERE provider=? AND account=? AND window=? ORDER BY at DESC LIMIT 1');
  const OBSERVATION_COLUMNS = ['provider', 'account', 'window', 'at', 'epoch', 'basis',
    'reportedPercent', 'calculatedPercent', 'observedPercent', 'used', 'limitValue', 'limitState',
    'unit', 'method', 'windowSemantics', 'scopeKey', 'cycleKey', 'reset', 'source', 'sourceVersion',
    'precisionEvidence', 'resolutionPp', 'reconciliation', 'usedAccumulation', 'pairsSample'];
  const insertObservation = db.prepare(`INSERT INTO quota_observations (${OBSERVATION_COLUMNS.join(',')})
    VALUES (${OBSERVATION_COLUMNS.map(() => '?').join(',')})`);
  // Only what decides whether the next reading says anything new. Ordered by seq, not by at,
  // because the newest row is the one written last and not necessarily the one measured last.
  const lastObservation = db.prepare(`SELECT at,basis,reportedPercent,calculatedPercent,observedPercent,
    used,limitValue,reset FROM quota_observations WHERE provider=? AND account=? AND window=?
    ORDER BY seq DESC LIMIT 1`);

  // An identity epoch separates one physical account from the next behind the same public id.
  // Numbers come from a persisted global sequence rather than a per-account maximum: retention
  // deletes closed rows, and a per-account maximum would then hand a replacement account the
  // number its predecessor used, letting a stale observation match again.
  const openEpoch = db.prepare('SELECT epoch,basis,physicalDigest,startedAt,reason FROM identity_epochs WHERE provider=? AND account=? AND endedAt IS NULL');
  const closeEpoch = db.prepare('UPDATE identity_epochs SET endedAt=?,reason=? WHERE provider=? AND account=? AND endedAt IS NULL');
  const insertEpoch = db.prepare('INSERT INTO identity_epochs VALUES (?,?,?,?,?,?,NULL,?)');
  const listEpochs = db.prepare('SELECT epoch,basis,physicalDigest,startedAt,endedAt,reason FROM identity_epochs WHERE provider=? AND account=? ORDER BY epoch');

  // The oldest instant we still hold complete records for. Retention deletes below it
  // and ingestion refuses to import below it, so it only ever moves forward. It marks
  // a conservative completeness boundary, not evidence that rows were deleted.
  const excludeBefore = cutoff => {
    const prior = get('usageExcludedBefore');
    if (!Number.isFinite(prior) || cutoff > prior) set('usageExcludedBefore', cutoff);
  };

  // Start a fresh observation run. The endpoint and any unresolved record belong to the
  // run that saw them, so both are dropped with it rather than inherited.
  const restartObservation = at => {
    set('usageObservedSince', at);
    set('usageObservedThrough', null);
    set('usageTailPending', null);
  };

  // account: undefined reads every account, null only unattributed rows, a string one
  // account. { listed: ids } counts only those accounts and { unlisted: ids } every
  // attributed account outside them, so a provider total splits into three parts that
  // are queried separately rather than derived from one another. An empty listed set
  // matches nothing; an empty unlisted set matches every attributed row.
  const accountFilter = (provider, from, to, account) => {
    const listed = account?.listed, unlisted = account?.unlisted;
    const ids = listed ?? unlisted;
    if (Array.isArray(ids)) {
      const places = ids.map(() => '?').join(',');
      return { args: [provider, from, to, ...ids], clause: listed
        ? (ids.length ? ' AND account IN (' + places + ')' : ' AND 0')
        : ' AND account IS NOT NULL' + (ids.length ? ' AND account NOT IN (' + places + ')' : '') };
    }
    return {
      clause: account === undefined ? '' : account === null ? ' AND account IS NULL' : ' AND account=?',
      args: typeof account === 'string' ? [provider, from, to, account] : [provider, from, to],
    };
  };

  const readFingerprint = async (handle, size) => {
    const prefix = Buffer.alloc(Math.min(64, size));
    await handle.read(prefix, 0, prefix.length, 0);
    return prefix.length === 64 ? createHash('sha256').update(prefix).digest('hex') : null;
  };

  // An append-only log never rewrites bytes it has already written. Hashing a byte
  // range lets a later read prove that what we consumed, and any record we left
  // unresolved, is still the same text. This detects a rewrite; it does not prove
  // the file was never altered between two reads.
  const digestRange = async (handle, from, length) => {
    if (!(length > 0) || from < 0) return null;
    // Hash in fixed-size chunks. An unfinished record can be megabytes long, and one
    // buffer the size of the range would make every poll allocate alongside it.
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(BATCH_BYTES, length));
    for (let read = 0; read < length;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - read), from + read);
      // Nothing more to read before the range ends: these bytes are not all there.
      if (!bytesRead) return null;
      hash.update(buffer.subarray(0, bytesRead));
      read += bytesRead;
    }
    return hash.digest('hex');
  };
  const boundaryOf = (handle, offset) => digestRange(handle, Math.max(0, offset - 64), Math.min(64, offset));

  // A birth timestamp separates a recreated file that reused an inode from the
  // original. Some platforms fill it from the change time instead, where every
  // append would move it, so an absent or ctime-shaped value counts as unknown.
  const birthOf = info => Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 &&
    info.birthtimeMs !== info.ctimeMs ? info.birthtimeMs : null;

  // A tariff or catalog change re-reads the log to fill only previously unpriced
  // amounts. Known values stay, and lines counted as invalid are not recounted.
  function planIngest(info, fingerprint, revision) {
    const previous = get('usageCursor');
    const pending = get('pricingReplay');
    const sameFile = value => value?.ino === String(info.ino) && (!value.fingerprint || value.fingerprint === fingerprint);
    const replay = get('pricingRevision') !== revision || !get('ollamaPricingReplayV1') ||
      !get('codexAliasPricingReplayV1') || !get('cursorGrokPricingReplayV1');
    let cursor = previous;
    let replayThrough = 0;
    if (replay) {
      replayThrough = sameFile(previous) && previous.offset <= info.size ? previous.offset : 0;
      if (sameFile(pending) && pending.through <= info.size) replayThrough = Math.max(replayThrough, pending.through);
      if (!(sameFile(pending) && pending.revision === revision)) {
        cursor = { ino: String(info.ino), offset: 0, fingerprint };
        transact(() => {
          set('usageCursor', cursor);
          set('pricingReplay', { ...cursor, revision, through: replayThrough });
        });
      }
    }
    if (!cursor || cursor.ino !== String(info.ino) || cursor.offset > info.size ||
        (cursor.fingerprint && fingerprint && cursor.fingerprint !== fingerprint)) cursor = { ino: String(info.ino), offset: 0 };
    cursor.fingerprint = fingerprint;
    return { cursor, replayThrough };
  }

  // Skip one record longer than a whole batch, preserving the first complete record after it.
  async function skipOversizedRecord(handle, from, end) {
    let offset = from;
    while (offset < end) {
      const chunk = Buffer.alloc(Math.min(BATCH_BYTES, end - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      const newline = chunk.indexOf(10);
      if (newline >= 0) return offset + newline + 1;
      offset += bytesRead;
    }
    return null;
  }

  // One physical attempt: the usage row, its cache valuation inputs and ollama timings.
  function recordAttempt(entry, row, index, identities, priceUsage, { now, revision, evidenceCache }) {
    const { provider, account } = attributeUsage(row, identities);
    const usage = row.usage ?? {};
    const cost = priceUsage({ ...row, timestamp: entry.timestamp });
    const id = createHash('sha256').update(entry.requestId + '\0' + index).digest('hex');
    const model = modelName(row);
    const tokens = totalTokens(usage, row);
    const input = num(usage.inputTokens), output = num(usage.outputTokens), cached = cachedTokens(usage);
    const usd = Number.isFinite(cost.usd) && cost.usd >= 0 ? cost.usd : null;
    // One change means this write is the one that settled the amount: the row is new, or it
    // was unpriced and this pass filled it. A row whose amount already stood reports none,
    // and then its price record is left exactly as it was. That is the whole rule -- there
    // is no statement anywhere that updates a link, so an old row cannot be re-explained.
    const settled = insert.run(id, entry.timestamp, provider, account, model, input, output,
      cached, tokens, usd, cost.basis ?? 'unknown').changes === 1;
    if (settled && usd !== null && cost.evidence) {
      linkPrice.run(evidenceRowId(cost.evidence, revision, now, evidenceCache), now,
        id, provider, model, entry.timestamp, input, output, cached, tokens, usd, usd);
    }
    const cache = cost.cursorCache;
    if (provider === 'cursor' && cache && [cache.noCacheUsd, cache.fullCacheUsd, cache.eligibleInputTokens]
        .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
      cacheCost.run(cache.noCacheUsd, cache.fullCacheUsd, cache.eligibleInputTokens, id, model, entry.timestamp,
        input, output, cached, tokens);
    }
    // A coefficient set only makes sense as a real cache-write price: positive 5m
    // amount (it must equal the stored USD), a 1h amount at least as high, and a
    // positive token count it applies to. Anything else is a malformed quote.
    const claude = cost.claudeCache;
    if (provider === 'anthropic' && claude &&
        [claude.fiveMinuteUsd, claude.oneHourUsd, claude.cacheWriteTokens]
          .every(n => typeof n === 'number' && Number.isFinite(n)) &&
      claude.fiveMinuteUsd > 0 && claude.oneHourUsd >= claude.fiveMinuteUsd && claude.cacheWriteTokens > 0) {
      claudeCacheCost.run(claude.fiveMinuteUsd, claude.oneHourUsd, claude.cacheWriteTokens, id, model, entry.timestamp,
        input, output, cached, tokens, claude.fiveMinuteUsd, claude.fiveMinuteUsd);
    }
    if (provider === 'ollama-cloud') {
      timing.run(id, Number.isFinite(row.durationMs) && row.durationMs >= 0 ? row.durationMs : null,
        Number.isFinite(row.firstOutputMs) && row.firstOutputMs >= 0 ? row.firstOutputMs : null,
        row.usageStatus === 'reported' && [usage.inputTokens, usage.outputTokens]
          .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) ? 1 : 0);
    }
  }

  // Returns the running invalid-line count; callers commit it with the cursor.
  function ingestLines(batch, startOffset, { replayThrough, resetAt, identities, priceUsage, now, invalid, revision, evidenceCache }) {
    let offset = startOffset;
    let counted = invalid;
    for (const line of batch.split('\n')) {
      const alreadyCounted = offset < replayThrough;
      offset += Buffer.byteLength(line) + 1;
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { if (!alreadyCounted) counted++; continue; }
      if (!entry || !Number.isFinite(entry.timestamp) || entry.timestamp <= 0 ||
          entry.timestamp > now + 60000 || typeof entry.requestId !== 'string') { if (!alreadyCounted) counted++; continue; }
      if (entry.timestamp < now - retentionDays * DAY) continue;
      if (resetAt != null && entry.timestamp < resetAt) continue;
      const attempts = Array.isArray(entry.attempts) && entry.attempts.length ? entry.attempts : [entry];
      for (const [index, row] of attempts.entries()) {
        if (!row || row.locallyAnswered === true) continue;
        recordAttempt(entry, row, index, identities, priceUsage, { now, revision, evidenceCache });
      }
    }
    return counted;
  }

  const epochs = {
    current(provider, account) {
      const row = openEpoch.get(provider, account);
      return row ? { ...row } : null;
    },
    // Caller supplies the transaction. A physical digest is recorded only when it is not
    // derived from a credential; an unstorable one is written as NULL so that no token hash
    // ever lands in the database.
    open(provider, account, { basis, digest = null, storable = true }, now, reason) {
      closeEpoch.run(now, reason, provider, account);
      const epoch = (get('identityEpochSequence') ?? 0) + 1;
      set('identityEpochSequence', epoch);
      insertEpoch.run(provider, account, epoch, basis, storable ? digest : null, now, reason);
      return { epoch, basis, physicalDigest: storable ? digest : null, startedAt: now, reason };
    },
    close(provider, account, now, reason) { closeEpoch.run(now, reason, provider, account); },
    list(provider, account) { return listEpochs.all(provider, account).map(row => ({ ...row })); },
  };

  return {
    db, get, set, transact, epochs, close: () => db.close(),
    maintain(now) {
      if (now - (get('lastMaintenanceAt') ?? 0) < DAY) return;
      const cutoff = now - retentionDays * DAY;
      transact(() => {
        db.prepare('DELETE FROM usage_timings WHERE id IN (SELECT id FROM usage WHERE at<?)').run(cutoff);
        db.prepare('DELETE FROM cursor_cache_costs WHERE id IN (SELECT id FROM usage WHERE at<?)').run(cutoff);
        db.prepare('DELETE FROM claude_cache_costs WHERE id IN (SELECT id FROM usage WHERE at<?)').run(cutoff);
        db.prepare('DELETE FROM usage WHERE at<?').run(cutoff);
        // A link can outlive its usage row: an earlier release deletes usage without knowing
        // this table exists. One anti-join covers the expired rows and that residue together,
        // with no guess about when the residue was made.
        // NOT EXISTS here, because usage.id is a TEXT primary key and SQLite permits a NULL
        // in one -- a single NULL would make NOT IN delete nothing at all.
        db.prepare('DELETE FROM usage_prices WHERE NOT EXISTS (SELECT 1 FROM usage WHERE usage.id=usage_prices.id)').run();
        // NOT IN is the cheap form here, and evidence is NOT NULL so it is also the safe one.
        // Correlated, this rescans every link once per price record: 5.5s against 840k links
        // where the materialized set takes 42ms. An index on usage_prices(evidence) would cut
        // it to 0.7ms and cost 58.7MiB, which a database with a page cap cannot spare.
        db.prepare('DELETE FROM price_evidence WHERE id NOT IN (SELECT evidence FROM usage_prices)').run();
        db.prepare('DELETE FROM samples WHERE at<?').run(cutoff);
        db.prepare('DELETE FROM quota_observations WHERE at<?').run(cutoff);
        // Only closed epochs expire. An open epoch is the current identity boundary and has
        // no age, so removing it would reopen the number-reuse problem the sequence prevents.
        db.prepare('DELETE FROM identity_epochs WHERE endedAt IS NOT NULL AND endedAt<?').run(cutoff);
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ollama_observations'").get()) {
          db.prepare('DELETE FROM ollama_observations WHERE at<?').run(cutoff);
        }
        excludeBefore(cutoff);
        bumpUsageRevision();
        set('lastMaintenanceAt', now);
      });
      // Free pages are reused. Avoid VACUUM's extra disk and exclusive rewrite.
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    },
    capture(snapshot, now) {
      transact(() => {
        const resetAt = get('historyResetAt');
        for (const p of snapshot.providers) for (const a of p.accounts) for (const published of a.windows) {
          const w = published[HISTORY_READING] ?? published;
          // A window that says when it was measured is filed at that instant, which is not
          // necessarily the account's: one account can be read by several endpoints, and one
          // can answer while another is still behind. Filing every window at the account's
          // instant records an observation at a time nobody made, which reads later as a
          // plateau that never happened. A window that says nothing is unchanged.
          const measured = w[MEASURED_AT];
          const at = Number.isFinite(measured) ? measured : Date.parse(a.updatedAt);
          if (w.stale || !Number.isFinite(at) || at > now || at < now - retentionDays * DAY || (resetAt != null && at < resetAt) || !Number.isFinite(w.usedPercent)) continue;
          const reset = w.resetAt ? Date.parse(w.resetAt) : null;
          const previous = lastSample.get(p.id, a.id, w.id);
          // Rolling windows nudge their reset timestamp on every refresh. Treat a drift
          // the analytics already tolerates as the same cycle, or nothing ever dedupes.
          const sameCycle = previous && (previous.reset === reset ||
            (Number.isFinite(previous.reset) && Number.isFinite(reset) && Math.abs(previous.reset - reset) <= 60000));
          // The sample rule is unchanged. What changed is that it no longer decides the whole
          // window: skipping a sample must not skip the evidence beside it.
          const skipSample = Boolean(sameCycle && previous.used === w.usedPercent &&
            at > previous.at && at - previous.at < IDLE_SAMPLE_MS);
          // A predicate that says write is not a row that appeared. This is INSERT OR IGNORE, so
          // a second reading at an instant already taken changes nothing, and only the reported
          // change count knows which reading the surviving sample actually came from.
          const inserted = !skipSample &&
            sample.run(p.id, a.id, w.id, at, reset, w.usedPercent).changes === 1;
          const observation = observationOf(w, { at, epoch: w[IDENTITY_EPOCH] ?? null });
          if (observation === null) continue;
          // Two reasons to write evidence. Either it says something the last one did not, or a
          // sample row was really inserted and needs the record that identifies it. The second
          // is what makes the pairing a stored fact instead of an argument about which rule is
          // looser: the two dedupes keep their own idle clocks, and those clocks drift apart.
          if (!inserted && !shouldStore(lastObservation.get(p.id, a.id, w.id), observation,
            { idleMs: IDLE_SAMPLE_MS })) continue;
          insertObservation.run(p.id, a.id, w.id, observation.at, observation.epoch, observation.basis,
            observation.reportedPercent, observation.calculatedPercent, observation.observedPercent,
            observation.used, observation.limitValue, observation.limitState, observation.unit,
            observation.method, observation.windowSemantics, observation.scopeKey, observation.cycleKey,
            observation.reset, observation.source, observation.sourceVersion, observation.precisionEvidence,
            observation.resolutionPp, observation.reconciliation, observation.usedAccumulation,
            inserted ? 1 : 0);
        }
        if (!get('historyStartedAt')) set('historyStartedAt', now);
        set('lastCollectedAt', now);
      });
    },
    async ingest(file, identities, priceUsage, now) {
      const handle = await open(file, 'r');
      try {
        const info = await handle.stat();
        const resetAt = get('historyResetAt');
        const revision = priceUsage.revision ?? 'legacy-pricing';
        const fingerprint = await readFingerprint(handle, info.size);
        // Decide continuity from what we last consumed, before planIngest can rewrite
        // the cursor for a pricing replay. A replay re-reads the same file and keeps
        // its rows, so it is not a break; a different or rewritten file is.
        const previous = get('usageCursor');
        const pending = get('usageTailPending');
        const birth = birthOf(info);
        const sameLog = previous?.ino === String(info.ino) && previous.offset <= info.size &&
          (!previous.fingerprint || !fingerprint || previous.fingerprint === fingerprint) &&
          (!previous.birthtimeMs || !birth || previous.birthtimeMs === birth);
        const consumedIntact = sameLog && (!previous.boundaryDigest ||
          await boundaryOf(handle, previous.offset) === previous.boundaryDigest);
        // A record we already saw but could not finish reading must still be there.
        // Cursor movement alone would let an unrelated byte stand in for it.
        // A stored null means we never managed to read that record. Comparing it with
        // another failed read would let a shrinking file pass as an unbroken run.
        const pendingIntact = !pending || (pending.digest !== null &&
          await digestRange(handle, pending.from, pending.length) === pending.digest);
        if (!sameLog || !consumedIntact || !pendingIntact || !Number.isFinite(get('usageObservedSince'))) {
          transact(() => restartObservation(now));
        }
        const { cursor, replayThrough } = planIngest(info, fingerprint, revision);
        const end = info.size;
        let invalid = get('invalidUsageLines') ?? 0;
        while (cursor.offset < end) {
          const buffer = Buffer.alloc(Math.min(BATCH_BYTES, end - cursor.offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
          const last = buffer.lastIndexOf(10, bytesRead - 1);
          if (last < 0) {
            if (bytesRead < BATCH_BYTES) break; // a concurrently written final line stays pending
            const resume = await skipOversizedRecord(handle, cursor.offset + bytesRead, end);
            if (resume === null) break;
            if (cursor.offset >= replayThrough) invalid++;
            cursor.offset = resume;
            // A record we could not decode is history we cannot account for.
            transact(() => { set('usageCursor', cursor); set('invalidUsageLines', invalid); restartObservation(now); });
            continue;
          }
          invalid = transact(() => {
            // The cache lives inside one batch and no longer. A price record id is only good
            // within the transaction that read it: a rollback, or another connection running
            // retention between batches, can delete the row, and the integer key is handed to
            // different content on the next insert. Carried across batches, the cache would
            // then link a settled amount to a record that is gone or belongs to another price.
            const counted = ingestLines(buffer.subarray(0, last).toString('utf8'), cursor.offset,
              { replayThrough, resetAt, identities, priceUsage, now, invalid, revision, evidenceCache: new Map() });
            cursor.offset += last + 1;
            set('usageCursor', cursor);
            set('invalidUsageLines', counted);
            // The rows this batch wrote are committed here, and the revision moves with them.
            bumpUsageRevision();
            if (counted > invalid) restartObservation(now);
            return counted;
          });
          await new Promise(resolve => setImmediate(resolve));
        }
        const boundaryDigest = await boundaryOf(handle, cursor.offset);
        const tail = cursor.offset < end
          ? { from: cursor.offset, length: end - cursor.offset, digest: await digestRange(handle, cursor.offset, end - cursor.offset) }
          : null;
        transact(() => {
          set('usageCursor', { ...cursor, birthtimeMs: birth, boundaryDigest });
          set('usageTailPending', tail);
          // Only a read that reached the end of the file extends the observed interval.
          if (!tail) set('usageObservedThrough', now);
          excludeBefore(now - retentionDays * DAY);
          set('usageReadAt', now);
          set('ollamaPricingReplayV1', true);
          set('codexAliasPricingReplayV1', true);
          set('cursorGrokPricingReplayV1', true);
          set('pricingRevision', revision);
          set('pricingReplay', null);
        });
      } finally { await handle.close(); }
    },
    // The scope narrows which usage rows count. It never narrows the interval.
    stats(provider, account, from, to, scope = null) {
      let { clause: filter, args } = accountFilter(provider, from, to, account);
      const models = scope?.models;
      if (models?.length) {
        const globs = models.map(() => 'lower(model) GLOB ?').join(' OR ');
        // A row with no recorded model cannot be placed in or out of the set, so it
        // stays in and keeps marking uncertainty instead of silently vanishing.
        filter += scope.exclude ? ` AND (model IS NULL OR NOT (${globs}))` : ` AND (model IS NULL OR ${globs})`;
        args.push(...models.map(pattern => pattern.toLowerCase()));
      }
      const r = db.prepare(`SELECT count(*) requests, sum(tokens) tokens, sum(input) inputTokens,
        sum(output) outputTokens, sum(cached) cachedTokens, count(usd) pricedRequests, sum(usd) apiUsd,
        sum(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) unknownPriceRequests,
        sum(CASE WHEN usd IS NULL THEN tokens ELSE 0 END) unknownPriceTokens,
        sum(CASE WHEN usd IS NULL AND (tokens IS NULL OR tokens<=0) THEN 1 ELSE 0 END) unknownPriceUnsizedRequests,
        sum(CASE WHEN basis='local-catalog' THEN 1 ELSE 0 END) localPriceRequests,
        sum(cacheEstimated) cacheEstimatedRequests,sum(estimatedCachedTokens) estimatedCachedTokens,sum(noCacheUsd) noCacheApiUsd
        FROM usage_valued WHERE provider=? AND at>? AND at<=?${filter}`).get(...args);
      for (const key of Object.keys(r)) if (!['apiUsd','noCacheApiUsd'].includes(key)) r[key] ??= 0;
      return { ...r };
    },
    points(provider, account, window, from) {
      return db.prepare('SELECT at,reset,used FROM samples WHERE provider=? AND account=? AND window=? AND at>=? ORDER BY at').all(provider, account, window, from);
    },
    // Every retained observation in the interval, in the order they were stored. Not capped and
    // not thinned: the transported chart is a picture and this is the record, and a total computed
    // from a picture is not a total. The caller chooses the interval.
    observations(provider, account, window, from, to = Infinity, { preserveBarriers = false } = {}) {
      const through = Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER;
      // A reversed reading can fall outside the time horizon while sitting between two
      // candidate readings in storage order. Keep that evidence for consumption pairing;
      // otherwise filtering manufactures a continuous interval that never existed.
      if (preserveBarriers) return db.prepare(`WITH bounds AS (
          SELECT min(seq) first, max(seq) last FROM quota_observations
          WHERE provider=? AND account=? AND window=? AND at>=? AND at<=?)
        SELECT o.* FROM quota_observations o, bounds b
        WHERE o.provider=? AND o.account=? AND o.window=? AND o.seq BETWEEN b.first AND b.last
        ORDER BY o.seq`).all(provider, account, window, from, through, provider, account, window)
        .map(row => ({ ...row }));
      return db.prepare(`SELECT * FROM quota_observations WHERE provider=? AND account=? AND window=?
        AND at>=? AND at<=? ORDER BY seq`).all(provider, account, window, from,
          through).map(row => ({ ...row }));
    },
    // Which account each retained sample belongs to. Only the observations that a sample insert
    // actually produced are listed, so one instant names one identity even where two readings
    // arrived at the same instant and the samples table kept only the first. A sample older than
    // this table has no row here and stays unknown rather than being credited to whoever holds
    // the account id now.
    pointIdentities(provider, account, window, from) {
      return db.prepare(`SELECT at,epoch FROM quota_observations WHERE provider=? AND account=?
        AND window=? AND at>=? AND pairsSample=1 ORDER BY seq`).all(provider, account, window, from)
        .map(row => ({ ...row }));
    },
    // What identifies the usage rows a reader can currently see, for a caller that caches a
    // query over them. Two other candidates look like they would work and do not. The last
    // successful read timestamp lags: ingestion commits batch after batch and yields between
    // them, setting that timestamp only once the file is consumed. The import cursor repeats:
    // a pricing replay rewinds it to zero, rewrites the amounts on rows it already held, and
    // lands back on exactly the offset it started from. Only a counter advanced in the same
    // transaction as the rows themselves can be trusted, so that is what this is.
    usageRevision() { return String(get('usageDataRevision') ?? 0); },
    unpricedModels(provider, from, to) {
      return db.prepare(`SELECT model,count(*) requests FROM usage WHERE provider=? AND at>? AND at<=? AND usd IS NULL
        GROUP BY model ORDER BY requests DESC,model LIMIT 20`).all(provider,from,to).map(row=>({...row}));
    },
    // Every distinct model actually recorded for this provider, priced or not. Unlike
    // unpricedModels this is not capped: a model must not vanish from the price list
    // because twenty others were noisier.
    // cachedTokens rides along because it is what decides whether a missing cache-read
    // rate is an item this installation actually needs or one it never reaches.
    observedModels(provider, from, to) {
      return db.prepare(`SELECT model,count(*) requests,sum(tokens) tokens,sum(cached) cachedTokens,
        sum(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) unpricedRequests
        FROM usage WHERE provider=? AND at>? AND at<=? AND model IS NOT NULL
        GROUP BY model ORDER BY requests DESC,model`).all(provider,from,to)
        .map(row=>({...row, tokens: row.tokens ?? 0, cachedTokens: row.cachedTokens ?? 0}));
    },
    // The same rows as stats(), broken out per model and bucketed into trailing periods.
    // The periods are nested windows of one anchor, so they are the same rows counted with
    // different lower bounds: one pass does what a query per period would each repeat.
    // Read from usage_valued so an unpriced count here means exactly what stats() publishes
    // as unknownPriceRequests, unknownPriceTokens and unknownPriceUnsizedRequests.
    // A row with no model name groups under null and is returned rather than filtered out.
    // A call nothing can attribute to a model is the one most worth reporting, not the one
    // to drop, and no finding can be hung on it.
    modelPeriodUsage(provider, to, spans) {
      const periods = (Array.isArray(spans) ? spans : []).filter(([key, ms]) =>
        typeof key === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(key) && Number.isFinite(ms) && ms > 0);
      if (!periods.length) return [];
      const longest = Math.max(...periods.map(([, ms]) => ms));
      // Column names come from the caller's period table. A key that is not a bare
      // identifier is refused above rather than interpolated into the statement.
      const columns = periods.map(([key]) => [
        `sum(CASE WHEN at>? THEN 1 ELSE 0 END) ${key}Requests`,
        `sum(CASE WHEN at>? THEN tokens ELSE 0 END) ${key}Tokens`,
        `sum(CASE WHEN at>? AND usd IS NULL THEN 1 ELSE 0 END) ${key}UnpricedRequests`,
        `sum(CASE WHEN at>? AND usd IS NULL THEN tokens ELSE 0 END) ${key}UnpricedTokens`,
        `sum(CASE WHEN at>? AND usd IS NULL AND (tokens IS NULL OR tokens<=0) THEN 1 ELSE 0 END) ${key}UnsizedRequests`,
      ].join(',')).join(',');
      // Placeholders bind in the order they appear in the statement text, so every CASE
      // threshold is bound before the three values the WHERE clause takes.
      const args = [...periods.flatMap(([, ms]) => Array(5).fill(to - ms)), provider, to - longest, to];
      return db.prepare(`SELECT model,${columns} FROM usage_valued
        WHERE provider=? AND at>? AND at<=? GROUP BY model`).all(...args).map(row => {
          const out = {...row};
          for (const key of Object.keys(out)) if (key !== 'model') out[key] ??= 0;
          return out;
        });
    },
    // What priced a past call, as it was recorded -- not what the same model costs today.
    // Rows the catalog no longer carries keep their record for as long as the usage does,
    // which is the point: a price list cannot explain an amount after the model leaves it.
    // Grouping on the evidence row rather than the link folds a link whose record is gone
    // into the same unrecorded group as a row that never had one.
    priceEvidence(provider, from, to) {
      return db.prepare(`SELECT u.model, e.id evidenceId, e.status, e.provider pricingProvider,
        e.model pricedModel, e.sourceUrl, e.checkedAt, e.effectiveFrom, e.effectiveTo, e.rates,
        e.tierMultiplier, e.conditions, e.unsupported, e.conflict, e.reason, e.firstRevision,
        count(*) requests, sum(u.usd) storedApiUsd, min(u.at) firstAt, max(u.at) lastAt,
        min(p.pricedAt) firstPricedAt, max(p.pricedAt) lastPricedAt
        FROM usage u LEFT JOIN usage_prices p ON p.id=u.id LEFT JOIN price_evidence e ON e.id=p.evidence
        WHERE u.provider=? AND u.at>? AND u.at<=? AND u.usd IS NOT NULL AND u.model IS NOT NULL
        GROUP BY u.model, e.id ORDER BY lastAt DESC, u.model`).all(provider, from, to).map(row => ({
          model: row.model,
          // null is a row we cannot explain, and it is left saying so. Filling it from the
          // current price list would invent evidence for a call priced under another tariff.
          evidence: row.evidenceId === null ? null : {
            status: row.status, pricingProvider: row.pricingProvider, pricedModel: row.pricedModel,
            rates: parsed(row.rates), tierMultiplier: row.tierMultiplier, sourceUrl: row.sourceUrl,
            checkedAt: row.checkedAt, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo,
            conditions: parsed(row.conditions), unsupported: parsed(row.unsupported),
            conflict: row.conflict === null ? null : parsed(row.conflict),
            reason: row.reason, firstRevision: row.firstRevision },
          requests: row.requests, storedApiUsd: row.storedApiUsd, firstAt: row.firstAt,
          lastAt: row.lastAt, firstPricedAt: row.firstPricedAt, lastPricedAt: row.lastPricedAt }));
    },
    bounds(provider, account) {
      if (!provider) return db.prepare('SELECT min(at) since, max(at) through FROM usage').get();
      if (typeof account === 'string') return db.prepare('SELECT min(at) since, max(at) through FROM usage WHERE provider=? AND account=?').get(provider,account);
      return db.prepare('SELECT min(at) since, max(at) through FROM usage WHERE provider=?').get(provider);
    },
    pricedBounds(provider, from, to, account) {
      const { clause: filter, args } = accountFilter(provider, from, to, account);
      return db.prepare(`SELECT min(at) since,max(at) through FROM usage_valued WHERE provider=? AND at>? AND at<=? AND usd>0${filter}`).get(...args);
    },
    peakFiveHour(provider, from, to) {
      const rows = db.prepare('SELECT at,usd FROM usage_valued WHERE provider=? AND at>? AND at<=? ORDER BY at').all(provider,from,to);
      let first=0, sum=0, peak=0;
      for (let last=0;last<rows.length;last++) {
        sum += rows[last].usd ?? 0;
        while (rows[last].at-rows[first].at >= 5*3600000) { sum -= rows[first].usd ?? 0; first++; }
        peak = Math.max(peak,sum);
      }
      return peak;
    },
  };
}
