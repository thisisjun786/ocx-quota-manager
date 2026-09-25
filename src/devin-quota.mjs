// Devin CLI's read-only GetUserStatus reports remaining plan quota. Keep daily and
// weekly independent; an absent field is not zero and daily never fills weekly.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const WINDOWS = [
  ['daily', 'short', '24시간'],
  ['weekly', 'weekly', '주간'],
];
const resetTime = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const ms = Number(value) * 1000;
  return Number.isSafeInteger(ms) && ms > 0 && ms < 8.64e15 ? ms : null;
};

export const devinAdapter = {
  provider: 'devin', endpointId: 'user-status', sourceVersion: 'devin-user-status-1',
  appliesTo: binding => binding.kind === 'oauth',
  parse(json) {
    const plan = record(json?.userStatus?.planStatus) ? json.userStatus.planStatus : null;
    if (!plan) return [];
    const rows = [];
    for (const [period, windowId, label] of WINDOWS) {
      if (period === 'daily' && plan.planInfo?.hideDailyQuota === true) {
        rows.push({ windowId, hidden: true });
        continue;
      }
      const remaining = plan[period + 'QuotaRemainingPercent'];
      if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 100) continue;
      const resetAt = resetTime(plan[period + 'QuotaResetAtUnix']);
      rows.push({ windowId, label, resetAt, raw: {
        percent: 100 - remaining, method: 'reported_percent', scopeKey: 'all', unit: 'percent',
        windowSemantics: resetAt === null ? 'unknown' : 'fixed_reset',
        cycleKey: resetAt === null ? null : new Date(resetAt).toISOString(),
        precisionEvidence: Number.isInteger(remaining) ? 'unknown' : 'observed_fraction',
      } });
    }
    return rows;
  },
};
