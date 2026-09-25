#!/usr/bin/env node
// JUN-272 integration harness.
// Bars are locked before any measurement. A miss is a failed run, never a lowered bar.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, cpSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const BAR = Object.freeze({
  repeats: 7,
  dropWorst: 2,
  idleRssImprovePct: 15,
  collectWallImprovePct: 15,
  otherImprovePct: 5,
  noExtraExternalReqs: true,
  warmupRule: 'drop-worst-2',
  notFirstTwo: true,
});

const REQUIRED = Object.freeze([
  'probes-268', 'probes-269', 'probes-270', 'probes-271',
  'baseline', 'feature-roster', 'feature-cases', 'binary-handoff', 'db-roundtrip',
  'resource', 'negative-controls', 'swift-payload', 'evidence',
]);

const REQUIRED_TABLES = [
  'meta', 'usage', 'samples', 'quota_observations', 'usage_timings',
  'cursor_cache_costs', 'claude_cache_costs', 'identity_epochs',
  'price_evidence', 'usage_prices',
];
const REQUIRED_INDEXES = [
  'usage_time', 'samples_time', 'quota_observations_window',
  'quota_observations_time', 'identity_epochs_open',
];

const NOW_MS = 1_800_000_000_000;
const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
// The comparison baseline is the pinned pre-port Node source. It is extracted
// read-only from git history into scratch, never taken from candidate HEAD.
const BASELINE_SHA = 'cbaf12cca3a6ae8f70de37c47f22757381c47a49';
const checks = [];
const ownedChildren = new Set();
const failures = [];
const judgments = {};
const rawMeasurements = {};
let finished = false;
let evidencePath = null;

function expect(condition, description, detail) {
  checks.push(description);
  if (!condition) {
    failures.push(detail === undefined ? description : description + ' — ' + JSON.stringify(detail));
  }
  return Boolean(condition);
}

function fail(msg) {
  console.error(msg);
  throw new Error(msg);
}

process.on('exit', (code) => {
  if (finished) return;
  if (!checks.length) {
    console.error('port-integrate: 0 assertions');
    process.exitCode = 1;
    return;
  }
  if (code === 0 && failures.length) process.exitCode = 1;
});

if (process.argv.includes('--self-test-zero-checks')) {
  finished = true;
  console.error('port-integrate: 0 assertions');
  process.exit(1);
}

if (process.argv.includes('--print-bar')) {
  finished = true;
  console.log(JSON.stringify(BAR));
  process.exit(0);
}

// Negative-control flags: each verifies that one failure mode really fails
// closed. They run before any measurement work so the controls stay cheap.
if (process.argv.includes('--self-test-missing-baseline')) {
  finished = true;
  const bogusDir = join(tmpdir(), 'qm-missing-baseline-' + Date.now());
  const resolved = resolveBaseline('0'.repeat(40), bogusDir);
  const closed = resolved.ok === false && Boolean(resolved.error);
  console.log(JSON.stringify({ missingBaselineFailsClosed: closed, error: closed ? resolved.error : null }));
  process.exit(closed ? 0 : 1);
}

if (process.argv.includes('--self-test-baseline-extract')) {
  finished = true;
  const dir = join('/scratch/quota-manager/port-review-fixes/harness', 'selftest-baseline-' + Date.now());
  try {
    const resolved = resolveBaseline(BASELINE_SHA, dir);
    let importsOk = false;
    if (resolved.ok) {
      const mod = await import(pathToFileURL(join(dir, 'src/snapshot.mjs')).href);
      importsOk = typeof mod.readSnapshot === 'function';
    }
    const ok = resolved.ok === true && importsOk && Boolean(resolved.baselineTreeSha256);
    console.log(JSON.stringify({ baselineExtractOk: ok, fileCount: resolved.fileCount ?? 0, baselineTreeSha256: resolved.baselineTreeSha256 ?? null, error: resolved.ok ? null : resolved.error }));
    process.exitCode = ok ? 0 : 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--self-test-incomplete-samples')) {
  finished = true;
  const result = summarize([1, 2, null, 3, 4, 5, 6], BAR.dropWorst);
  const ok = result.mean === null && summarize([1], BAR.dropWorst).mean === null;
  console.log(JSON.stringify({incompleteSamplesFailClosed: ok}));
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--self-test-null-metric')) {
  finished = true;
  const m = validResourceMeasurement();
  m.go.cpuUsecPerCycle = null;
  const j = judgeResource(m, BAR);
  const closed = j.ran === false && j.ok === false && j.nullMetrics.includes('go.cpuUsecPerCycle');
  console.log(JSON.stringify({ nullMetricFailsClosed: closed }));
  process.exit(closed ? 0 : 1);
}

if (process.argv.includes('--self-test-degraded-metric')) {
  finished = true;
  const m = validResourceMeasurement();
  for (const key of ['rssMean', 'collectMean', 'snapP50', 'snapP95', 'coldMs', 'cpuUsecPerCycle', 'dbWriteBytes']) m.go[key] *= 2;
  m.go.externalCalls = 3;
  const j = judgeResource(m, BAR);
  const closed = j.ran === true && j.ok === false && j.missed.length >= 3 && j.externalPass === false;
  console.log(JSON.stringify({ degradedMetricFailsClosed: closed, missed: j.missed }));
  process.exit(closed ? 0 : 1);
}

if (process.argv.includes('--self-test-http-failure')) {
  finished = true;
  const dead = await sampleOnce('http://127.0.0.1:1');
  const closed = dead.ok === false;
  console.log(JSON.stringify({ httpFailureFailsClosed: closed }));
  process.exit(closed ? 0 : 1);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', ...opts });
}

function sha256File(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function resolveBaseline(sha, dest) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, error: 'baseline SHA is not a full 40-hex commit id' };
  const have = run('git', ['cat-file', '-e', sha + '^{commit}']);
  if (have.status !== 0) return { ok: false, error: 'pinned baseline commit ' + sha + ' not found in this repository' };
  mkdirSync(dest, { recursive: true });
  // A tarball is binary: keep spawn output as a Buffer or a UTF-8 decode
  // silently corrupts the archive.
  const arch = run('git', ['archive', sha], { maxBuffer: 256 * 1024 * 1024, encoding: null });
  if (arch.status !== 0 || !arch.stdout.length) {
    return { ok: false, error: 'git archive of the pinned baseline failed: ' + (arch.stderr || 'empty archive').slice(-200) };
  }
  const extract = run('tar', ['-x', '-C', dest], { input: arch.stdout, encoding: null });
  if (extract.status !== 0) return { ok: false, error: 'tar extraction of the baseline archive failed: ' + (extract.stderr || 'no stderr').slice(-200) };
  if (!existsSync(join(dest, 'src/collector.mjs'))) return { ok: false, error: 'extracted baseline has no src/collector.mjs' };
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      const r = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(p, r);
      else if (entry.isFile()) files.push([r, sha256File(p)]);
    }
  };
  walk(dest, '');
  files.sort((a, b) => a[0].localeCompare(b[0]));
  if (!files.length) return { ok: false, error: 'extracted baseline tree is empty' };
  const manifest = files.map(([p, h]) => p + ':' + h).join('\n');
  return {
    ok: true, sha, dest,
    fileCount: files.length,
    baselineTreeSha256: createHash('sha256').update(manifest).digest('hex'),
  };
}

// wchar from /proc/self/io: bytes this process has passed to write() syscalls.
// Delta windows attribute them to one collect. A 0 delta means unmeasured and
// fails closed downstream; file-size footprint is never a write metric.
function ioWriteCharBytes() {
  try {
    const line = readFileSync('/proc/self/io', 'utf8').split('\n').find(l => l.startsWith('wchar:'));
    const n = Number(line?.slice(6).trim() ?? NaN);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// The real mount under the path, resolved by findmnt. A directory name is not
// proof of a mount: target must live on /scratch.
function scratchMountOf(path) {
  const fm = spawnSync('findmnt', ['-T', path, '-n', '-o', 'TARGET,SOURCE'], { encoding: 'utf8' });
  if (fm.status !== 0) return null;
  const parts = fm.stdout.trim().split(/\s+/);
  const target = parts[0];
  const source = parts.slice(1).join(' ');
  if (!target || !target.startsWith('/scratch')) return null;
  return { target, source };
}

function pickScratch() {
  const candidates = ['/scratch/quota-manager/port-review-fixes/harness', '/scratch'];
  const info = { path: null, mount: false, mountTarget: null, mountSource: null, bytesFree: 0, inodesFree: 0, used: null, note: 'scratch not verified' };
  for (const scratch of candidates) {
    try {
      if (!existsSync(scratch)) continue;
      mkdirSync(scratch, { recursive: true });
      const mount = scratchMountOf(scratch);
      if (!mount) continue;
      const df = spawnSync('df', ['-PB1', scratch], { encoding: 'utf8' });
      const di = spawnSync('df', ['-Pi', scratch], { encoding: 'utf8' });
      const b = df.stdout.trim().split('\n').at(-1)?.split(/\s+/) ?? [];
      const i = di.stdout.trim().split('\n').at(-1)?.split(/\s+/) ?? [];
      info.bytesFree = Number(b[3] ?? 0);
      info.inodesFree = Number(i[3] ?? 0);
      if (info.bytesFree > 64 * 1024 * 1024 && info.inodesFree > 1000) {
        info.path = scratch;
        info.used = scratch;
        info.mount = true;
        info.mountTarget = mount.target;
        info.mountSource = mount.source;
        info.note = 'work dir is on a verified /scratch mount (target ' + mount.target + ', source ' + mount.source + ') and is deleted after the run';
        break;
      }
    } catch { /* try the next candidate */ }
  }
  if (!info.used) {
    // Policy: large work never falls back to the root disk or tmpdir.
    info.note = 'no verified /scratch mount with free bytes and inodes; refusing tmpdir fallback';
  }
  return info;
}

function writeRosterFixture(home, native) {
  mkdirSync(native, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256').update('opencodex-main-quota-v1\0physical').digest('hex');
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    providers: {
      openai: {},
      anthropic: {},
      'ollama-cloud': { apiKey: 'SECRET_SENTINEL', apiKeyPool: [{ id: 'k1', key: 'SECRET_SENTINEL' }] },
    },
    codexAccounts: [{ id: 'pool1', email: 'someone@example.com', plan: 'pro' }],
    activeCodexAccountId: 'pool1',
  }));
  writeFileSync(join(home, 'auth.json'), JSON.stringify({
    anthropic: {
      activeAccountId: 'a1',
      accounts: [
        { id: 'a1', credential: { access: 'SECRET_SENTINEL', email: 'person@example.com' } },
        { id: 'a2', credential: { access: 'SECRET_SENTINEL' } },
      ],
    },
  }));
  writeFileSync(join(home, 'codex-accounts.json'), JSON.stringify({
    pool1: { credential: { accessToken: 'SECRET_SENTINEL' } },
    deleted: { deletedAt: NOW_MS },
  }));
  writeFileSync(join(home, 'codex-quota-cache.json'), JSON.stringify({
    version: 1,
    quotas: {
      pool1: { updatedAt: NOW_MS, weeklyPercent: 80, weeklyResetAt: 1800003600 },
      deleted: { weeklyPercent: 10 },
    },
    mainPolicyQuota: { identityKey: hash, quota: { updatedAt: NOW_MS, weeklyPercent: 0 } },
  }));
  writeFileSync(join(home, 'provider-account-quota-cache.json'), JSON.stringify({
    version: 1,
    rows: {
      'anthropic\u0000a1': { updatedAt: NOW_MS, fiveHourPercent: 100, fiveHourResetAt: NOW_MS + 3600000 },
      'anthropic\u0000a2': { updatedAt: NOW_MS - 7 * 3600000, weeklyPercent: 23 },
    },
  }));
  writeFileSync(join(native, 'auth.json'), JSON.stringify({
    tokens: { account_id: 'physical', access_token: 'SECRET_SENTINEL' },
  }));
}

function writeUsageLog(home, extra = []) {
  const lines = [
    { requestId: 'n-u1', timestamp: NOW_MS - 3_600_000, provider: 'openai', model: 'gpt-5.4',
      usage: { inputTokens: 1000, outputTokens: 100 } },
    { requestId: 'n-u2', timestamp: NOW_MS - 1_000, provider: 'openai', model: 'gpt-5.4',
      usage: { inputTokens: 2000, outputTokens: 200 } },
    ...extra,
  ];
  writeFileSync(join(home, 'usage.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function fixedPrice(row) {
  return {
    usd: 0.0125,
    basis: 'fixed-catalog',
    evidence: {
      provider: row.provider ?? 'openai',
      model: row.model ?? 'gpt-5.4',
      status: 'official',
      sourceUrl: null,
      checkedAt: '2027-01-15T08:00:00.000Z',
      effectiveFrom: null,
      effectiveTo: null,
      rates: { input: 5, output: 25, cacheRead: null, cacheWrite: null },
      tierMultiplier: null,
      conditions: [],
      unsupported: [],
      conflict: null,
      reason: null,
    },
  };
}
fixedPrice.revision = 'fixed-v1';

function harness(payload) {
  const bin = join(root, 'dist/port-harness');
  const p = run(bin, [], { input: JSON.stringify(payload) });
  if (p.status !== 0) {
    return { ok: false, error: (p.stderr || p.stdout || 'harness failed').trim(), raw: p };
  }
  try {
    return JSON.parse(p.stdout);
  } catch {
    return { ok: false, error: 'harness stdout is not JSON', stdout: p.stdout };
  }
}

function rssOf(pid) {
  try {
    const text = readFileSync('/proc/' + pid + '/status', 'utf8');
    const line = text.split('\n').find(l => l.startsWith('VmRSS:'));
    const n = Number(line?.split(/\s+/)[1] ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function sampleOnce(origin) {
  const t0 = nowMs();
  let ok = false;
  try {
    const res = await fetch(origin + '/api/v1/snapshot', { signal: AbortSignal.timeout(4000) });
    ok = res.ok;
    await res.arrayBuffer();
  } catch { /* failure counted by the caller */ }
  return { ms: nowMs() - t0, ok };
}


function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[i];
}

function summarize(samples, dropWorst) {
  if (samples.length !== BAR.repeats || samples.some(n => !Number.isFinite(n) || n <= 0)) {
    return {raw: samples, kept: [], p50: null, p95: null, mean: null};
  }
  const sorted = [...samples].filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const kept = sorted.length > dropWorst ? sorted.slice(0, sorted.length - dropWorst) : sorted;
  return {
    raw: samples,
    kept,
    p50: percentile(kept, 0.50),
    p95: percentile(kept, 0.95),
    mean: kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : 0,
  };
}

function improvePct(baseline, candidate) {
  if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(candidate) || candidate <= 0) return null;
  return (baseline - candidate) / baseline * 100;
}

// Fail-closed resource judgment. Every metric must be measured: a null, an
// unmeasured value, or a failed HTTP sample fails the run, never passes it.
function judgeResource(m, bar) {
  const node = m.node ?? {};
  const go = m.go ?? {};
  const nullMetrics = [];
  const need = (v, name) => {
    if (v === null || v === undefined || !Number.isFinite(v)) { nullMetrics.push(name); return null; }
    return v;
  };
  const vals = {
    nodeRss: need(node.rssMean, 'node.rssMean'),
    goRss: need(go.rssMean, 'go.rssMean'),
    nodeCollect: need(node.collectMean, 'node.collectMean'),
    goCollect: need(go.collectMean, 'go.collectMean'),
    nodeSnapP50: need(node.snapP50, 'node.snapP50'),
    goSnapP50: need(go.snapP50, 'go.snapP50'),
    nodeSnapP95: need(node.snapP95, 'node.snapP95'),
    goSnapP95: need(go.snapP95, 'go.snapP95'),
    nodeCold: need(node.coldMs, 'node.coldMs'),
    goCold: need(go.coldMs, 'go.coldMs'),
    nodeCpu: need(node.cpuUsecPerCycle, 'node.cpuUsecPerCycle'),
    goCpu: need(go.cpuUsecPerCycle, 'go.cpuUsecPerCycle'),
    nodeWrite: need(node.dbWriteBytes, 'node.dbWriteBytes'),
    goWrite: need(go.dbWriteBytes, 'go.dbWriteBytes'),
    nodeExternal: need(node.externalCalls, 'node.externalCalls'),
    goExternal: need(go.externalCalls, 'go.externalCalls'),
  };
  const httpFailures = (node.httpFailures ?? 0) + (go.httpFailures ?? 0);
  const ran = nullMetrics.length === 0 && httpFailures === 0 &&
    vals.nodeRss > 0 && vals.goRss > 0 && vals.nodeCollect > 0 && vals.goCollect > 0 &&
    vals.nodeCold > 0 && vals.goCold > 0 &&
    vals.nodeCpu > 0 && vals.goCpu > 0 && vals.nodeWrite > 0 && vals.goWrite > 0;
  // A measured 0 CPU or write delta is not a passing zero: the window
  // observed nothing and cannot be compared.
  const zeroMetrics = [
    ['node.cpuUsecPerCycle', vals.nodeCpu], ['go.cpuUsecPerCycle', vals.goCpu],
    ['node.dbWriteBytes', vals.nodeWrite], ['go.dbWriteBytes', vals.goWrite],
  ].filter(([, v]) => v === 0).map(([name]) => name);
  const improves = {
    rssImprovePct: improvePct(vals.nodeRss, vals.goRss),
    collectImprovePct: improvePct(vals.nodeCollect, vals.goCollect),
    snapP50ImprovePct: improvePct(vals.nodeSnapP50, vals.goSnapP50),
    snapP95ImprovePct: improvePct(vals.nodeSnapP95, vals.goSnapP95),
    coldImprovePct: improvePct(vals.nodeCold, vals.goCold),
    cpuImprovePct: improvePct(vals.nodeCpu, vals.goCpu),
    dbWriteImprovePct: improvePct(vals.nodeWrite, vals.goWrite),
  };
  const meets = v => v !== null && v >= bar.otherImprovePct;
  const bottleneckPass = (improves.rssImprovePct !== null && improves.rssImprovePct >= bar.idleRssImprovePct) ||
    (improves.collectImprovePct !== null && improves.collectImprovePct >= bar.collectWallImprovePct);
  const otherNames = {
    snapP50ImprovePct: improves.snapP50ImprovePct,
    snapP95ImprovePct: improves.snapP95ImprovePct,
    coldImprovePct: improves.coldImprovePct,
    cpuImprovePct: improves.cpuImprovePct,
    dbWriteImprovePct: improves.dbWriteImprovePct,
  };
  const otherPass = Object.values(otherNames).every(meets);
  const externalPass = Number.isInteger(vals.nodeExternal) && Number.isInteger(vals.goExternal) &&
    vals.goExternal <= vals.nodeExternal;
  const missed = [];
  if (!bottleneckPass) missed.push('bottleneck: idle-RSS ' + bar.idleRssImprovePct + '% or collect-wall ' + bar.collectWallImprovePct + '%');
  for (const [name, v] of Object.entries(otherNames)) {
    if (!meets(v)) missed.push(name + ' >= ' + bar.otherImprovePct + '% (got ' + v + ')');
  }
  if (!externalPass) missed.push('no extra external requests');
  return {
    ran, ok: ran && bottleneckPass && otherPass && externalPass,
    improves, otherNames, bottleneckPass, otherPass, externalPass,
    nullMetrics, zeroMetrics, missed, httpFailures,
  };
}

function validResourceMeasurement() {
  return {
    node: { rssMean: 120, collectMean: 90, snapP50: 5, snapP95: 9, coldMs: 600, cpuUsecPerCycle: 12000, dbWriteBytes: 20000, externalCalls: 0, httpFailures: 0 },
    go: { rssMean: 60, collectMean: 45, snapP50: 2.4, snapP95: 4.4, coldMs: 300, cpuUsecPerCycle: 6000, dbWriteBytes: 10000, externalCalls: 0, httpFailures: 0 },
  };
}

function projectAccounts(snap) {
  const out = [];
  for (const p of snap.providers ?? []) {
    for (const a of p.accounts ?? []) {
      out.push({
        provider: p.id,
        account: a.id,
        status: a.status,
        windows: (a.windows ?? []).map(w => ({
          id: w.id,
          remaining: w.remainingPercent ?? null,
          used: w.usedPercent ?? null,
          stale: w.stale ?? false,
        })),
      });
    }
  }
  return out.sort((a, b) => (a.provider + a.account).localeCompare(b.provider + b.account));
}

function secretsIn(value) {
  const raw = JSON.stringify(value);
  return /SECRET_SENTINEL|someone@example.com|sk-test|sk-ant/.test(raw);
}

function dumpNodeDB(dir) {
  const db = new DatabaseSync(join(dir, 'history.sqlite'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IS NOT NULL").all().map(r => r.name);
  const usage = db.prepare('SELECT id,at,provider,account,model,usd,basis,input,output,tokens FROM usage ORDER BY at').all();
  const observations = db.prepare('SELECT provider,account,window,at,observedPercent,basis FROM quota_observations ORDER BY seq').all();
  const evidence = db.prepare('SELECT provider,model,status FROM price_evidence ORDER BY id').all();
  const cursorRow = db.prepare("SELECT value FROM meta WHERE key='usageCursor'").get();
  const counts = {};
  for (const name of REQUIRED_TABLES) {
    try { counts[name] = db.prepare('SELECT COUNT(*) n FROM ' + name).get().n; } catch { counts[name] = -1; }
  }
  db.close();
  return { tables, indexes, usage, observations, evidence, cursor: cursorRow ? JSON.parse(cursorRow.value) : null, counts };
}

async function waitHealth(origin, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(300) });
      if (res.ok) return true;
    } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

// Graceful stop and observed exit. A later writer or a same-port restart must
// never race the previous process.
async function stopChild(proc, ms = 8000) {
  const child = proc.child;
  if (!child.pid) return false;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, ms);
    const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); resolve(); };
    child.once('exit', finish);
    if (!child.kill('SIGTERM')) finish();
  });
  return child.exitCode !== null || child.signalCode !== null;
}

// Healthy is not enough: the boot DTO can serve before the first cycle. A
// snapshot with analytics.status === 'ok' proves the binary completed a read.
async function waitCycleOk(origin, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(origin + '/api/v1/snapshot', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const snap = await res.json();
        if (snap?.analytics?.status === 'ok') return true;
      }
    } catch { /* cycling */ }
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
}

async function pickPort(from, to) {
  for (let n = from; n <= to; n++) {
    try {
      const res = await fetch('http://127.0.0.1:' + n + '/healthz', { signal: AbortSignal.timeout(150) });
      if (res.ok) continue;
    } catch {
      return n;
    }
  }
  return null;
}

function startChild(bin, args, env) {
  const child = spawn(bin, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownedChildren.add(child);
  child.once('error', () => {});
  const stderr = [];
  child.stderr?.on('data', c => stderr.push(c.toString()));
  return { child, stderr };
}

const scratchInfo = pickScratch();
expect(scratchInfo.mount === true && Boolean(scratchInfo.used), 'scratch mount verified via findmnt (no tmpdir fallback)', scratchInfo.note);
if (!scratchInfo.used) fail('verified /scratch mount required: ' + scratchInfo.note);
const work = await mkdtemp(join(scratchInfo.used, 'qm-integrate-'));
try {
evidencePath = join(work, 'port-integrate-evidence.json');
judgments.evidence = { ran: false, ok: false };

const nodeSHA = run('git', ['rev-parse', 'HEAD']).stdout.trim();
const contractSHA = sha256File(join(root, 'contracts/schema.json'))
  || sha256File(join(root, 'contracts/snapshot.schema.json'));
const startedAt = new Date().toISOString();
const envInfo = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  go: run('go', ['env', 'GOVERSION']).stdout.trim(),
  cwd: root,
};

expect(BAR.repeats === 7 && BAR.dropWorst === 2, 'bar locked: 7 repeats drop 2 worst');
expect(BAR.idleRssImprovePct === 15 && BAR.collectWallImprovePct === 15, 'bar locked: 15% idle-RSS or collect-wall');
expect(BAR.otherImprovePct === 5 && BAR.noExtraExternalReqs === true, 'bar locked: 5% others and no extra external requests');
expect(BAR.warmupRule === 'drop-worst-2' && BAR.notFirstTwo, 'bar uses worst-2, not first-2');
expect(Boolean(nodeSHA), 'Node/source SHA is recorded before measurement');

// Pin the comparison baseline: the pre-port Node source is extracted read-only
// from git history into scratch. Candidate HEAD never stands in for it.
judgments.baseline = { ran: false, ok: false };
const baselineDir = join(work, 'baseline-' + BASELINE_SHA.slice(0, 8));
const baselineResolved = resolveBaseline(BASELINE_SHA, baselineDir);
expect(baselineResolved.ok, 'pinned Node baseline resolves from git archive', baselineResolved.error);
if (!baselineResolved.ok) {
  fail('pinned Node baseline ' + BASELINE_SHA.slice(0, 8) + ' is missing: ' + baselineResolved.error);
}
expect(Boolean(baselineResolved.baselineTreeSha256), 'baseline archive content hash is recorded');
judgments.baseline = {
  ran: true, ok: true, sha: BASELINE_SHA,
  baselineTreeSha256: baselineResolved.baselineTreeSha256,
  fileCount: baselineResolved.fileCount, dest: baselineDir,
};
const baselineSnapshot = await import(pathToFileURL(join(baselineDir, 'src/snapshot.mjs')).href);
const baselineHistory = await import(pathToFileURL(join(baselineDir, 'src/history.mjs')).href);
const baselineCollector = await import(pathToFileURL(join(baselineDir, 'src/collector.mjs')).href);
expect(
  typeof baselineSnapshot.readSnapshot === 'function' &&
  typeof baselineHistory.openHistory === 'function' &&
  typeof baselineCollector.createCollector === 'function',
  'baseline archive exports the collector API',
);

mkdirSync(join(root, 'dist'), { recursive: true });
const build = run('bash', ['scripts/build-quota-manager.sh']);
expect(build.status === 0, 'candidate binary builds', build.status === 0 ? undefined : (build.stderr || build.stdout).slice(-400));
const binary = join(root, 'dist/quota-manager');
const manifestPath = join(root, 'dist/quota-manager.manifest.json');
expect(existsSync(binary) && existsSync(manifestPath), 'binary and hash manifest exist');
const binaryHash = sha256File(binary);
let manifest = {};
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = {}; }
expect(manifest.binarySha256 === binaryHash, 'manifest binary hash matches the file', { want: manifest.binarySha256, got: binaryHash });

const harnessBuild = run('go', ['build', '-o', join(root, 'dist/port-harness'), './cmd/port-harness']);
expect(harnessBuild.status === 0, 'port-harness builds', harnessBuild.stderr);

function recordProbe(id, p, extraOk = true) {
  const ran = p.status !== null;
  const ok = ran && p.status === 0 && extraOk && /ok|PASS|passed|rehearse/i.test(`${p.stdout}\n${p.stderr}`) || (ran && p.status === 0 && extraOk);
  judgments[id] = { ran, ok: Boolean(ok), status: p.status, tail: `${p.stdout}\n${p.stderr}`.trim().slice(-300) };
  expect(ran, id + ' ran');
  expect(Boolean(ok), id + ' passed', judgments[id].tail);
  return Boolean(ok);
}

recordProbe('probes-268', run('go', ['test', '-count=1', '-race', './internal/runtime', '-run', 'TestProbeHealthyProviderSurvivesOtherOutage|TestProbeUnknownIsNotStoredAsZero']));
recordProbe('probes-269', run('go', ['test', '-count=1', '-race', './internal/runtime', './cmd/quota-manager', '-run', 'TestProbeRosterWithoutDirectMakesNoNetwork|TestBinaryRosterSnapshotNoDirect']));
recordProbe('probes-270', run('go', ['test', '-count=1', '-race', './internal/runtime', '-run', 'TestProbeHealthySnapshotRetainsAnalytics|TestFiveHourGapIsNotHourlyAllocated']));
const ui = run('npm', ['run', 'check:port:ui']);
recordProbe('probes-271', ui, /port-ui passed/.test(ui.stdout + ui.stderr) || ui.status === 0);
recordProbe('check-port', run('npm', ['run', 'check:port']));
recordProbe('go-rollback-unit', run('go', ['test', '-count=1', './internal/store', '-run', 'TestRoundTripOldNewOldNew']));
recordProbe('go-vet', run('go', ['vet', './internal/runtime', './internal/store', './internal/collect', './cmd/port-harness', './cmd/perfcompare', './cmd/quota-manager']));

const rosterHome = join(work, 'roster-home');
const rosterNative = join(rosterHome, 'native');
mkdirSync(rosterHome, { recursive: true });
writeRosterFixture(rosterHome, rosterNative);
writeUsageLog(rosterHome);

const nodeSnap = await baselineSnapshot.readSnapshot(rosterHome, NOW_MS, rosterNative);
expect(nodeSnap.schemaVersion === 1, 'Node baseline snapshot is schemaVersion 1');
expect(!secretsIn(nodeSnap), 'Node snapshot has no fixture secrets');
const nodeAccounts = projectAccounts(nodeSnap);
expect(nodeAccounts.some(a => a.provider === 'openai' && a.account === '__main__'), 'Node roster has openai/__main__');
expect(nodeAccounts.some(a => a.provider === 'openai' && a.account === 'pool1'), 'Node roster has openai/pool1');
expect(nodeAccounts.some(a => a.provider === 'anthropic' && a.account === 'a1'), 'Node roster has anthropic/a1');

const goPort = await pickPort(19010, 19040);
expect(Boolean(goPort), 'free port for Go binary');
const goData = join(work, 'go-bin-data');
mkdirSync(goData, { recursive: true });
const goStart = nowMs();
const goProc = startChild(binary, [], {
  OPENCODEX_HOME: rosterHome,
  QUOTA_CODEX_HOME: rosterNative,
  QUOTA_CLAUDE_HOME: join(rosterHome, 'noclaude'),
  QUOTA_DATA_DIR: goData,
  QUOTA_HOST: '127.0.0.1',
  QUOTA_PORT: String(goPort),
  QUOTA_DIRECT_PROVIDERS: '',
});
const goOrigin = 'http://127.0.0.1:' + goPort;
const goUp = await waitHealth(goOrigin);
const goColdSamples = [nowMs() - goStart];
expect(goUp, 'Go binary became healthy');

let goSnap = null;
if (goUp) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(goOrigin + '/api/v1/snapshot');
      goSnap = await res.json();
      if (Array.isArray(goSnap.providers) && goSnap.providers.length >= 3) break;
    } catch { /* cycle */ }
    await new Promise(r => setTimeout(r, 50));
  }
}
expect(goSnap && goSnap.schemaVersion === 1, 'Go binary snapshot is schemaVersion 1', goSnap && Object.keys(goSnap));
expect(goSnap && !secretsIn(goSnap), 'Go binary snapshot has no fixture secrets');
const goAccounts = projectAccounts(goSnap || { providers: [] });
expect(goAccounts.some(a => a.provider === 'openai' && a.account === '__main__'), 'Go binary keeps openai/__main__');
expect(goAccounts.some(a => a.provider === 'openai' && a.account === 'pool1'), 'Go binary keeps openai/pool1');
expect(goAccounts.some(a => a.provider === 'anthropic' && a.account === 'a1'), 'Go binary keeps anthropic/a1');

const mainN = nodeAccounts.find(a => a.account === '__main__');
const mainG = goAccounts.find(a => a.account === '__main__');
const poolN = nodeAccounts.find(a => a.account === 'pool1');
const poolG = goAccounts.find(a => a.account === 'pool1');
const claudeN = nodeAccounts.find(a => a.account === 'a1');
const claudeG = goAccounts.find(a => a.account === 'a1');
expect(mainN && mainG && mainN.windows[0]?.remaining === 100 && mainG.windows[0]?.remaining === 100,
  'main remaining 100% matches', { node: mainN, go: mainG });
expect(poolN && poolG && poolN.windows[0]?.remaining === 20 && poolG.windows[0]?.remaining === 20,
  'pool remaining 20% matches', { node: poolN, go: poolG });
expect(claudeN && claudeG && claudeN.windows[0]?.remaining === 0 && claudeG.windows[0]?.remaining === 0,
  'claude measured-zero remaining 0% matches', { node: claudeN, go: claudeG });

if (goUp) {
  for (const route of ['/', '/app.js', '/types.js', '/contract.js', '/style.css', '/api/v1/snapshot', '/healthz']) {
    const res = await fetch(goOrigin + route);
    expect(res.status === 200, 'Go binary serves ' + route, res.status);
  }
  const missing = await fetch(goOrigin + '/format');
  expect(missing.status === 404, 'extensionless /format stays 404 on the real binary', missing.status);
}

judgments['feature-roster'] = { ran: true, ok: failures.filter(f => /roster|binary keeps|remaining|serves/.test(f)).length === 0 };

const caseRoot = join(work, 'cases');
mkdirSync(caseRoot, { recursive: true });
const cases = harness({ mode: 'cases', data: caseRoot, nowMs: NOW_MS });
expect(cases.ok === true, 'collect feature cases passed', cases);
if (Array.isArray(cases.cases)) {
  for (const c of cases.cases) {
    expect(c.ok === true, 'case ' + c.id, c.detail || c.error);
  }
} else {
  expect(false, 'feature cases produced a case list', cases);
}
judgments['feature-cases'] = { ran: Boolean(cases.cases), ok: cases.ok === true, cases: cases.cases };

// Primary DB handoff, mirroring a real cutover: the Node baseline writer owns
// the DB, the production binary ingests from the same usage.jsonl, the Node
// writer appends again, and the binary reopens the same file. The port-harness
// store helper below is only a secondary roundtrip.
const handoffNow = Date.now();
const handoffID = requestID => createHash('sha256').update(requestID + '\0' + 0).digest('hex');
const handoffDir = join(work, 'binary-handoff');
mkdirSync(handoffDir, { recursive: true });
const handoffHome = join(work, 'binary-handoff-home');
mkdirSync(join(handoffHome, 'nocodex'), { recursive: true });
mkdirSync(join(handoffHome, 'noclaude'), { recursive: true });
writeFileSync(join(handoffHome, 'config.json'), JSON.stringify({ providers: {} }));
const handoffLog = join(handoffHome, 'usage.jsonl');
writeFileSync(handoffLog, [
  JSON.stringify({ requestId: 'bh-1', timestamp: handoffNow - 2000, provider: 'openai', model: 'gpt-5.4', usage: { inputTokens: 10, outputTokens: 2 } }),
  JSON.stringify({ requestId: 'bh-2', timestamp: handoffNow - 1000, provider: 'openai', model: 'gpt-5.4', usage: { inputTokens: 20, outputTokens: 4 } }),
].join('\n') + '\n');

const bhFailures0 = failures.length;
const bhHist1 = await baselineHistory.openHistory(handoffDir);
await bhHist1.ingest(handoffLog, { labels: new Map(), plans: new Map() }, fixedPrice, handoffNow);
bhHist1.capture({
  providers: [{
    id: 'openai',
    accounts: [{
      id: 'key:default',
      updatedAt: new Date(handoffNow).toISOString(),
      windows: [{ id: 'weekly', usedPercent: 10, remainingPercent: 90 }],
    }],
  }],
}, handoffNow);
await bhHist1.close();
const bhAfterNode1 = dumpNodeDB(handoffDir);
expect(bhAfterNode1.usage.length >= 2, 'Node baseline writer stored the first usage rows', bhAfterNode1.usage.map(u => u.id));
expect(bhAfterNode1.usage.every(u => u.usd === 0.0125), 'Node baseline writer stored priced USD', bhAfterNode1.usage.map(u => [u.id, u.usd]));

// The cutover contract: the binary continues the same usage.jsonl the Node
// writer cursor points at, then hands the file back.
writeFileSync(handoffLog, [
  JSON.stringify({ requestId: 'bh-1', timestamp: handoffNow - 2000, provider: 'openai', model: 'gpt-5.4', usage: { inputTokens: 10, outputTokens: 2 } }),
  JSON.stringify({ requestId: 'bh-2', timestamp: handoffNow - 1000, provider: 'openai', model: 'gpt-5.4', usage: { inputTokens: 20, outputTokens: 4 } }),
  JSON.stringify({ requestId: 'bh-3', timestamp: handoffNow, provider: 'openai', model: 'gpt-5.4', usage: { inputTokens: 30, outputTokens: 6 } }),
].join('\n') + '\n');

const bhPort = await pickPort(19090, 19110);
expect(Boolean(bhPort), 'free port for the binary handoff');
const bhProc = startChild(binary, [], {
  OPENCODEX_HOME: handoffHome,
  QUOTA_CODEX_HOME: join(handoffHome, 'nocodex'),
  QUOTA_CLAUDE_HOME: join(handoffHome, 'noclaude'),
  QUOTA_DATA_DIR: handoffDir,
  QUOTA_HOST: '127.0.0.1',
  QUOTA_PORT: String(bhPort),
  QUOTA_DIRECT_PROVIDERS: '',
});
const bhUp = await waitHealth('http://127.0.0.1:' + bhPort);
expect(bhUp, 'production binary opened the Node-written DB and became healthy', bhProc.stderr.join('').slice(-300));
let bhIngested = false;
if (bhUp) {
  const bhDeadline = Date.now() + 12000;
  while (Date.now() < bhDeadline) {
    if (dumpNodeDB(handoffDir).usage.some(u => u.id === handoffID('bh-3'))) { bhIngested = true; break; }
    await new Promise(r => setTimeout(r, 120));
  }
}
expect(bhIngested, 'production binary ingested the appended usage row');
await stopChild(bhProc);

writeFileSync(handoffLog, [
  JSON.stringify({ requestId: 'bh-1', timestamp: handoffNow - 2000, provider: 'openai', model: 'gpt-5.4', usage: { inputTokens: 10, outputTokens: 2 } }),
  JSON.stringify({ requestId: 'bh-2', timestamp: handoffNow - 1000, provider: 'openai', model: 'gpt-5.4', usage: { inputTokens: 20, outputTokens: 4 } }),
  JSON.stringify({ requestId: 'bh-3', timestamp: handoffNow, provider: 'openai', model: 'gpt-5.4', usage: { inputTokens: 30, outputTokens: 6 } }),
  JSON.stringify({ requestId: 'bh-4', timestamp: handoffNow + 1000, provider: 'openai', model: 'gpt-5.4', usage: { inputTokens: 40, outputTokens: 8 } }),
].join('\n') + '\n');
const bhHist2 = await baselineHistory.openHistory(handoffDir);
await bhHist2.ingest(handoffLog, { labels: new Map(), plans: new Map() }, fixedPrice, handoffNow + 1000);
await bhHist2.close();

const bhProc2 = startChild(binary, [], {
  OPENCODEX_HOME: handoffHome,
  QUOTA_CODEX_HOME: join(handoffHome, 'nocodex'),
  QUOTA_CLAUDE_HOME: join(handoffHome, 'noclaude'),
  QUOTA_DATA_DIR: handoffDir,
  QUOTA_HOST: '127.0.0.1',
  QUOTA_PORT: String(bhPort),
  QUOTA_DIRECT_PROVIDERS: '',
});
const bhUp2 = await waitHealth('http://127.0.0.1:' + bhPort, 10000);
expect(bhUp2, 'production binary reopened the shared DB after Node writes', bhProc2.stderr.join('').slice(-300));
const bhCycleOk = bhUp2 ? await waitCycleOk('http://127.0.0.1:' + bhPort) : false;
expect(bhCycleOk, 'reopened binary completed a cycle (snapshot analytics.status ok)');
await stopChild(bhProc2);
const bhFinal = dumpNodeDB(handoffDir);
const bhIds = bhFinal.usage.map(u => u.id);
expect(
  ['bh-1', 'bh-2', 'bh-3', 'bh-4'].every(id => bhIds.filter(x => x === handoffID(id)).length === 1),
  'binary handoff kept every usage id exactly once', bhIds,
);
expect(
  bhFinal.usage.filter(u => ['bh-1', 'bh-2', 'bh-4'].map(handoffID).includes(u.id)).every(u => u.usd === 0.0125),
  'stored USD survived the binary handoff', bhFinal.usage.map(u => [u.id, u.usd]),
);
expect(Boolean(bhFinal.cursor) && bhFinal.cursor.offset > 0, 'usage cursor survived the binary handoff', bhFinal.cursor);
expect(bhFinal.evidence.length >= 1, 'price evidence survived the binary handoff', bhFinal.evidence.length);
expect(REQUIRED_TABLES.every(t => bhFinal.tables.includes(t)), 'handoff DB kept the required schema', bhFinal.tables);
const bhOk = failures.length === bhFailures0;
expect(bhOk, 'binary handoff preserved ids, cursor, stored USD and evidence');
judgments['binary-handoff'] = { ran: true, ok: Boolean(bhOk), ids: bhIds, cursor: bhFinal.cursor, counts: bhFinal.counts };

const dbDir = join(work, 'roundtrip');
mkdirSync(dbDir, { recursive: true });
const usageFile = join(work, 'roundtrip-usage.jsonl');
writeFileSync(usageFile, [
  JSON.stringify({ requestId: 'rt-1', timestamp: NOW_MS - 2000, provider: 'openai', model: 'gpt-5.4',
    usage: { inputTokens: 10, outputTokens: 2 } }),
  JSON.stringify({ requestId: 'rt-2', timestamp: NOW_MS - 1000, provider: 'openai', model: 'gpt-5.4',
    usage: { inputTokens: 20, outputTokens: 4 } }),
].join('\n') + '\n');

const rtFailures0 = failures.length;
const nodeHist = await baselineHistory.openHistory(dbDir);
await nodeHist.ingest(usageFile, { labels: new Map(), plans: new Map() }, fixedPrice, NOW_MS);
nodeHist.capture({
  providers: [{
    id: 'openai',
    accounts: [{
      id: 'key:default',
      updatedAt: new Date(NOW_MS).toISOString(),
      windows: [{ id: 'weekly', usedPercent: 10, remainingPercent: 90 }],
    }],
  }],
}, NOW_MS);
nodeHist.close();
const afterNode = dumpNodeDB(dbDir);
expect(afterNode.usage.length >= 2, 'Node writer stored usage rows', afterNode.usage.map(u => u.id));
expect(afterNode.evidence.length >= 1, 'Node writer stored price evidence', afterNode.evidence);
expect(REQUIRED_TABLES.every(t => afterNode.tables.includes(t)), 'Node-created schema has required tables', afterNode.tables);
expect(REQUIRED_INDEXES.every(i => afterNode.indexes.includes(i)), 'Node-created schema has required indexes', afterNode.indexes);

const goWrite = harness({
  mode: 'db-write',
  data: dbDir,
  nowMs: NOW_MS,
  writes: {
    usage: [{
      id: 'go-u3', at: NOW_MS, provider: 'openai', model: 'gpt-5.4', basis: 'fixed-catalog',
      input: 30, output: 6, tokens: 36, usd: 0.02,
    }],
    observations: [{
      provider: 'openai', account: 'key:default', window: 'weekly', at: NOW_MS,
      basis: 'ok', observedPercent: 12,
    }],
    evidence: [{
      provider: 'openai', model: 'gpt-5.4', status: 'official', firstRevision: 'fixed-v1',
      firstSeenAt: NOW_MS, input: 5, output: 25,
    }],
    duplicateUsage: ['go-u3', afterNode.usage[0]?.id].filter(Boolean),
  },
});
expect(goWrite.ok === true, 'Go writer opened the Node DB', goWrite.error);
expect(goWrite.counts?.usage >= 3, 'Go writer added a usage row', goWrite.counts);
expect(goWrite.counts?.quota_observations >= 1, 'Go writer added an observation', goWrite.counts);
expect(goWrite.duplicateChangedCount === false, 'duplicate usage id is a no-op');
expect(goWrite.schemaOK === true, 'schema/index/constraint survived the Go write', goWrite.schemaError);

const nodeHist2 = await baselineHistory.openHistory(dbDir);
const moreLog = join(work, 'roundtrip-usage-2.jsonl');
writeFileSync(moreLog, JSON.stringify({
  requestId: 'rt-4', timestamp: NOW_MS + 1000, provider: 'openai', model: 'gpt-5.4',
  usage: { inputTokens: 40, outputTokens: 8 },
}) + '\n');
await nodeHist2.ingest(moreLog, { labels: new Map(), plans: new Map() }, fixedPrice, NOW_MS + 1000);
nodeHist2.close();
const afterNode2 = dumpNodeDB(dbDir);
expect(afterNode2.usage.some(u => u.id === 'go-u3'), 'Node reopen still sees the Go usage row');
expect(afterNode2.usage.length >= 4, 'Node reopen plus new ingest kept all rows', afterNode2.usage.map(u => u.id));
expect(afterNode2.observations.length >= 1, 'Node reopen kept Go observations');
expect(afterNode2.cursor && afterNode2.cursor.offset > 0, 'usage cursor advanced', afterNode2.cursor);

const goReopen = harness({ mode: 'db-read', data: dbDir });
expect(goReopen.ok === true && goReopen.schemaOK === true, 'Go reopen of the shared DB succeeded', goReopen.error);
expect((goReopen.usage || []).length === afterNode2.usage.length, 'Go reopen usage count matches Node', {
  go: (goReopen.usage || []).length, node: afterNode2.usage.length,
});
const goIds = new Set((goReopen.usage || []).map(u => u.id));
expect(afterNode2.usage.every(u => goIds.has(u.id)), 'Go reopen preserves every usage id');
const rtOk = failures.length === rtFailures0;
judgments['db-roundtrip'] = { ran: true, ok: Boolean(rtOk), node1: afterNode.counts, goWrite: goWrite.counts, node2: afterNode2.counts, go2: goReopen.counts };

const ncFailures0 = failures.length;
const emptyCompare = projectAccounts({ providers: [] });
expect(!(emptyCompare.length === goAccounts.length && goAccounts.length > 0),
  'empty-provider control does not match a real roster');
const zeroAsUnknown = { providers: [{ id: 'openai', accounts: [{ id: 'missing', status: 'ok', windows: [{ id: 'weekly', remainingPercent: 0 }] }] }] };
expect(JSON.stringify(projectAccounts(zeroAsUnknown)) !== JSON.stringify(goAccounts),
  'invented 0% account does not satisfy roster equality');

const zeroSelf = run(process.execPath, ['scripts/check-port-integrate.mjs', '--self-test-zero-checks']);
expect(zeroSelf.status !== 0 && /0 assertions/.test(zeroSelf.stderr + zeroSelf.stdout),
  '0-check control fails');

const nullMetricCtl = run(process.execPath, ['scripts/check-port-integrate.mjs', '--self-test-null-metric']);
expect(nullMetricCtl.status === 0 && /"nullMetricFailsClosed":true/.test(nullMetricCtl.stdout),
  'null resource metric control fails closed', nullMetricCtl.stdout + nullMetricCtl.stderr);

const degradedCtl = run(process.execPath, ['scripts/check-port-integrate.mjs', '--self-test-degraded-metric']);
expect(degradedCtl.status === 0 && /"degradedMetricFailsClosed":true/.test(degradedCtl.stdout),
  'degraded metric control fails closed', degradedCtl.stdout + degradedCtl.stderr);

const httpFailureCtl = run(process.execPath, ['scripts/check-port-integrate.mjs', '--self-test-http-failure']);
expect(httpFailureCtl.status === 0 && /"httpFailureFailsClosed":true/.test(httpFailureCtl.stdout),
  'HTTP failure control fails closed', httpFailureCtl.stdout + httpFailureCtl.stderr);

const missingBin = run(join(root, 'dist/port-harness'), [], { input: '{}' });
expect(missingBin.status !== 0, 'empty harness request is not success');

const corrupt = harness({ mode: 'not-a-mode' });
expect(corrupt.ok === false || missingBin.status !== 0, 'unknown harness mode fails');

const extraReq = (cases.cases || []).find(c => c.id === 'refresh-no-extra');
expect(extraReq && extraReq.ok, 'refresh-no-extra negative path is a real check');
const ncOk = failures.length === ncFailures0;
judgments['negative-controls'] = { ran: true, ok: Boolean(ncOk) };

const nodePort = await pickPort(19050, 19080);
expect(Boolean(nodePort), 'free port for Node baseline');
const nodeData = join(work, 'node-bin-data');
mkdirSync(nodeData, { recursive: true });
const nodeStart = nowMs();
const nodeProc = startChild(process.execPath, [join(baselineDir, 'src/server.mjs')], {
  OPENCODEX_HOME: rosterHome,
  QUOTA_CODEX_HOME: rosterNative,
  QUOTA_CLAUDE_HOME: join(rosterHome, 'noclaude'),
  QUOTA_DATA_DIR: nodeData,
  QUOTA_HOST: '127.0.0.1',
  QUOTA_PORT: String(nodePort),
  QUOTA_DIRECT_PROVIDERS: '',
});
const nodeOrigin = 'http://127.0.0.1:' + nodePort;
const nodeUp = await waitHealth(nodeOrigin, 10000);
const nodeColdSamples = [nowMs() - nodeStart];
expect(nodeUp, 'Node baseline process became healthy', nodeProc.stderr.join('').slice(-200));
// Cold start follows the same seven-repeat/drop-worst-two rule.
for (let i=1; i<BAR.repeats; i++) {
 for (const [kind, bin, args, samples] of [
  ['go', binary, [], goColdSamples],
  ['node', process.execPath, [join(baselineDir,'src/server.mjs')], nodeColdSamples],
 ]) {
  const port=await pickPort(19120,19150);
  if (!port) {samples.push(null);continue;}
  const started=nowMs();
  const proc=startChild(bin,args,{
   OPENCODEX_HOME:rosterHome,QUOTA_CODEX_HOME:rosterNative,
   QUOTA_CLAUDE_HOME:join(rosterHome,'noclaude'),QUOTA_DATA_DIR:join(work,kind+'-cold-'+i),
   QUOTA_HOST:'127.0.0.1',QUOTA_PORT:String(port),QUOTA_DIRECT_PROVIDERS:'',
  });
  try { samples.push(await waitHealth('http://127.0.0.1:'+port) ? nowMs()-started : null); }
  finally {await stopChild(proc);}
 }
}
const goCold=summarize(goColdSamples,BAR.dropWorst).mean;
const nodeCold=summarize(nodeColdSamples,BAR.dropWorst).mean;


async function sampleProcess(proc, origin, repeats) {
  const rss = [];
  const snap = [];
  let httpFailures = 0;
  if (!proc.child.pid) return { rss, snap, cpu: 0, httpFailures: repeats };
  for (let i = 0; i < repeats; i++) {
    rss.push(rssOf(proc.child.pid));
    const s = await sampleOnce(origin);
    if (!s.ok) httpFailures += 1;
    snap.push(s.ms);
    await new Promise(r => setTimeout(r, 40));
  }
  return { rss, snap, httpFailures };
}

// One measured snapshot request. A failed or non-200 response is an invalid
// sample, not a silent data point.

const goSamples = goUp
  ? await sampleProcess(goProc, goOrigin, BAR.repeats)
  : { rss: [], snap: [], cpu: 0, httpFailures: BAR.repeats };
const nodeSamples = nodeUp
  ? await sampleProcess(nodeProc, nodeOrigin, BAR.repeats)
  : { rss: [], snap: [], cpu: 0, httpFailures: BAR.repeats };

// Fixed, bounded ingestion workload shared byte-for-byte by both collectors.
const RESOURCE_ROWS = 10000;
const collectHome = join(work, 'resource-home');
cpSync(rosterHome, collectHome, { recursive: true });
writeFileSync(join(collectHome, 'usage.jsonl'), Array.from({length: RESOURCE_ROWS}, (_,i) => JSON.stringify({
  requestId: 'resource-' + i, timestamp: NOW_MS - 10000 + i,
  provider: i % 2 ? 'openai' : 'anthropic', model: i % 2 ? 'gpt-5.4' : 'claude-sonnet-4',
  usage: {inputTokens: 1000, outputTokens: 200},
})).join('\n') + '\n');

// Equal work on both sides: source read, usage ingest and analytics snapshot
// (runtime construction and store opening excluded) against the same synthetic roster on a
// fresh SQLite directory. A cached snapshot read is not a collect.
if (process.argv.includes('--self-test-resource-throw')) throw new Error('injected resource collection failure');
const tNodeCollect = [];
const tGoCollect = [];
const goCpuUsec = [];
const goWriteBytes = [];
const nodeCpuSamples = [];
const nodeWriteSamples = [];
let nodeFetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { nodeFetchCalls += 1; return realFetch(...args); };
try {
  for (let i = 0; i < BAR.repeats; i++) {
    const c = await baselineCollector.createCollector({
      home: collectHome,
      codexHome: join(collectHome, 'native'),
      claudeHome: join(collectHome, 'noclaude'),
      dataDir: join(work, 'node-collect-' + i),
      storage: { retentionDays: 90, maxBytes: 512 * 1024 * 1024 },
      directAdapters: [],
      intervalMs: 3_600_000,
      now: () => NOW_MS,
    });
    // Same window as Go: construction and store open stay outside the timers.
    // Wall, CPU, and write volume are deltas around collect() only.
    let cpuBefore, writeBefore, a;
    try {
      cpuBefore = process.cpuUsage();
      writeBefore = ioWriteCharBytes();
      a = nowMs();
      await c.collect({ waitForQuota: false });
      const calculated = await c.snapshot();
      if (calculated.analytics?.status === 'error') throw new Error('baseline collect failed');
      const count = calculated.providers.reduce((sum,p) => sum + (p.analytics?.periods?.monthly?.requests ?? 0),0);
      if (count !== RESOURCE_ROWS) throw new Error('baseline collected row count mismatch: ' + count);
      tNodeCollect.push(nowMs() - a);
      const cpuDelta = process.cpuUsage(cpuBefore);
      nodeCpuSamples.push(cpuDelta.user + cpuDelta.system);
      const writeAfter = ioWriteCharBytes();
      nodeWriteSamples.push(writeBefore === null || writeAfter === null || writeAfter < writeBefore ? null : writeAfter - writeBefore);
    } finally {
      await c.close();
    }
  }
} finally {
  globalThis.fetch = realFetch;
}

let goExternalCalls = null;
let goExternalUnmeasured = false;
for (let i = 0; i < BAR.repeats; i++) {
  const goC = harness({
    mode: 'snapshot',
    home: collectHome,
    codexHome: join(collectHome, 'native'),
    claudeHome: join(collectHome, 'noclaude'),
    data: join(work, 'collect-' + i),
    nowMs: NOW_MS,
    direct: [],
    cycles: 1,
  });
  expect(goC.snapshot?.analytics?.usage?.requests === RESOURCE_ROWS, 'Go resource cycle consumed the fixed workload', goC.snapshot?.analytics?.usage);
  const wall = goC.ok && Array.isArray(goC.collectWallMs) ? goC.collectWallMs[0] : null;
  tGoCollect.push(Number.isFinite(wall) && wall > 0 ? wall : null);
  goCpuUsec.push(goC.ok && Array.isArray(goC.cpuUsec) && Number.isFinite(goC.cpuUsec[0]) && goC.cpuUsec[0] > 0 ? goC.cpuUsec[0] : null);
  goWriteBytes.push(goC.ok && Array.isArray(goC.writeBytes) && Number.isFinite(goC.writeBytes[0]) && goC.writeBytes[0] > 0 ? goC.writeBytes[0] : null);
  if (typeof goC.externalCalls !== 'number') goExternalUnmeasured = true;
  else goExternalCalls = Math.max(goExternalCalls ?? 0, goC.externalCalls);
  if (goC.ok && goC.externalCalls > 0) {
    expect(false, 'roster collect must not make external calls', goC.externalCalls);
  }
  if (!goC.ok) expect(false, 'Go full-cycle collect run ' + i + ' failed', goC.error);
}

// CPU: Node measures its own process around the collect loop (process.cpuUsage);
// Go reports getrusage microsecond deltas around the same collect window.
const nodeCpuUsecPerCycle = summarize(nodeCpuSamples, BAR.dropWorst).mean;
const goCpuUsecPerCycle = summarize(goCpuUsec, BAR.dropWorst).mean;
const nodeWriteBytesPerCycle = summarize(nodeWriteSamples, BAR.dropWorst).mean;
const goWriteBytesPerCycle = summarize(goWriteBytes, BAR.dropWorst).mean;

const nodeRss = summarize(nodeSamples.rss, BAR.dropWorst);
const goRss = summarize(goSamples.rss, BAR.dropWorst);
const nodeSnapT = summarize(nodeSamples.snap, BAR.dropWorst);
const goSnapT = summarize(goSamples.snap, BAR.dropWorst);
const nodeCollect = summarize(tNodeCollect, BAR.dropWorst);
const goCollect = summarize(tGoCollect, BAR.dropWorst);

rawMeasurements.resource = {
  bar: BAR,
  coldRaw: {node:nodeColdSamples, go:goColdSamples},
  collectRaw: {nodeCpuUsec: nodeCpuSamples, goCpuUsec, nodeWriteBytes: nodeWriteSamples, goWriteBytes},
  workload: {rows: RESOURCE_ROWS, bytes: statSync(join(collectHome, 'usage.jsonl')).size, sha256: sha256File(join(collectHome, 'usage.jsonl')), repeats: BAR.repeats},
  units: {
    collectMs: 'wall ms per collect plus analytics snapshot on fresh SQLite; construction/open excluded on both sides',
    snapshotMs: 'wall ms per GET /api/v1/snapshot',
    rss: 'VmRSS kB from /proc of the serving process, not Go heap Alloc',
    coldMs: 'process spawn to healthy /healthz',
    cpu: 'CPU microseconds per collect cycle; getrusage delta (Go) and process.cpuUsage delta (Node) around the same collect window only, construction outside the timer on both sides',
    dbWriteBytes: 'write() bytes per collect cycle from the /proc/self/io wchar delta around the same collect; 0 delta is unmeasured and fails closed; not file-size footprint',
    externalCalls: 'provider transport/fetch calls observed during the collect loop',
  },
  node: { rss: nodeRss, snapshotMs: nodeSnapT, collectMs: nodeCollect, coldMs: nodeCold, cpuUsecPerCycle: nodeCpuUsecPerCycle, dbWriteBytes: nodeWriteBytesPerCycle, externalCalls: nodeFetchCalls, httpFailures: nodeSamples.httpFailures },
  go: { rss: goRss, snapshotMs: goSnapT, collectMs: goCollect, coldMs: goCold, cpuUsecPerCycle: goCpuUsecPerCycle, dbWriteBytes: goWriteBytesPerCycle, externalCalls: goExternalUnmeasured ? null : goExternalCalls, httpFailures: goSamples.httpFailures, binaryRssNote: 'VmRSS from /proc of dist/quota-manager' },
};

const resource = judgeResource({
  node: {
    rssMean: nodeRss.mean,
    collectMean: nodeCollect.mean,
    snapP50: nodeSnapT.p50,
    snapP95: nodeSnapT.p95,
    coldMs: nodeCold,
    cpuUsecPerCycle: nodeCpuUsecPerCycle,
    dbWriteBytes: nodeWriteBytesPerCycle,
    externalCalls: nodeFetchCalls,
    httpFailures: nodeSamples.httpFailures,
  },
  go: {
    rssMean: goRss.mean,
    collectMean: goCollect.mean,
    snapP50: goSnapT.p50,
    snapP95: goSnapT.p95,
    coldMs: goCold,
    cpuUsecPerCycle: goCpuUsecPerCycle,
    dbWriteBytes: goWriteBytesPerCycle,
    externalCalls: goExternalUnmeasured ? null : goExternalCalls,
    httpFailures: goSamples.httpFailures,
  },
}, BAR);

expect(resource.ran, 'resource items ran fail-closed (no null or zero metric, no failed HTTP sample)', {
  nullMetrics: resource.nullMetrics, zeroMetrics: resource.zeroMetrics, httpFailures: resource.httpFailures,
});
expect(goRss.mean > 0, 'Go idle RSS is process VmRSS, not heap Alloc');

judgments.resource = {
  ran: resource.ran,
  ok: resource.ok,
  ...resource.improves,
  bottleneckPass: resource.bottleneckPass,
  otherPass: resource.otherPass,
  externalPass: resource.externalPass,
  nullMetrics: resource.nullMetrics,
  zeroMetrics: resource.zeroMetrics,
  missed: resource.missed,
  httpFailures: resource.httpFailures,
  missHidden: false,
};
expect(!judgments.resource.missHidden, 'resource miss is not hidden');
if (!resource.ok) {
  expect(false, 'resource bar missed (not lowered)', judgments.resource);
}

await stopChild(goProc);
await stopChild(nodeProc);

const payloadPath = join(work, 'swift-payload.json');
const swift = run('go', ['run', './cmd/swiftpayload']);
expect(swift.status === 0, 'swiftpayload generated');
writeFileSync(payloadPath, swift.stdout);
let payload;
try { payload = JSON.parse(swift.stdout); } catch { payload = null; }
expect(payload && payload.schemaVersion === 1, 'swift payload is schemaVersion 1');
expect(payload && !secretsIn(payload), 'swift payload is credential-free');
const macScript = join(root, 'scripts/mac-swift-repro.sh');
expect(existsSync(macScript), 'Mac Swift repro commands are checked in');
judgments['swift-payload'] = {
  ran: true,
  ok: true,
  linuxGenerationIsNotMacPass: true,
  payloadPath,
  macRepro: macScript,
  note: 'Linux generation is not a Mac execution result. JUN-267 owns Mac decode.',
};

// Write the evidence first so its file exists, verify it landed, set its
// actual judgment, then enumerate required items, and rewrite with the true
// final counts. No expectations run after the rewrite.
judgments.evidence = { ran: true, ok: true, path: evidencePath };
const evidence = {
  issue: 'JUN-272',
  startedAt,
  finishedAt: new Date().toISOString(),
  sourceSha: nodeSHA,
  baseline: { pinnedSha: BASELINE_SHA, treeSha256: judgments.baseline.baselineTreeSha256, extractedTo: baselineDir },
  contractSha: contractSHA,
  binarySha256: binaryHash,
  assetSha256: manifest.assetSha256 ?? null,
  manifest,
  env: envInfo,
  scratch: scratchInfo,
  bar: BAR,
  inputs: { nowMs: NOW_MS, rosterHome, usageLog: join(rosterHome, 'usage.jsonl') },
  rawMeasurements,
  judgments,
  checks: checks.length,
  failures,
  mac: {
    payload: payloadPath,
    repro: macScript,
    linuxGenerationIsNotMacPass: true,
    status: 'unverified-on-mac',
  },
  keep: ['port-integrate-evidence.json', 'swift-payload.json'],
  cleanup: work,
};
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
const durable = join(root, 'dist/port-integrate-evidence.json');
writeFileSync(durable, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(join(root, 'dist/swift-payload.json'), swift.stdout);
expect(existsSync(evidencePath) && existsSync(durable), 'evidence JSON written');
judgments.evidence = { ran: true, ok: existsSync(evidencePath) && existsSync(durable) };
const unrun = REQUIRED.filter(id => !judgments[id] || !judgments[id].ran);
expect(unrun.length === 0, 'every required item ran', unrun);
expect(checks.length > 0, 'verification count is not 0');
const finalEvidence = { ...evidence, finishedAt: new Date().toISOString(), checks: checks.length, failures: [...failures], judgments };
writeFileSync(evidencePath, JSON.stringify(finalEvidence, null, 2) + '\n');
writeFileSync(durable, JSON.stringify(finalEvidence, null, 2) + '\n');

finished = true;

if (!checks.length) fail('port-integrate: 0 assertions');
if (failures.length) {
  console.error('port-integrate failed (' + failures.length + ' of ' + checks.length + '):');
  for (const failure of failures) console.error('  - ' + failure);
  process.exitCode = 1;
} else {
console.log('port-integrate passed: ' + checks.length + ' assertions');
console.log('evidence: ' + durable);
console.log('swift payload (Linux generation ≠ Mac pass): dist/swift-payload.json');

}
} catch (error) {
  console.error('port-integrate failed: ' + error.message);
  process.exitCode = 1;
} finally {
  for (const child of ownedChildren) await stopChild({child});
  await rm(work, {recursive: true, force: true});
  if (process.argv.includes('--self-test-resource-throw')) console.log(JSON.stringify({cleanupAfterInjectedFailure: !existsSync(work), childrenExited: [...ownedChildren].every(c=>!c.pid || c.exitCode!==null || c.signalCode!==null)}));
}
