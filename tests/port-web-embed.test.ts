import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  REQUIRED_UI_ASSETS, assertJsModuleSpecifiers, assertSameHashes, assertUiAssets, assetHashes,
} from '../scripts/web-assets.ts';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('UI sources have no file-level @ts-nocheck', () => {
  for (const name of ['app.ts', 'quota.ts', 'views.ts', 'dom.ts', 'format.ts', 'types.ts']) {
    const src = readFileSync(join(root, 'web/src/ui', name), 'utf8');
    assert.doesNotMatch(src, /@ts-nocheck/, name);
  }
});

test('required modules and contract are in the Go allowlist', () => {
  const server = readFileSync(join(root, 'internal/httpserver/server.go'), 'utf8');
  for (const route of ['/app.js', '/format.js', '/quota.js', '/dom.js', '/views.js', '/types.js', '/contract.js', '/style.css']) {
    assert.match(server, new RegExp(route.replace('.', '\\.')), route);
  }
});

test('build:web emits required modules with .js specifiers', () => {
  const r = spawnSync(process.execPath, ['scripts/build-web.ts'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dist = join(root, 'web/dist/ui');
  assert.doesNotThrow(() => assertUiAssets(dist));
  assert.doesNotThrow(() => assertJsModuleSpecifiers(dist));
});

test('import-removal and stale-hash controls fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-web-control-'));
  try {
    for (const name of REQUIRED_UI_ASSETS) writeFileSync(join(dir, name), 'export {}\n');
    writeFileSync(join(dir, 'app.js'), "import {x} from './format';\n");
    assert.throws(() => assertJsModuleSpecifiers(dir), /extensionless/);
    const other = mkdtempSync(join(tmpdir(), 'quota-web-stale-'));
    try {
      for (const name of REQUIRED_UI_ASSETS) writeFileSync(join(other, name), 'export {}\n');
      writeFileSync(join(other, 'app.js'), '/* stale */\n');
      assert.throws(() => assertSameHashes(assetHashes(dir), assetHashes(other)), /mismatch|stale/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    rmSync(join(dir, 'views.js'));
    assert.throws(() => assertUiAssets(dir), /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
