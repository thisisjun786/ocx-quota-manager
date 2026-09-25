export const SCHEMA_VERSION = 1 as const;

export type AccountStatus = "ok" | "stale" | "reauth" | "paused" | "unavailable" | "collecting";

export type RateCard = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
};

export type ModelPrice = {
  model: string;
  status: string;
  unit: string;
  rates: RateCard;
  sourceUrl: string | null;
  checkedAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  conditions: string[];
  unsupported: string[];
  conflict: unknown;
  reason: string | null;
};

export type QuotaWindow = {
  id: string;
  label: string;
  remainingPercent: number | null;
  usedPercent?: number | null;
  stale?: boolean;
  resetAt: string | null;
  usageScope: string | null;
  measurement?: unknown;
  analytics?: Record<string, unknown>;
};

export type QuotaAccount = {
  id: string;
  label: string;
  plan: string | null;
  status: AccountStatus;
  updatedAt: string | null;
  active?: boolean;
  quotaMode?: string | null;
  windows: QuotaWindow[];
  refresh?: unknown;
  directQuota?: unknown;
  ollama?: unknown;
  analytics?: Record<string, unknown>;
};

export type QuotaProvider = {
  id: string;
  name: string;
  enabled: boolean;
  defaultModel: string | null;
  supportedModels?: string[];
  accounts: QuotaAccount[];
  analytics?: Record<string, unknown>;
};

export type Snapshot = {
  schemaVersion: typeof SCHEMA_VERSION;
  observedAt?: string;
  source?: string;
  refreshIntervalSeconds?: number;
  warnings?: string[];
  providers: QuotaProvider[];
  analytics?: Record<string, unknown>;
};

const STATUSES: ReadonlySet<AccountStatus> = new Set([
  "ok", "stale", "reauth", "paused", "unavailable", "collecting",
]);

export function isAccountStatus(value: string): value is AccountStatus {
  return STATUSES.has(value as AccountStatus);
}

export function validateSnapshot(value: unknown): Snapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("snapshot: object required");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`schemaVersion: want ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.providers)) {
    throw new Error("providers: required");
  }
  for (const provider of raw.providers) {
    if (provider === null || typeof provider !== "object") throw new Error("provider");
    const p = provider as Record<string, unknown>;
    if (typeof p.id !== "string" || p.id.length === 0) throw new Error("provider.id");
    if (!Array.isArray(p.accounts)) throw new Error("provider.accounts");
    for (const account of p.accounts) {
      if (account === null || typeof account !== "object") throw new Error("account");
      const a = account as Record<string, unknown>;
      if (typeof a.id !== "string" || a.id.length === 0) throw new Error("account.id");
      if (typeof a.status !== "string" || !isAccountStatus(a.status)) throw new Error("account.status");
      if (!Array.isArray(a.windows)) throw new Error("account.windows");
      for (const window of a.windows) {
        if (window === null || typeof window !== "object") throw new Error("window");
        const w = window as Record<string, unknown>;
        if (typeof w.id !== "string" || w.id.length === 0) throw new Error("window.id");
        if (w.remainingPercent !== null && w.remainingPercent !== undefined) {
          if (typeof w.remainingPercent !== "number" || !Number.isFinite(w.remainingPercent)) {
            throw new Error("remainingPercent must be finite or null");
          }
        }
      }
    }
  }
  return value as Snapshot;
}

export function neededAccounts(sumPp: number, capacityHours: number, periodHours: number): number {
  if (!(periodHours > 0) || !(capacityHours > 0)) return 0;
  const raw = sumPp / 100 * capacityHours / periodHours;
  const nearest = Math.round(raw);
  const stable = nearest > 0 && Math.abs(raw - nearest) <= Number.EPSILON * Math.max(1, raw) * 8 ? nearest : raw;
  return Math.ceil(stable);
}
