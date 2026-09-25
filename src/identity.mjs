import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 6);
async function object(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; } }

// Match the installed OpenCodex label contract, never the currently selected account.
export async function readIdentities(home, { claudeHome, claudeProfile, codexHome } = {}) {
  const [config, auth, native, profile, claude] = await Promise.all([
    object(join(home, 'config.json')), object(join(home, 'auth.json')),
    codexHome ? object(join(codexHome, 'auth.json')) : {},
    claudeProfile ? object(claudeProfile) : {},
    claudeHome ? object(join(claudeHome, '.credentials.json')) : {},
  ]);
  const labels = new Map(), plans = new Map();
  const add = (provider, label, id) => {
    if (['chatgpt','openai-multi'].includes(provider)) provider = 'openai';
    const key = `${provider}\0${label}`;
    labels.set(key, labels.has(key) && labels.get(key) !== id ? null : id);
  };
  add('openai', 'main', '__main__');
  for (const a of config.codexAccounts ?? []) {
    add('openai', /^p[a-f0-9]{6}$/.test(a.logLabel ?? '') ? a.logLabel : `p${digest(a.id)}`, a.id);
  }
  try {
    const token = native.tokens?.id_token ?? native.tokens?.access_token;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type;
    if (typeof plan === 'string') plans.set('openai\0__main__', plan);
  } catch { /* Optional local claim; missing plan remains unknown. */ }
  for (const [provider, set] of Object.entries(auth)) {
    for (const a of set.accounts ?? []) {
      if (typeof a.id !== 'string') continue;
      add(provider, provider === 'anthropic' ? `p${digest(a.id)}` : `o${digest(`${provider}\0${a.id}`)}`, a.id);
      // Bind profile metadata by physical account identity; a refresh changes access tokens.
      // Credential-only tier is usable only with an exact token match.
      if (provider === 'anthropic' && a.credential?.accountId && a.credential.accountId === profile.oauthAccount?.accountUuid) {
        const tier = profile.oauthAccount?.organizationRateLimitTier ??
          (a.credential.access && a.credential.access === claude.claudeAiOauth?.accessToken ? claude.claudeAiOauth?.rateLimitTier : null);
        if (typeof tier === 'string') plans.set(`${provider}\0${a.id}`, tier);
      }
    }
  }
  return { labels, plans };
}

export function attributeUsage(row, identities) {
  const raw = typeof row.provider === 'string' ? row.provider : 'unknown';
  const match = raw.match(/^(.*)-(main|[pko][a-f0-9]{6})$/);
  let provider = match ? match[1] : raw;
  if (['chatgpt', 'openai-multi'].includes(provider)) provider = 'openai';
  const label = row.accountLogLabel ?? match?.[2];
  // A bare provider name is not evidence of an account, even with a single account today.
  const account = label ? identities.labels.get(`${provider}\0${label}`) ?? null : null;
  return { provider, account };
}
