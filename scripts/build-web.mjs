#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertJsModuleSpecifiers, assertUiAssets } from './web-assets.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const fail = (msg) => { console.error(msg); process.exit(1); };
const tsc = join(root, 'node_modules/typescript/bin/tsc');
const r = spawnSync(process.execPath, [tsc, '-p', 'web/tsconfig.ui.json', '--pretty', 'false'], { cwd: root, encoding: 'utf8' });
if (r.status !== 0) fail(`tsc ui failed\n${r.stdout}\n${r.stderr}`);

const distUi = join(root, 'web/dist/ui');
mkdirSync(distUi, { recursive: true });
for (const name of ['index.html', 'style.css']) {
  cpSync(join(root, 'public', name), join(distUi, name));
}

// Flatten contract.js next to the UI modules so /app.js's ../contract.js is /contract.js.
const contractSrc = join(root, 'web/dist/contract.js');
try { if (statSync(contractSrc).size === 0) fail('empty contract.js'); }
catch { fail('missing build asset contract.js'); }
cpSync(contractSrc, join(distUi, 'contract.js'));

try {
  assertUiAssets(distUi);
  assertJsModuleSpecifiers(distUi);
} catch (err) {
  fail(err.message);
}
console.log('build-web ok');
