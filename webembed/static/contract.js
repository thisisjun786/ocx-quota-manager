export const SCHEMA_VERSION = 1;
const STATUSES = new Set([
    "ok", "stale", "reauth", "paused", "unavailable", "collecting",
]);
export function isAccountStatus(value) {
    return STATUSES.has(value);
}
export function validateSnapshot(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("snapshot: object required");
    }
    const raw = value;
    if (raw.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(`schemaVersion: want ${SCHEMA_VERSION}`);
    }
    if (!Array.isArray(raw.providers)) {
        throw new Error("providers: required");
    }
    for (const provider of raw.providers) {
        if (provider === null || typeof provider !== "object")
            throw new Error("provider");
        const p = provider;
        if (typeof p.id !== "string" || p.id.length === 0)
            throw new Error("provider.id");
        if (!Array.isArray(p.accounts))
            throw new Error("provider.accounts");
        for (const account of p.accounts) {
            if (account === null || typeof account !== "object")
                throw new Error("account");
            const a = account;
            if (typeof a.id !== "string" || a.id.length === 0)
                throw new Error("account.id");
            if (typeof a.status !== "string" || !isAccountStatus(a.status))
                throw new Error("account.status");
            if (!Array.isArray(a.windows))
                throw new Error("account.windows");
            for (const window of a.windows) {
                if (window === null || typeof window !== "object")
                    throw new Error("window");
                const w = window;
                if (typeof w.id !== "string" || w.id.length === 0)
                    throw new Error("window.id");
                if (w.remainingPercent !== null && w.remainingPercent !== undefined) {
                    if (typeof w.remainingPercent !== "number" || !Number.isFinite(w.remainingPercent)) {
                        throw new Error("remainingPercent must be finite or null");
                    }
                }
            }
        }
    }
    return value;
}
export function neededAccounts(sumPp, capacityHours, periodHours) {
    if (!(periodHours > 0) || !(capacityHours > 0))
        return 0;
    const raw = sumPp / 100 * capacityHours / periodHours;
    const nearest = Math.round(raw);
    const stable = nearest > 0 && Math.abs(raw - nearest) <= Number.EPSILON * Math.max(1, raw) * 8 ? nearest : raw;
    return Math.ceil(stable);
}
