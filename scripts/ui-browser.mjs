// The headless-Chrome session the dashboard checks share. Moved here from scripts/ui-check.mjs
// so the whole check and the single-route check drive the same browser the same way.
import { createApp } from '../src/server.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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
  const listeners = [];
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
export async function openDashboard({ snapshot, fail, origin: givenOrigin } = {}) {
  let server = null;
  let origin = givenOrigin;
  if (!origin) {
    server = createApp({ snapshot: async () => snapshot });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  const profile = await mkdtemp(join(tmpdir(), 'quota-ui-check-'));
  const child = spawn(chromePath(), ['--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--window-size=1280,1800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browser;
  try {
    browser = await connect(await devtoolsEndpoint(child));
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => browser.send(method, params, sessionId);
    const problems = [];
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
      if (!clicked) fail('could not click ' + selector + ' labelled ' + label);
      return clicked;
    };
    const close = async () => {
      browser?.close();
      child.kill('SIGKILL');
      server?.close();
      await rm(profile, { recursive: true, force: true });
    };
    return { call, evaluate, settle, text, countOf, clickText, problems, origin, close };
  } catch (error) {
    // A half-open session must not reach the caller. Tear down what started, then rethrow.
    browser?.close();
    child.kill('SIGKILL');
    server?.close();
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
