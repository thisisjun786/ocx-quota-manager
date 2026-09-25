import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_UI_ASSETS = [
  'app.js', 'format.js', 'quota.js', 'dom.js', 'views.js',
  'types.js', 'contract.js', 'index.html', 'style.css',
];

export const STATIC_MODULE_ROUTES = [
  '/', '/index.html', '/app.js', '/format.js', '/quota.js', '/dom.js',
  '/views.js', '/types.js', '/contract.js', '/style.css',
];

export const EXTENSIONLESS_404 = ['/format', '/quota', '/dom', '/views', '/contract', '/types'];

const fail = (msg: string): never => {
  throw new Error(msg);
};

export function assertUiAssets(dir) {
  for (const name of REQUIRED_UI_ASSETS) {
    const p = join(dir, name);
    if (!existsSync(p)) fail(`missing build asset ${name}`);
    if (statSync(p).size === 0) fail(`empty ${name}`);
  }
}

export function assertJsModuleSpecifiers(dir) {
  for (const name of REQUIRED_UI_ASSETS.filter(n => n.endsWith('.js'))) {
    const src = readFileSync(join(dir, name), 'utf8');
    if (/from\s+['"]\.\.?\/[A-Za-z0-9_-]+['"]/.test(src)) {
      fail(`extensionless import in ${name}`);
    }
  }
}

export function assetHashes(dir) {
  const out = {};
  for (const name of REQUIRED_UI_ASSETS) {
    out[name] = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  }
  return out;
}

export function assertSameHashes(left, right) {
  for (const name of REQUIRED_UI_ASSETS) {
    if (!left[name] || !right[name]) fail(`hash missing ${name}`);
    if (left[name] !== right[name]) fail(`stale or mismatched asset ${name}`);
  }
}

export function syncEmbed(src, dst) {
  assertUiAssets(src);
  assertJsModuleSpecifiers(src);
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(dst)) {
    rmSync(join(dst, name), { recursive: true, force: true });
  }
  for (const name of REQUIRED_UI_ASSETS) {
    cpSync(join(src, name), join(dst, name));
  }
  assertUiAssets(dst);
  assertSameHashes(assetHashes(src), assetHashes(dst));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'verify') {
      const dir = a || join(root, 'web/dist/ui');
      assertUiAssets(dir);
      assertJsModuleSpecifiers(dir);
      console.log('web-assets verify ok');
    } else if (cmd === 'sync') {
      const src = a || join(root, 'web/dist/ui');
      const dst = b || join(root, 'webembed/static');
      syncEmbed(src, dst);
      console.log('web-assets sync ok');
    } else if (cmd === 'compare') {
      assertSameHashes(assetHashes(a), assetHashes(b));
      console.log('web-assets compare ok');
    } else {
      fail('usage: web-assets.ts verify|sync|compare');
    }
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}
