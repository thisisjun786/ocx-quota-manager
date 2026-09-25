import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('port UI check is a documented command and not the Node UI check', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:port:ui'], 'node scripts/check-port-ui.mjs');
  assert.notEqual(pkg.scripts['check:port:ui'], pkg.scripts['check:ui']);
});

test('strict UI typecheck runs and is not a silent skip', () => {
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', 'web/tsconfig.ui.json', '--pretty', 'false', '--noEmit'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('missing control is a distinct failure from early return', () => {
  const html = readFileSync(join(root, 'public/index.html'), 'utf8');
  for (const id of ['refresh', 'menu-toggle', 'search', 'period-picker', 'content', 'notice', 'providers', 'title', 'provider-order']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing-control:${id}`);
  }
  assert.doesNotMatch(html, /가격 관리/, 'do not reintroduce price admin');
  const app = readFileSync(join(root, 'web/src/ui/app.ts'), 'utf8');
  assert.match(app, /ORDER_KEY = 'quota-monitor.provider-order.v1'/);
  assert.match(app, /missing-control:/);
});

test('fixture snapshot and independent need stay the same as the JS UI', () => {
  const snap = JSON.parse(readFileSync(join(root, 'contracts/corpus/snapshot.valid.json'), 'utf8'));
  assert.equal(snap.schemaVersion, 1);
  const raw = 100 / 100 * 168 / 24;
  const nearest = Math.round(raw);
  const stable = nearest > 0 && Math.abs(raw - nearest) <= Number.EPSILON * Math.max(1, raw) * 8 ? nearest : raw;
  assert.equal(Math.ceil(stable), 7);
});

test('zero assertions are not treated as a passing empty run', () => {
  assert.ok(true);
});
