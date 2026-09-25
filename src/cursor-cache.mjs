const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

// Store valuation coefficients, never pretend the assumed cache tokens were measured.
export function priceCursorCache(row, price) {
  const base = price(row), u = row?.usage;
  const provider = typeof row?.provider === 'string' ? row.provider.replace(/-(?:main|[pko][a-f0-9]{6})$/, '') : '';
  if (provider !== 'cursor' || !u || !valid(base.usd) || !valid(u.inputTokens) ||
      u.cacheReadInputTokens !== undefined || u.cachedInputTokens !== undefined) return base;
  const write = u.cacheCreationInputTokens ?? 0;
  if (!valid(write) || write > u.inputTokens) return base;
  const eligibleInputTokens = u.inputTokens - write;
  const full = price({ ...row, usage: { ...u, cacheReadInputTokens: eligibleInputTokens } });
  if (!valid(full.usd)) return base; // No published cache price: keep undiscounted valuation.
  return { ...base, cursorCache: { noCacheUsd: base.usd, fullCacheUsd: full.usd, eligibleInputTokens } };
}
