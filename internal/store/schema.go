package store

const schemaSQL = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=3000;
PRAGMA journal_size_limit=16777216;
PRAGMA wal_autocheckpoint=1000;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, at INTEGER NOT NULL, provider TEXT NOT NULL,
  account TEXT, model TEXT, input REAL, output REAL, cached REAL, tokens REAL, usd REAL, basis TEXT);
CREATE INDEX IF NOT EXISTS usage_time ON usage(at,provider,account);
CREATE TABLE IF NOT EXISTS samples (provider TEXT, account TEXT, window TEXT, at INTEGER,
  reset INTEGER, used REAL, PRIMARY KEY(provider,account,window,at));
CREATE INDEX IF NOT EXISTS samples_time ON samples(at);
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
CREATE TABLE IF NOT EXISTS collection_logs (id INTEGER PRIMARY KEY, startedAt INTEGER NOT NULL, provider TEXT NOT NULL, account TEXT NOT NULL, endpoint TEXT NOT NULL, result TEXT NOT NULL, httpStatus INTEGER, durationMs INTEGER NOT NULL, retryAfterMs INTEGER, nextAttemptAt INTEGER NOT NULL, failures INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS collection_logs_time ON collection_logs(startedAt,id);
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
CREATE TABLE IF NOT EXISTS ollama_observations (source TEXT, at INTEGER, payload TEXT, PRIMARY KEY(source,at));
CREATE TEMP VIEW IF NOT EXISTS usage_valued AS
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
         ELSE u.usd END noCacheUsd,
    u.rowid rid
  FROM usage u LEFT JOIN cursor_cache_costs c ON c.id=u.id AND u.provider='cursor'
  LEFT JOIN claude_cache_costs cc ON cc.id=u.id AND u.provider='anthropic'
  LEFT JOIN assumption a ON 1=1 LEFT JOIN claude cl ON 1=1;
`

var requiredTables = []string{
	"meta", "usage", "samples", "quota_observations", "usage_timings",
	"cursor_cache_costs", "claude_cache_costs", "identity_epochs",
	"price_evidence", "usage_prices", "ollama_observations", "collection_logs",
}

var requiredIndexes = []string{
	"usage_time", "samples_time", "quota_observations_window",
	"quota_observations_time", "identity_epochs_open", "collection_logs_time",
}
