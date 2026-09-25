// The headless-Chrome session the dashboard checks share. Moved here from scripts/ui-check.ts
// so the whole check and the single-route check drive the same browser the same way.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function chromePath() {
  return process.env.QUOTA_UI_CHECK_CHROME
    || (existsSync('/usr/local/bin/google-chrome') ? '/usr/local/bin/google-chrome' : null)
    || playwrightShell()
    || 'chromium';
}

// The newest Playwright headless shell in the user's cache, if one is installed.
function playwrightShell() {
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse();
  for (const d of dirs) {
    const bin = join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(bin)) return bin;
  }
  return null;
}

export const CHROME = chromePath();
// 대표 화면을 남길 곳. 저장소 밖이 기본이라 검사를 돌렸다고 작업 트리가 바뀌지 않는다.
export const SCREENS = process.env.QUOTA_UI_CHECK_SHOTS ?? join(tmpdir(), 'quota-ui-check-screens');

async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await once(socket, 'open');
  const pending = new Map();
  const listeners: any[] = [];
  let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else for (const listener of listeners) listener(message);
  });
  const send = (method, params = {}, sessionId) => {
    const id = ++sequence;
    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, message =>
      message.error ? reject(new Error(method + ': ' + message.error.message)) : resolve(message.result)));
  };
  return { send, on: listener => listeners.push(listener), close: () => socket.close() };
}

async function devtoolsEndpoint(child) {
  let buffered = '';
  for await (const chunk of child.stderr) {
    buffered += String(chunk);
    const match = /ws:\/\/[^\s]+/.exec(buffered);
    if (match) return match[0];
  }
  throw new Error('Chromium did not report a DevTools endpoint');
}

// fail() is where clickText records a miss. This module counts nothing and judges nothing:
// the caller keeps its own failures array and its own expect().
const repo = fileURLToPath(new URL('..', import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as import('node:net').AddressInfo;
      probe.close(() => resolve(port));
    }).on('error', reject);
  });
}

// The Go fixture server (cmd/ui-fixture) serves the embedded UI and re-reads the snapshot
// file on every request. publish() writes the caller's current snapshot object to that file,
// so a check that mutates the object calls publish() before the page next asks for it.
async function startFixtureServer(snapshot) {
  // The Go binary embeds webembed/static, so the checked UI is the current web/ source.
  for (const args of [['scripts/build-web.ts'], ['scripts/web-assets.ts', 'sync', 'web/dist/ui', 'webembed/static']]) {
    const step = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8' });
    if (step.status !== 0) throw new Error(args[0] + ' failed: ' + step.stderr + step.stdout);
  }
  const dir = await mkdtemp(join(tmpdir(), 'quota-ui-fixture-'));
  const bin = join(dir, 'ui-fixture');
  const built = spawnSync('go', ['build', '-o', bin, './cmd/ui-fixture'], { cwd: repo, encoding: 'utf8' });
  if (built.status !== 0) throw new Error('go build ./cmd/ui-fixture failed: ' + built.stderr);
  const file = join(dir, 'snapshot.json');
  const publish = () => writeFileSync(file, JSON.stringify(snapshot));
  publish();
  const port = await freePort();
  const child = spawn(bin, [], {
    cwd: repo, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, QUOTA_HOST: '127.0.0.1', QUOTA_PORT: String(port), QUOTA_FIXTURE_SNAPSHOT: file },
  });
  const origin = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 50));
    if (i === 99) { child.kill('SIGKILL'); throw new Error('ui-fixture did not start'); }
  }
  return { origin, publish, close: async () => { child.kill('SIGTERM'); await rm(dir, { recursive: true, force: true }); } };
}

// fail() is where clickText records a miss. This module counts nothing and judges nothing:
// the caller keeps its own failures array and its own expect().
export async function openDashboard({ snapshot, fail, origin: givenOrigin }: { snapshot?: any; fail?: (message: string) => void; origin?: string } = {}) {
  let server: Awaited<ReturnType<typeof startFixtureServer>> | null = null;
  let origin = givenOrigin;
  if (!origin) {
    server = await startFixtureServer(snapshot);
    origin = server.origin;
  }
  const profile = await mkdtemp(join(tmpdir(), 'quota-ui-check-'));
  const child = spawn(chromePath(), ['--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--window-size=1280,1800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browser;
  try {
    browser = await connect(await devtoolsEndpoint(child));
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method: string, params?: object) => browser.send(method, params, sessionId);
    const problems: any[] = [];
    browser.on(message => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.exceptionThrown') {
        problems.push('exception: ' + (message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text));
      }
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
        problems.push('console.' + message.params.type + ': ' + message.params.args.map(a => a.description ?? a.value).join(' '));
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        problems.push('log: ' + message.params.entry.text + ' ' + (message.params.entry.url ?? ''));
      }
    });
    await call('Runtime.enable');
    await call('Log.enable');
    await call('Page.enable');
    await call('Page.navigate', { url: origin + '/' });

    const evaluate = async expression => {
      const { result, exceptionDetails } = await call('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) throw new Error(expression + ' -> ' + (exceptionDetails.exception?.description ?? exceptionDetails.text));
      return result.value;
    };
    const settle = async (expression, attempts = 60) => {
      for (let i = 0; i < attempts; i++) {
        const value = await evaluate(expression).catch(() => null);
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return null;
    };
    const text = selector => evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent ?? null');
    const countOf = selector => evaluate('document.querySelectorAll(' + JSON.stringify(selector) + ').length');
    const clickText = async (selector, label) => {
      const clicked = await evaluate('(() => { const el = [...document.querySelectorAll(' + JSON.stringify(selector) +
        ')].find(node => node.textContent.trim().startsWith(' + JSON.stringify(label) + ')); if (!el) return false; el.click(); return true; })()');
      if (!clicked) fail?.('could not click ' + selector + ' labelled ' + label);
      return clicked;
    };
    const close = async () => {
      browser?.close();
      child.kill('SIGKILL');
      await server?.close();
      await rm(profile, { recursive: true, force: true });
    };
    const publish = () => server?.publish();
    return { call, evaluate, settle, text, countOf, clickText, problems, origin, close, publish };
  } catch (error: any) {
    // A half-open session must not reach the caller. Tear down what started, then rethrow.
    browser?.close();
    child.kill('SIGKILL');
    await server?.close();
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
