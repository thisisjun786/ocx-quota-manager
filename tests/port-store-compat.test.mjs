import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('Go-written history.sqlite is readable by Node sqlite with usage and meta intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qm-store-'));
  const run = spawnSync('go', ['run', './cmd/history-fixture', dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const db = new DatabaseSync(join(dir, 'history.sqlite'));
  const row = db.prepare('SELECT id, provider, usd FROM usage').get();
  assert.equal(row.id, 'n1');
  assert.equal(row.provider, 'openai');
  assert.equal(row.usd, 2.5);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const name of ['meta','usage','samples','quota_observations','identity_epochs','price_evidence','usage_prices']) {
    assert.ok(tables.includes(name), name);
  }
  db.close();
});
