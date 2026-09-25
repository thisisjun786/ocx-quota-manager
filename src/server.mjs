import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSnapshot } from './snapshot.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const FILES = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/format.js', ['format.js', 'text/javascript']], ['/quota.js', ['quota.js', 'text/javascript']], ['/dom.js', ['dom.js', 'text/javascript']], ['/views.js', ['views.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);

export function createApp({ host = '127.0.0.1', port = 8787, publicOrigin = null, snapshot = () => readSnapshot(process.env.OPENCODEX_HOME || undefined, Date.now(), process.env.QUOTA_CODEX_HOME || process.env.CODEX_HOME || undefined) } = {}) {
  const external = publicOrigin ? new URL(publicOrigin) : null;
  if (external && (host !== '127.0.0.1' || external.protocol !== 'https:' || !external.hostname.endsWith('.ts.net') || external.pathname !== '/' || external.search || external.hash || external.username || external.password)) throw new Error('Use a Tailscale HTTPS origin with a loopback backend');
  let flight;
  let last;
  let lastRead = 0;
  async function data() {
    if (last && Date.now() - lastRead < 1000) return last;
    if (!flight) flight = snapshot().then(value => { last = value; lastRead = Date.now(); return value; }).finally(() => { flight = null; });
    return flight;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const actualPort = server.address()?.port ?? port;
    const expectedHost = `${host}:${actualPort}`;
    const isProxy = external && ['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress);
    const allowedHosts = [expectedHost, ...(isProxy ? [external.host] : [])];
    const allowedOrigins = [`http://${expectedHost}`, ...(isProxy ? [external.origin] : [])];
    if (!allowedHosts.includes(req.headers.host)) return json(403, { error: '허용되지 않은 주소입니다.' });
    if ((req.headers.origin && !allowedOrigins.includes(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: '다른 사이트의 요청은 허용하지 않습니다.' });
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return json(405, { error: '조회만 지원합니다.' }); }
    // Match the raw path: encoded traversal and arbitrary files never reach the filesystem.
    const route = req.url?.split('?')[0];
    if (route === '/healthz') return json(200, { status: 'ok' });
    if (route === '/api/v1/snapshot') {
      try { return json(200, await data()); }
      catch { return json(503, { error: 'OpenCodex 정보를 읽지 못했습니다. 잠시 후 다시 시도해 주세요.' }); }
    }
    const entry = FILES.get(route);
    if (!entry) return json(404, { error: '페이지를 찾을 수 없습니다.' });
    try {
      const body = await readFile(join(PUBLIC, entry[0]));
      res.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8` }); res.end(body);
    } catch { json(503, { error: '화면을 불러오지 못했습니다.' }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.QUOTA_HOST ?? '127.0.0.1';
  const port = Number(process.env.QUOTA_PORT ?? 8787);
  const octets = host.split('.').map(Number);
  const tailnet = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  if ((host !== '127.0.0.1' && !tailnet) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use loopback or a Tailscale IPv4 and an unprivileged port');
  const { startCollectorRuntime } = await import('./collector-runtime.mjs');
  const opencodexHome = process.env.OPENCODEX_HOME ?? join(homedir(), '.opencodex');
  const collector = startCollectorRuntime({
    home: opencodexHome,
    codexHome: process.env.QUOTA_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    claudeHome: process.env.QUOTA_CLAUDE_HOME ?? join(homedir(), '.claude'),
    claudeProfile: process.env.QUOTA_CLAUDE_PROFILE ?? join(homedir(), '.claude.json'),
    managementOrigin: process.env.QUOTA_OPENCODEX_ORIGIN ?? null,
    claudeCacheTtl: process.env.QUOTA_CLAUDE_CACHE_TTL ?? '5m',
    claudeCacheFrom: process.env.QUOTA_CLAUDE_CACHE_FROM ?? null,
    dataDir: process.env.QUOTA_DATA_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'quota-monitor'),
    storage: {
      retentionDays: Number(process.env.QUOTA_RETENTION_DAYS ?? 90),
      maxBytes: Number(process.env.QUOTA_DB_MAX_MIB ?? 512) * 1024 * 1024,
    },
    // Direct provider reads are off unless QUOTA_DIRECT_PROVIDERS names providers. With it
    // unset these are the same empty list and null hook createCollector defaults to, so an
    // existing install fetches nothing and publishes exactly what it published before.
    directProviders:process.env.QUOTA_DIRECT_PROVIDERS ?? '',
  });
  const server = createApp({ host, port, publicOrigin: process.env.QUOTA_PUBLIC_ORIGIN ?? null, snapshot: () => collector.snapshot() });
  server.on('error', error => { console.error('quota-monitor:', error.code ?? 'server error'); void collector.close().finally(() => { process.exitCode = 1; }); });
  server.listen(port, host, () => console.log(`Quota Monitor http://${host}:${port}`));
  const close = () => { server.close(() => { void collector.close().then(() => process.exit(0), () => process.exit(1)); }); setTimeout(() => process.exit(1), 10000).unref(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
