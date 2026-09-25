#!/usr/bin/env node
// Port UI check: real Go binary + TS assets + existing Chrome harness.
// Node `npm run check:ui` success is not evidence for this gate.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture } from './ui-fixture.mjs';
import { openDashboard, SCREENS } from './ui-browser.mjs';
import {
  EXTENSIONLESS_404, REQUIRED_UI_ASSETS, STATIC_MODULE_ROUTES,
  assertJsModuleSpecifiers, assertSameHashes, assertUiAssets, assetHashes, syncEmbed,
} from './web-assets.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const checks = [];
const failures = [];
let finished = false;

function expect(condition, description, detail) {
  checks.push(description);
  if (!condition) {
    failures.push(detail === undefined ? description : description + ' — ' + JSON.stringify(detail));
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

process.on('exit', (code) => {
  if (finished) return;
  if (!checks.length) {
    console.error('port-ui: 0 assertions');
    process.exitCode = 1;
    return;
  }
  if (code === 0 && failures.length) process.exitCode = 1;
});

const run = (cmd, args, opts = {}) => {
  const p = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', ...opts });
  if (p.status !== 0) fail(`${cmd} ${args.join(' ')}\n${p.stdout}\n${p.stderr}`);
  return p;
};

run(process.execPath, ['scripts/build-web.mjs']);
const distUi = join(root, 'web/dist/ui');
assertUiAssets(distUi);
assertJsModuleSpecifiers(distUi);

const scratch = await mkdtemp(join(tmpdir(), 'quota-port-ui-'));
try {
  writeFileSync(join(scratch, 'app.js'), "import {x} from './format';\n");
  writeFileSync(join(scratch, 'format.js'), 'export const x = 1;\n');
  for (const name of REQUIRED_UI_ASSETS) {
    if (!existsSync(join(scratch, name))) writeFileSync(join(scratch, name), 'export {}\n');
  }
  let importRemoved = false;
  try { assertJsModuleSpecifiers(scratch); } catch { importRemoved = true; }
  expect(importRemoved, 'deliberate extensionless import is a failing control');

  const stale = await mkdtemp(join(tmpdir(), 'quota-port-stale-'));
  syncEmbed(distUi, stale);
  writeFileSync(join(stale, 'app.js'), '/* stale */\n');
  let staleFailed = false;
  try { assertSameHashes(assetHashes(distUi), assetHashes(stale)); } catch { staleFailed = true; }
  expect(staleFailed, 'stale embed hash is a failing control');
  await rm(stale, { recursive: true, force: true });

  const missing = await mkdtemp(join(tmpdir(), 'quota-port-missing-'));
  syncEmbed(distUi, missing);
  await rm(join(missing, 'views.js'), { force: true });
  let missingFailed = false;
  try { assertUiAssets(missing); } catch { missingFailed = true; }
  expect(missingFailed, 'missing required module is a failing control');
  await rm(missing, { recursive: true, force: true });
} catch (err) {
  fail('control setup: ' + err.message);
}

mkdirSync(join(root, 'dist'), { recursive: true });
const fixtureBin = join(root, 'dist/ui-fixture');
run('go', ['build', '-o', fixtureBin, './cmd/ui-fixture']);

const snapPath = join(scratch, 'snapshot.json');
writeFileSync(snapPath, JSON.stringify(buildFixture('default')));

let port = 18794;
const emptyDir = join(scratch, 'empty-public');
mkdirSync(emptyDir, { recursive: true });
const denied = spawnSync(fixtureBin, [], {
  cwd: root, encoding: 'utf8',
  env: { ...process.env, QUOTA_HOST: '127.0.0.1', QUOTA_PORT: String(port), QUOTA_FIXTURE_SNAPSHOT: snapPath, QUOTA_PUBLIC_DIR: emptyDir },
});
expect(denied.status !== 0, 'incomplete QUOTA_PUBLIC_DIR is fatal, not a silent embed fallback');

const pickPort = async () => {
  for (let n = 18794; n <= 18820; n++) {
    try {
      const res = await fetch('http://127.0.0.1:' + n + '/healthz', { signal: AbortSignal.timeout(200) });
      if (res.ok) continue;
    } catch {
      return n;
    }
  }
  fail('no free port in 18794-18820');
};
port = await pickPort();

const child = spawn(fixtureBin, [], {
  cwd: root,
  env: {
    ...process.env,
    QUOTA_HOST: '127.0.0.1',
    QUOTA_PORT: String(port),
    QUOTA_FIXTURE_SNAPSHOT: snapPath,
    QUOTA_PUBLIC_DIR: distUi,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const origin = 'http://127.0.0.1:' + port;

const waitHealth = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch { /* still starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  fail('fixture binary did not become healthy');
};

try {
  await waitHealth();
  for (const route of STATIC_MODULE_ROUTES) {
    const res = await fetch(origin + route);
    expect(res.status === 200, route + ' is 200 from the Go binary', res.status);
  }
  for (const route of EXTENSIONLESS_404) {
    const res = await fetch(origin + route);
    expect(res.status === 404, route + ' stays 404 so extensionless imports cannot load', res.status);
  }
  const snap = await (await fetch(origin + '/api/v1/snapshot')).json();
  expect(snap.schemaVersion === 1 && Array.isArray(snap.providers), 'snapshot handler returns the fixture');

  const page = await openDashboard({
    origin,
    fail: (msg) => expect(false, msg),
  });
  const { call, evaluate, settle, text, countOf, clickText, problems } = page;
  try {
    expect(await settle('document.querySelectorAll(".summary-provider").length || 0'), 'first render completes on TS assets');
    expect((await text('#title')) === '요약', 'summary title after first render');
    expect((await countOf('.quota-bar')) > 0, 'quota bars render from the Go snapshot');
    expect((await text('#content'))?.includes('사용량을 불러오는 중') !== true, 'loading state does not stick');

    for (const id of ['refresh', 'menu-toggle', 'search', 'period-picker', 'content', 'notice', 'providers', 'title', 'provider-order']) {
      expect(await evaluate('!!document.getElementById(' + JSON.stringify(id) + ')'), 'required control ' + id);
    }

    await clickText('#period-picker button', '30일');
    expect(await settle('document.querySelector(\'#period-picker button[aria-pressed="true"]\')?.dataset.period === "monthly"'),
      'summary period selection is independent');
    await clickText('#providers button', 'OpenAI');
    expect(await settle('document.getElementById("title")?.textContent === "OpenAI"'), 'provider view opens');
    expect(await evaluate('document.getElementById("period-picker").hidden'), 'provider toolbar hides summary period buttons');
    await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
    await evaluate(`(() => { const s=document.querySelector('.account-details .detail-period select'); if (!s) return false; s.focus(); s.value='oneHour'; s.dispatchEvent(new Event('change')); return true; })()`);
    expect(await evaluate(`document.querySelector('.account-details .detail-period select')?.value === 'oneHour'`),
      'account detail period is independent');
    expect(await evaluate(`[...document.querySelectorAll('.account-details .detail-period select')].slice(1).every(s=>s.value==='weekly')`),
      'changing one account leaves sibling details unchanged');

    await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
    const measuredZero = await evaluate('(() => { const acc = [...document.querySelectorAll(".account")]' +
      '.find(a => a.textContent.includes("장기 보관용"));' +
      ' const el = acc && acc.querySelector(\'.usage-totals .metric[data-period="weekly"]\'); if (!el) return null;' +
      ' return { amount: el.querySelector("strong").textContent, note: el.querySelector("small")?.textContent ?? "" }; })()');
    expect(measuredZero && measuredZero.amount === '$0.00' && /회 호출/.test(measuredZero.note),
      'measured zero stays a measured zero', measuredZero);

    await clickText('#providers button', 'Ollama Cloud');
    await settle('document.querySelectorAll(".account").length || 0');
    await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
    const unknown = await evaluate('(() => { const el = document.querySelector(\'.account-details .usage-totals .metric[data-period="monthly"]\');' +
      ' if (!el) return null; return { amount: el.querySelector("strong").textContent, note: el.querySelector("small")?.textContent ?? "" }; })()');
    expect(unknown && unknown.amount === '—' && /단가 미확인/.test(unknown.note),
      'unknown price is not converted to zero', unknown);

    await clickText('#providers button', '요약');
    await settle('document.querySelectorAll(".summary-provider").length || 0');
    const first = await evaluate('[...document.querySelectorAll("#provider-order-list .order-row span")].map(el => el.textContent)');
    await evaluate('document.querySelector("#provider-order-list button.order-move:not([disabled])")?.click()');
    const moved = await evaluate('[...document.querySelectorAll("#provider-order-list .order-row span")].map(el => el.textContent)');
    const stored = await evaluate('JSON.parse(localStorage.getItem("quota-monitor.provider-order.v1") || "[]")');
    expect(Array.isArray(first) && first.length > 1 && JSON.stringify(first) !== JSON.stringify(moved),
      'localStorage order editor actually reorders', { first, moved });
    expect(Array.isArray(stored) && stored.length === moved.length, 'order is written to the existing settings key', stored);

    await evaluate(`(() => { const original = window.fetch; window.__qmFetchHook = original;
      window.fetch = (input, init) => { if (String(input).includes('/api/v1/snapshot')) return Promise.reject(new TypeError('offline'));
      return original(input, init); }; })()`);
    await evaluate('document.getElementById("refresh").click()');
    expect(await settle('document.getElementById("notice") && !document.getElementById("notice").hidden && /이전/.test(document.getElementById("notice").textContent)'),
      'refresh failure keeps the previous snapshot');
    await evaluate('window.fetch = window.__qmFetchHook');
    await evaluate('document.getElementById("refresh").click()');
    expect(await settle('!document.getElementById("refresh").disabled'), 'refresh recovers after the hook is removed');
    expect(await settle('document.querySelectorAll(".summary-provider").length || 0'), 'recover still shows the summary');

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    expect(await settle('getComputedStyle(document.getElementById("menu-toggle")).display !== "none"'),
      'mobile viewport shows the menu toggle');
    await evaluate('document.getElementById("menu-toggle").click()');
    expect(await settle('document.getElementById("sidebar").classList.contains("open")'), 'drawer opens on mobile');
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    expect(await settle('!document.getElementById("sidebar").classList.contains("open")'), 'Escape closes the drawer');

    for (const problem of problems) failures.push(problem);
    expect(problems.length === 0, 'browser console stays clean on the Go binary', problems);
  } finally {
    await page.close();
  }
} finally {
  child.kill('SIGKILL');
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}

finished = true;
if (!checks.length) fail('port-ui: 0 assertions');
if (failures.length) {
  console.error('port-ui failed (' + failures.length + ' of ' + checks.length + '):');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('port-ui passed: ' + checks.length + ' assertions');
console.log('port-ui screens: ' + SCREENS);
