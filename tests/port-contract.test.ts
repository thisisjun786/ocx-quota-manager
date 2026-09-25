import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rec = JSON.parse(await readFile(new URL('../contracts/corpus/recommendation.json', import.meta.url), 'utf8'));
const valid = JSON.parse(await readFile(new URL('../contracts/corpus/snapshot.valid.json', import.meta.url), 'utf8'));
const defects = JSON.parse(await readFile(new URL('../contracts/corpus/known-defects.json', import.meta.url), 'utf8'));
const http = JSON.parse(await readFile(new URL('../contracts/corpus/http-guard.json', import.meta.url), 'utf8'));

test('independent recommendation arithmetic matches the locked corpus', () => {
  for (const c of rec.cases) {
    if (!c.needed) {
      assert.equal(c.allocateGapIntoSelected, false);
      continue;
    }
    const raw = c.sumPp / 100 * c.capacityHours / c.periodHours;
    const nearest = Math.round(raw);
    const stable = nearest > 0 && Math.abs(raw - nearest) <= Number.EPSILON * Math.max(1, raw) * 8 ? nearest : raw;
    assert.equal(Math.ceil(stable), c.needed, c.id);
  }
});

test('valid snapshot keeps measured zero and explicit nulls', () => {
  assert.equal(valid.schemaVersion, 1);
  assert.equal(valid.providers[0].accounts[0].windows[0].remainingPercent, 0);
  assert.equal(valid.providers[1].accounts[0].plan, null);
  assert.equal(valid.providers[1].analytics.modelPrices[1].rates.input, null);
  assert.notEqual(valid.providers[1].analytics.modelPrices[1].rates.input, 0);
});

test('known defects stay tagged and are not treated as fixtures', () => {
  assert.ok(defects.defects.some(d => d.id === 'JUN-226'));
  assert.match(defects.comment, /Never use as a passing golden/);
});

test('HTTP guard corpus lists bind, origin, method and snapshot-path rules', () => {
  assert.ok(http.bind.deny.includes('0.0.0.0'));
  assert.ok(http.requests.deny.some(r => r.secFetchSite === 'cross-site'));
  assert.match(http.snapshotPath.rule, /last fully projected public DTO/);
});

test('typescript is a declared devDependency so typecheck cannot silently skip', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.devDependencies.typescript, '5.6.3');
  assert.equal(pkg.scripts['check:port'], 'node scripts/check-port.ts');
});
