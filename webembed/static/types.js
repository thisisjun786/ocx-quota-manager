export const PERIOD_KEYS = [
    "oneHour", "fiveHour", "twentyFourHour", "weekly", "monthly",
];
export function asRecord(value) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return null;
}
export function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function str(value) {
    return typeof value === "string" ? value : null;
}
export function bool(value) {
    return typeof value === "boolean" ? value : null;
}
export function isPeriodKey(value) {
    return PERIOD_KEYS.includes(value);
}
export function asPeriodKey(value, fallback = "weekly") {
    return isPeriodKey(value) ? value : fallback;
}
export function periodStats(value) {
    const o = asRecord(value);
    if (!o)
        return null;
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
export function periodMap(value) {
    const o = asRecord(value);
    if (!o)
        return null;
    const out = {};
    for (const [key, row] of Object.entries(o)) {
        out[key] = periodStats(row) ?? undefined;
    }
    return out;
}
export function consumptionSample(value) {
    const o = asRecord(value);
    if (!o)
        return null;
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
export function consumptionMap(value) {
    const o = asRecord(value);
    if (!o)
        return undefined;
    const out = {};
    for (const [key, row] of Object.entries(o)) {
        out[key] = consumptionSample(row) ?? undefined;
    }
    return out;
}
export function historicalCapacity(value) {
    const o = asRecord(value);
    if (!o)
        return null;
    return {
        apiUsd: o.apiUsd === null ? null : num(o.apiUsd),
        remainingApiUsd: o.remainingApiUsd === null ? null : num(o.remainingApiUsd),
        reason: str(o.reason),
        observedAt: str(o.observedAt),
        readingObservedAt: str(o.readingObservedAt),
        basis: str(o.basis),
    };
}
export function windowAnalytics(value) {
    const o = asRecord(value);
    if (!o)
        return undefined;
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
export function refreshState(value) {
    const o = asRecord(value);
    if (!o)
        return undefined;
    return {
        status: str(o.status) ?? undefined,
        lastAttemptAt: o.lastAttemptAt === null ? null : str(o.lastAttemptAt),
        nextAttemptAt: o.nextAttemptAt === null ? null : str(o.nextAttemptAt),
    };
}
export function directQuota(value) {
    const o = asRecord(value);
    if (!o)
        return undefined;
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
export function subscriptionInfo(value) {
    const o = asRecord(value);
    if (!o)
        return undefined;
    return {
        monthlyUsd: o.monthlyUsd === null ? null : num(o.monthlyUsd),
        label: str(o.label) ?? undefined,
        basis: str(o.basis) ?? undefined,
        reason: str(o.reason) ?? undefined,
    };
}
export function recommendationOf(value) {
    const o = asRecord(value);
    if (!o)
        return null;
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
export function text(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
