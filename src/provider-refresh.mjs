import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { projectQuotaAccount } from './snapshot.mjs';
import { MINUTE, expired } from './time.mjs';
const fingerprint = value => createHash('sha256').update(value).digest('hex');
const key = (provider, account) => `providerLiveV1:${provider}:${account}`;
const ANTHROPIC_INTERVAL_MS = 2 * MINUTE;
const sameBindings = (left, right) => left?.size === right?.size && [...left].every(([id, binding]) => right.get(id) === binding);
const selected = (provider, include, exclude) => (include === null || include.has(provider)) && !exclude.has(provider);

export function createProviderRefresh({ home, codexHome, store, origin = null, now = Date.now, fetcher = fetch, includeProviders = null, excludeProviders = [] }) {
  if (origin) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('OpenCodex management must use an explicit loopback origin');
    origin = url.origin;
  }
  const include = includeProviders === null ? null : new Set(includeProviders);
  const exclude = new Set(excludeProviders);
  let published = { jobs: [], failed: false }, pending, flight;
  const retries = new Map();
  function collect() {
    if (!origin) return;
    if (flight) return flight;
    flight = (async () => {
      const next = { jobs: [], failed: false }, updates = [];
      try {
      const [config, auth, token, native] = await Promise.all([
        readFile(join(home,'config.json'),'utf8').then(JSON.parse),
        readFile(join(home,'auth.json'),'utf8').then(JSON.parse),
        readFile(join(home,'admin-api-token'),'utf8').then(v => v.trim()),
        codexHome ? readFile(join(codexHome,'auth.json'),'utf8').then(JSON.parse).catch(()=>({})) : {},
      ]);
      if (!/^ocx_admin_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Management authentication unavailable');
      for (const [provider,p] of Object.entries(config.providers ?? {})) {
        if (!p || p.disabled || provider === 'ollama-cloud') continue; // Ollama's own probe also records model counters.
        if (!selected(provider, include, exclude)) continue;
        if (provider === 'openai') {
          const bindings = new Map((config.codexAccounts ?? []).map(a=>[a.id,fingerprint(provider+'\0'+a.id)]));
          if (native.tokens?.account_id) bindings.set('__main__',fingerprint(provider+'\0'+native.tokens.account_id));
          next.jobs.push({ provider, kind:'oauth', bindings, path:'/api/codex-auth/accounts?refresh=1' });
        }
        else if (auth[provider]?.accounts?.length) {
          const bindings = new Map(auth[provider].accounts.map(a=>[a.id,fingerprint(provider+'\0'+(a.credential?.accountId ?? a.id))]));
          const retry = retries.get(provider);
          if (provider === 'anthropic' && retry && !sameBindings(retry.bindings, bindings)) retries.delete(provider);
          const previous = published.jobs.find(job => job.provider === provider && job.kind === 'oauth');
          if (provider === 'anthropic' && retry && sameBindings(retry.bindings, bindings) && now() < retry.until && previous && sameBindings(previous.bindings, bindings)) {
            next.jobs.push({ ...previous, bindings, seen: new Set(previous.seen), skipped: true });
            if (previous.failed) next.failed = true;
          } else next.jobs.push({ provider, kind:'oauth', bindings, path:`/api/oauth/accounts?provider=${encodeURIComponent(provider)}&quota=1&refresh=1` });
        }
        if (p.apiKey || p.apiKeyPool?.length) {
          const ids = new Map((p.apiKeyPool ?? []).map(k => [k.id,`key:${k.id}`]));
          const bindings = new Map((p.apiKeyPool ?? []).filter(k=>typeof k.key==='string').map(k=>[`key:${k.id}`,fingerprint(provider+'\0'+k.key)]));
          // Exact installed OpenCodex projection for a legacy bare API key, not an active-account guess.
          if (!p.apiKeyPool?.length && typeof p.apiKey === 'string') {ids.set(fingerprint(p.apiKey).slice(0,8),'key:default');bindings.set('key:default',fingerprint(provider+'\0'+p.apiKey));}
          next.jobs.push({ provider, kind:'key', ids, bindings, path:`/api/providers/keys?name=${encodeURIComponent(provider)}&quota=1&refresh=1` });
        }
      }
      pending = next.jobs;
      await Promise.all(next.jobs.filter(job => !job.skipped).map(async job => {
        job.seen = new Set();
        job.unavailable = new Set();
        job.lastAttemptAt = now();
        try {
          const res = await fetcher(origin+job.path,{ headers:{Accept:'application/json',Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(20000) });
          if (!res.ok) throw new Error('Provider refresh failed');
          if (Number(res.headers?.get?.('content-length')) > 2*1024*1024) throw new Error('Oversized response');
          const raw = await res.text();if (raw.length > 2*1024*1024) throw new Error('Oversized response');
          const body = JSON.parse(raw), rows = body[job.kind === 'key' ? 'keys' : 'accounts'];
          if (!Array.isArray(rows)) throw new Error('Invalid quota response');
          for (const row of rows) {
            if (!row || typeof row.id !== 'string') continue;
            const id = job.kind === 'key' ? job.ids.get(row.id) : row.id;
            if (!id || !job.bindings.has(id)) continue;
            const binding = job.bindings.get(id);
            job.seen.add(id);
            const value = projectQuotaAccount(id,'',null,false,row.quota,now(),{reauth:row.needsReauth === true});
            const saved = store.get(key(job.provider,id));
            const existing = saved?.binding === binding ? saved : null;
            const stamp = Date.parse(value.updatedAt);
            const unavailable = row.quotaUnavailable === true || row.needsReauth === true || !value.windows.length || !Number.isFinite(stamp) || stamp > now()+60000;
            if (unavailable) {
              job.unavailable.add(id);
              updates.push([key(job.provider,id),{ binding, updatedAt:existing?.updatedAt ?? null,
                windows:existing?.windows ?? [],
                status:row.needsReauth === true?'reauth':'unavailable', quotaMode:row.quotaMode ?? 'unsupported' }]);
            } else if (!existing?.updatedAt || stamp >= Date.parse(existing.updatedAt)) {
              updates.push([key(job.provider,id),{ binding, updatedAt:value.updatedAt,windows:value.windows,status:value.status,quotaMode:row.quotaMode ?? 'probe' }]);
            }
          }
        } catch { job.failed = true; next.failed = true; }
      }));
      for (const job of next.jobs) {
        if (job.provider !== 'anthropic' || job.kind !== 'oauth' || job.skipped) continue;
        const complete = job.seen.size === job.bindings.size;
        const retry = retries.get(job.provider);
        if (job.failed || !complete || job.unavailable.size) {
          const failures = sameBindings(retry?.bindings, job.bindings) ? Math.min(3,retry.failures+1) : 1;
          retries.set(job.provider,{ bindings: job.bindings, failures, until: now() + Math.min(8 * MINUTE,2 ** failures * MINUTE) });
        } else retries.set(job.provider,{ bindings: job.bindings, failures: 0, until: now() + ANTHROPIC_INTERVAL_MS });
      }
      store.db.exec('BEGIN');
      try {
        for (const [name, value] of updates) store.set(name, value);
        store.db.exec('COMMIT');
      } catch (error) {
        if (store.db.isTransaction) store.db.exec('ROLLBACK');
        throw error;
      }
      } catch { next.failed = true; for (const job of next.jobs) job.failed = true; }
      published = next;
    })().finally(() => { pending = undefined; flight = null; });
    return flight;
  }
  function enrich(snapshot) {
    if (!origin) return snapshot;
    for (const p of snapshot.providers) for (const a of p.accounts) {
      if (p.id === 'ollama-cloud' || !p.enabled || !selected(p.id, include, exclude)) continue;
      if (['reauth','paused'].includes(a.status)) continue;
      const match = j => j.provider === p.id && (a.id.startsWith('key:') ? j.kind==='key' : j.kind==='oauth');
      const job = published.jobs.find(match);
      const current = pending ? pending.find(match) : job;
      const saved = store.get(key(p.id,a.id));
      const value = saved?.binding && saved.binding === current?.bindings.get(a.id) ? saved : null;
      const jobApplies = job && job.bindings.get(a.id) === current?.bindings.get(a.id);
      const unavailable = !jobApplies || job.failed || !job.seen?.has(a.id) || job.unavailable?.has(a.id);
      const retry = retries.get(p.id);
      a.refresh = {
        status: unavailable ? 'delayed' : 'ok',
        lastAttemptAt: jobApplies && Number.isFinite(job.lastAttemptAt) ? new Date(job.lastAttemptAt).toISOString() : null,
        nextAttemptAt: retry && sameBindings(retry.bindings,current?.bindings) ? new Date(retry.until).toISOString() : null,
      };
      const savedAt = Date.parse(value?.updatedAt) || 0;
      const sourceAt = Date.parse(a.updatedAt) || 0;
      const savedApplies = value && savedAt >= sourceAt;
      if (savedApplies) {
        a.updatedAt = value.updatedAt;
        // Freshness belongs to the measurement, independently of the latest lookup.
        // Recompute it to recover recent rows marked stale by older collectors.
        const measuredAt = Date.parse(value.updatedAt);
        const outdated = expired(measuredAt, now());
        a.windows = value.windows.map(w => {
          const resetAt = w.resetAt ? Date.parse(w.resetAt) : null;
          return {...w, stale:value.status === 'reauth' || outdated || (resetAt !== null && (!Number.isFinite(resetAt) || resetAt <= now()))};
        });
        a.status = value.status === 'reauth' ? 'reauth' : a.windows.length ? a.windows.some(w=>w.stale)?'stale':'ok' : 'unavailable';
        a.quotaMode = a.windows.length ? 'observed' : 'unavailable';
      }
    }
    if (published.failed) snapshot.warnings.push('일부 프로바이더의 자동 조회에 실패했습니다. 마지막 측정값을 표시합니다.');
    return snapshot;
  }
  return {collect,enrich};
}
