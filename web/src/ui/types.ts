import type { QuotaAccount, QuotaProvider, QuotaWindow, Snapshot } from "../contract.js";

export type { QuotaAccount, QuotaProvider, QuotaWindow, Snapshot };

export type PeriodKey = "oneHour" | "fiveHour" | "twentyFourHour" | "weekly" | "monthly";

export type PeriodDef = { key: PeriodKey; label: string; short: string };

export type CoverageAxis = "unknown" | "none" | "partial" | "full";

export type PeriodStats = {
  hours: number | null;
  logCoverageHours: number | null;
  observedCoverageHours: number | null;
  requests: number;
  pricedRequests: number;
  apiUsd: number | null;
  unknownPriceRequests: number;
  cacheEstimatedRequests: number;
  unknownPriceTokens: number;
  unknownPriceUnsizedRequests: number;
  noCacheApiUsd: number | null;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCachedTokens: number;
  localPriceRequests: number;
};

export type PeriodState = {
  state: "unknown" | "unsupported" | "attention" | "partial" | "ok";
  record: CoverageAxis;
  observation: CoverageAxis;
  amount: string;
  note: string;
  detailNote: string;
  coverageNote: string;
  partial: boolean;
  cacheEstimated: boolean;
  estimateNote: string;
};

export type ConsumptionSample = {
  deltaPp?: number | null;
  spanHours?: number | null;
  coverage?: number | null;
  basis?: string;
  recoveredHours?: number;
  recoveredDeltaPp?: number;
  resetGapCount?: number;
  periodEndedAt?: string;
};

export type HistoricalCapacity = {
  apiUsd?: number | null;
  remainingApiUsd?: number | null;
  reason?: string | null;
  observedAt?: string | null;
  readingObservedAt?: string | null;
  basis?: string | null;
};

export type WindowAnalytics = {
  status?: string;
  reason?: string;
  capacityApiUsd?: number | null;
  remainingApiUsd?: number | null;
  capacityBasis?: string | null;
  capacityReason?: string | null;
  exhaustsAt?: string | null;
  forecastRatePpHour?: number | null;
  forecastObservedHours?: number | null;
  forecastDeltaPp?: number | null;
  forecastSpanHours?: number | null;
  forecastCoverage?: number | null;
  resetBeforeExhaustion?: boolean;
  history?: unknown;
  historicalCapacity?: HistoricalCapacity | null;
  historicalConsumptionPeriods?: Record<string, ConsumptionSample | undefined>;
  consumptionPeriods?: Record<string, ConsumptionSample | undefined>;
  capacityMatchedQuotaCoverage?: number | null;
  unexplainedDeltaPp?: number | null;
  providerWide?: boolean;
  selectedHistoricalPeriod?: ConsumptionSample | null;
  selectedPeriodSample?: ConsumptionSample | null;
};

export type RefreshState = {
  status?: string;
  lastAttemptAt?: string | null;
  nextAttemptAt?: string | null;
};

export type DirectQuota = {
  status?: string;
  reason?: string | null;
  nextAttemptAt?: string | null;
  evidence?: unknown;
  lastKnown?: {
    accountStatus?: string;
    windows?: unknown[];
  } | null;
};

export type SubscriptionInfo = {
  monthlyUsd?: number | null;
  label?: string;
  basis?: string;
  reason?: string;
};

export type Recommendation = {
  status?: string;
  recommendedAccounts?: number | null;
  currentAccounts?: number | null;
  reason?: string;
  usageStale?: boolean;
  demandBasis?: string;
  windowId?: string;
  estimatedMonthlyUsd?: number | null;
};

export type PaceInfo = {
  stale?: boolean;
  basisPeriod?: string;
  projectedFiveHourUsd?: number | null;
  projectedWeekUsd?: number | null;
  pricedCoverage?: number;
};

export type UiContext = {
  snapshot: Snapshot | null;
  selected: string;
  selectedPeriod: PeriodKey;
  detailPeriods: Map<string, PeriodKey>;
  drawerOpen: boolean;
  providerOrder: string[];
  orderStorageFailed: boolean;
  ORDER_KEY: string;
  render: () => void;
  select: (id: string) => void;
  clearSearch: () => void;
  changePeriod?: (period: PeriodKey) => void;
};

export const PERIOD_KEYS: readonly PeriodKey[] = [
  "oneHour", "fiveHour", "twentyFourHour", "weekly", "monthly",
];

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function isPeriodKey(value: string): value is PeriodKey {
  return (PERIOD_KEYS as readonly string[]).includes(value);
}

export function asPeriodKey(value: string, fallback: PeriodKey = "weekly"): PeriodKey {
  return isPeriodKey(value) ? value : fallback;
}

export function periodStats(value: unknown): PeriodStats | null {
  const o = asRecord(value);
  if (!o) return null;
  return {
    hours: num(o.hours),
    logCoverageHours: num(o.logCoverageHours),
    observedCoverageHours: num(o.observedCoverageHours),
    requests: num(o.requests) ?? 0,
    pricedRequests: num(o.pricedRequests) ?? 0,
    apiUsd: o.apiUsd === null ? null : num(o.apiUsd),
    unknownPriceRequests: num(o.unknownPriceRequests) ?? 0,
    cacheEstimatedRequests: num(o.cacheEstimatedRequests) ?? 0,
    unknownPriceTokens: num(o.unknownPriceTokens) ?? 0,
    unknownPriceUnsizedRequests: num(o.unknownPriceUnsizedRequests) ?? 0,
    noCacheApiUsd: o.noCacheApiUsd === null ? null : num(o.noCacheApiUsd),
    tokens: num(o.tokens) ?? 0,
    inputTokens: num(o.inputTokens) ?? 0,
    outputTokens: num(o.outputTokens) ?? 0,
    cachedTokens: num(o.cachedTokens) ?? 0,
    estimatedCachedTokens: num(o.estimatedCachedTokens) ?? 0,
    localPriceRequests: num(o.localPriceRequests) ?? 0,
  };
}

export function periodMap(value: unknown): Record<string, PeriodStats | undefined> | null {
  const o = asRecord(value);
  if (!o) return null;
  const out: Record<string, PeriodStats | undefined> = {};
  for (const [key, row] of Object.entries(o)) {
    out[key] = periodStats(row) ?? undefined;
  }
  return out;
}

export function consumptionSample(value: unknown): ConsumptionSample | null {
  const o = asRecord(value);
  if (!o) return null;
  return {
    deltaPp: o.deltaPp === null ? null : num(o.deltaPp),
    spanHours: o.spanHours === null ? null : num(o.spanHours),
    coverage: o.coverage === null ? null : num(o.coverage),
    basis: str(o.basis) ?? undefined,
    recoveredHours: num(o.recoveredHours) ?? undefined,
    recoveredDeltaPp: num(o.recoveredDeltaPp) ?? undefined,
    resetGapCount: num(o.resetGapCount) ?? undefined,
    periodEndedAt: str(o.periodEndedAt) ?? undefined,
  };
}

export function consumptionMap(value: unknown): Record<string, ConsumptionSample | undefined> | undefined {
  const o = asRecord(value);
  if (!o) return undefined;
  const out: Record<string, ConsumptionSample | undefined> = {};
  for (const [key, row] of Object.entries(o)) {
    out[key] = consumptionSample(row) ?? undefined;
  }
  return out;
}

export function historicalCapacity(value: unknown): HistoricalCapacity | null {
  const o = asRecord(value);
  if (!o) return null;
  return {
    apiUsd: o.apiUsd === null ? null : num(o.apiUsd),
    remainingApiUsd: o.remainingApiUsd === null ? null : num(o.remainingApiUsd),
    reason: str(o.reason),
    observedAt: str(o.observedAt),
    readingObservedAt: str(o.readingObservedAt),
    basis: str(o.basis),
  };
}

export function windowAnalytics(value: unknown): WindowAnalytics | undefined {
  const o = asRecord(value);
  if (!o) return undefined;
  const providerWide = bool(o.providerWide);
  return {
    status: str(o.status) ?? undefined,
    reason: str(o.reason) ?? undefined,
    capacityApiUsd: o.capacityApiUsd === null ? null : num(o.capacityApiUsd),
    remainingApiUsd: o.remainingApiUsd === null ? null : num(o.remainingApiUsd),
    capacityBasis: str(o.capacityBasis),
    capacityReason: str(o.capacityReason),
    exhaustsAt: str(o.exhaustsAt),
    forecastRatePpHour: o.forecastRatePpHour === null ? null : num(o.forecastRatePpHour),
    forecastObservedHours: o.forecastObservedHours === null ? null : num(o.forecastObservedHours),
    forecastDeltaPp: o.forecastDeltaPp === null ? null : num(o.forecastDeltaPp),
    forecastSpanHours: o.forecastSpanHours === null ? null : num(o.forecastSpanHours),
    forecastCoverage: o.forecastCoverage === null ? null : num(o.forecastCoverage),
    resetBeforeExhaustion: bool(o.resetBeforeExhaustion) ?? undefined,
    history: o.history,
    historicalCapacity: o.historicalCapacity === null ? null : historicalCapacity(o.historicalCapacity),
    historicalConsumptionPeriods: consumptionMap(o.historicalConsumptionPeriods),
    consumptionPeriods: consumptionMap(o.consumptionPeriods),
    capacityMatchedQuotaCoverage: o.capacityMatchedQuotaCoverage === null ? null : num(o.capacityMatchedQuotaCoverage),
    unexplainedDeltaPp: o.unexplainedDeltaPp === null ? null : num(o.unexplainedDeltaPp),
    ...(providerWide === null ? {} : { providerWide }),
    selectedHistoricalPeriod: o.selectedHistoricalPeriod === null ? null : consumptionSample(o.selectedHistoricalPeriod),
    selectedPeriodSample: o.selectedPeriodSample === null ? null : consumptionSample(o.selectedPeriodSample),
  };
}

export function refreshState(value: unknown): RefreshState | undefined {
  const o = asRecord(value);
  if (!o) return undefined;
  return {
    status: str(o.status) ?? undefined,
    lastAttemptAt: o.lastAttemptAt === null ? null : str(o.lastAttemptAt),
    nextAttemptAt: o.nextAttemptAt === null ? null : str(o.nextAttemptAt),
  };
}

export function directQuota(value: unknown): DirectQuota | undefined {
  const o = asRecord(value);
  if (!o) return undefined;
  const last = asRecord(o.lastKnown);
  return {
    status: str(o.status) ?? undefined,
    reason: o.reason === null ? null : str(o.reason),
    nextAttemptAt: o.nextAttemptAt === null ? null : str(o.nextAttemptAt),
    evidence: o.evidence,
    lastKnown: last ? {
      accountStatus: str(last.accountStatus) ?? undefined,
      windows: Array.isArray(last.windows) ? last.windows : undefined,
    } : o.lastKnown === null ? null : undefined,
  };
}

export function subscriptionInfo(value: unknown): SubscriptionInfo | undefined {
  const o = asRecord(value);
  if (!o) return undefined;
  return {
    monthlyUsd: o.monthlyUsd === null ? null : num(o.monthlyUsd),
    label: str(o.label) ?? undefined,
    basis: str(o.basis) ?? undefined,
    reason: str(o.reason) ?? undefined,
  };
}

export function recommendationOf(value: unknown): Recommendation | null {
  const o = asRecord(value);
  if (!o) return null;
  return {
    status: str(o.status) ?? undefined,
    recommendedAccounts: o.recommendedAccounts === null ? null : num(o.recommendedAccounts),
    currentAccounts: o.currentAccounts === null ? null : num(o.currentAccounts),
    reason: str(o.reason) ?? undefined,
    usageStale: bool(o.usageStale) ?? undefined,
    demandBasis: str(o.demandBasis) ?? undefined,
    windowId: str(o.windowId) ?? undefined,
    estimatedMonthlyUsd: o.estimatedMonthlyUsd === null ? null : num(o.estimatedMonthlyUsd),
  };
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
