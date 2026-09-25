import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('integrate check is a documented command and not check:port or check:ui', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:port:integrate'], 'node scripts/check-port-integrate.mjs');
  assert.notEqual(pkg.scripts['check:port:integrate'], pkg.scripts['check:port']);
  assert.notEqual(pkg.scripts['check:port:integrate'], pkg.scripts['check:ui']);
  assert.notEqual(pkg.scripts['check:port:integrate'], pkg.scripts['check:port:ui']);
});

test('resource bar is locked before measurement and uses worst-2 not first-2', () => {
  const src = readFileSync(join(root, 'scripts/check-port-integrate.mjs'), 'utf8');
  const barIdx = src.indexOf('const BAR = Object.freeze');
  const measureIdx = src.indexOf('sampleProcess');
  assert.ok(barIdx >= 0 && measureIdx > barIdx, 'BAR must be declared before any measurement helper');
  const printed = spawnSync(process.execPath, ['scripts/check-port-integrate.mjs', '--print-bar'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(printed.status, 0, printed.stderr);
  const bar = JSON.parse(printed.stdout);
  assert.equal(bar.repeats, 7);
  assert.equal(bar.dropWorst, 2);
  assert.equal(bar.idleRssImprovePct, 15);
  assert.equal(bar.collectWallImprovePct, 15);
  assert.equal(bar.otherImprovePct, 5);
  assert.equal(bar.noExtraExternalReqs, true);
  assert.equal(bar.warmupRule, 'drop-worst-2');
  assert.equal(bar.notFirstTwo, true);
  assert.match(src, /missHidden/);
});

test('zero assertions and missing baseline are failed controls', () => {
  const zero = spawnSync(process.execPath, ['scripts/check-port-integrate.mjs', '--self-test-zero-checks'], {
    cwd: root, encoding: 'utf8',
  });
  assert.notEqual(zero.status, 0);
  assert.match(zero.stderr + zero.stdout, /0 assertions/);
  const src = readFileSync(join(root, 'scripts/check-port-integrate.mjs'), 'utf8');
  assert.match(src, /every required item ran/);
  assert.match(src, /resource bar missed/);
  assert.match(src, /linuxGenerationIsNotMacPass/);
});

test('Mac repro exists and refuses to record a Linux generation as a pass', () => {
  const script = join(root, 'scripts/mac-swift-repro.sh');
  assert.ok(existsSync(script));
  const body = readFileSync(script, 'utf8');
  assert.match(body, /Linux generation is not a Mac execution result/);
  const runbook = readFileSync(join(root, 'deploy/port-runbook.md'), 'utf8');
  assert.match(runbook, /check:port:integrate/);
  assert.match(runbook, /15%/);
});

const GO_ENV = {
  PATH: '/scratch/quota-manager/dev-port-verify/cbaf12c/go/bin:' + process.env.PATH,
  GOCACHE: '/scratch/quota-manager/dev-port-verify/cbaf12c/go-cache',
  GOMODCACHE: '/scratch/quota-manager/dev-port-verify/cbaf12c/go-mod',
  GOTOOLCHAIN: 'local',
  GOMAXPROCS: '4',
};

function runHarnessFlag(flag) {
  return spawnSync(process.execPath, ['scripts/check-port-integrate.mjs', flag], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
}

test('Node baseline is pinned to the cbaf12c git archive, not candidate HEAD', () => {
  const src = readFileSync(join(root, 'scripts/check-port-integrate.mjs'), 'utf8');
  assert.match(src, /cbaf12cca3a6ae8f70de37c47f22757381c47a49/,
    'harness must name the pinned baseline SHA');
  const extracted = runHarnessFlag('--self-test-baseline-extract');
  assert.equal(extracted.status, 0, extracted.stderr + extracted.stdout);
  const extract = JSON.parse(extracted.stdout);
  assert.equal(extract.baselineExtractOk, true, 'pinned baseline must extract from git archive and import');
  // The tree hash is the behavioral control: it proves the archive extraction
  // produced the known pre-port tree at cbaf12c, byte for byte, instead of
  // candidate HEAD sources.
  assert.equal(extract.baselineTreeSha256,
    '88eeaaa03f0c15a1b2083b5cbd821c5decc5bdf3cacd28cfcb34f253765af489');
});

test('a missing pinned baseline fails closed', () => {
  const src = readFileSync(join(root, 'scripts/check-port-integrate.mjs'), 'utf8');
  assert.match(src, /--self-test-missing-baseline/,
    'harness must expose a missing-baseline negative control');
  const p = runHarnessFlag('--self-test-missing-baseline');
  assert.equal(p.status, 0, p.stderr + p.stdout);
  const out = JSON.parse(p.stdout);
  assert.equal(out.missingBaselineFailsClosed, true);
});

test('a null resource metric fails the judgment instead of passing', () => {
  const src = readFileSync(join(root, 'scripts/check-port-integrate.mjs'), 'utf8');
  assert.match(src, /--self-test-null-metric/,
    'harness must expose a null-metric negative control');
  const p = runHarnessFlag('--self-test-null-metric');
  assert.equal(p.status, 0, p.stderr + p.stdout);
  const out = JSON.parse(p.stdout);
  assert.equal(out.nullMetricFailsClosed, true);
});

test('degraded cpu, db-write and external-request metrics fail the judgment', () => {
  const src = readFileSync(join(root, 'scripts/check-port-integrate.mjs'), 'utf8');
  assert.match(src, /--self-test-degraded-metric/,
    'harness must expose a degraded-metric negative control');
  const p = runHarnessFlag('--self-test-degraded-metric');
  assert.equal(p.status, 0, p.stderr + p.stdout);
  const out = JSON.parse(p.stdout);
  assert.equal(out.degradedMetricFailsClosed, true);
});

test('an HTTP failure during sampling fails the resource judgment', () => {
  const src = readFileSync(join(root, 'scripts/check-port-integrate.mjs'), 'utf8');
  assert.match(src, /--self-test-http-failure/,
    'harness must expose an HTTP-failure negative control');
  const p = runHarnessFlag('--self-test-http-failure');
  assert.equal(p.status, 0, p.stderr + p.stdout);
  const out = JSON.parse(p.stdout);
  assert.equal(out.httpFailureFailsClosed, true);
});

test('production binary handoff is the primary DB roundtrip in the harness', () => {
  const src = readFileSync(join(root, 'scripts/check-port-integrate.mjs'), 'utf8');
  const binaryIdx = src.indexOf('binary-handoff');
  const helperIdx = src.indexOf("mode: 'db-write'");
  assert.ok(binaryIdx > 0, 'harness must include a binary-handoff required item');
  assert.ok(helperIdx > binaryIdx,
    'the port-harness store helper roundtrip must come after the real binary handoff');
  const required = src.match(/const REQUIRED = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(required, 'REQUIRED list must exist');
  assert.match(required[1], /'binary-handoff'/);
});

test('perfcompare binds an ephemeral port and refuses to exit 0 on HTTP errors', () => {
  const src = readFileSync(join(root, 'cmd/perfcompare/main.go'), 'utf8');
  assert.doesNotMatch(src, /18793/, 'perfcompare must not bind a fixed port');
  assert.match(src, /net\.Listen\("tcp", "127\.0\.0\.1:0"\)/,
    'perfcompare must grab an ephemeral port');
  assert.match(src, /measurementFailed/, 'HTTP failures must mark the report failed');
  const built = spawnSync('go', ['run', './cmd/perfcompare'], {
    cwd: root, encoding: 'utf8', timeout: 300000, env: { ...process.env, ...GO_ENV },
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  const report = JSON.parse(built.stdout);
  assert.ok(report.snapshotP50Ms > 0, 'snapshot p50 must be a real measurement');
  assert.equal(report.missHidden, false);
  assert.ok(report.httpGets >= 7);
});

test('missing or invalid raw samples cannot be filtered into a passing mean', () => {
 const p=runHarnessFlag('--self-test-incomplete-samples');
 assert.equal(p.status,0,p.stderr+p.stdout);
 assert.equal(JSON.parse(p.stdout).incompleteSamplesFailClosed,true);
});
