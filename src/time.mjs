// Shared time contract. A provider reading counts as current for fifteen minutes,
// and may run up to a minute ahead of us before it reads as clock skew. Every
// surface that decides whether a measurement is still showable uses these values.
export const MINUTE = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;
export const STALE_MS = 15 * MINUTE;
export const SKEW_MS = MINUTE;

// When a window was actually measured, carried beside the window on a symbol key. An account
// read by several endpoints has no single instant that is true for all of its windows, and the
// published contract carries one timestamp per account, which the clients use to judge the
// whole account's age. Rather than move that timestamp and lie to one side or the other, the
// per-window instant travels here: JSON.stringify ignores symbol-keyed properties, so history
// sees it and the API response does not change at all.
export const MEASURED_AT = Symbol('quota-monitor.windowMeasuredAt');

// Which physical account a reading belongs to, carried beside the window on a symbol key for the
// same reason as MEASURED_AT. The public account id survives a physical replacement, so a reading
// filed under it alone can be attributed to whichever account happens to hold that id later. The
// identity that matters is the one the reading was committed under, and only the path that made
// the reading knows it: asking for the currently open epoch at storage time answers a different
// question and gets account B's number onto account A's measurement. JSON.stringify ignores
// symbol-keyed properties, so history sees this and the API response does not change.
export const IDENTITY_EPOCH = Symbol('quota-monitor.windowIdentityEpoch');

// A verified direct reader owns its history even when a newer cache supplies the displayed
// percentage. Carry the actual reading, including its own epoch/time, rather than lending
// the cache an identity it did not establish. Only the internal capture/analytics paths use it.
export const HISTORY_READING = Symbol('quota-monitor.historyReading');

export const iso = ms => Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;

// OpenCodex records some timestamps in seconds and others in milliseconds.
export const epochIso = value => typeof value === 'number' ? iso(value < 1e11 ? value * 1000 : value) : null;

export const expired = (measuredAt, now) =>
  !Number.isFinite(measuredAt) || now - measuredAt > STALE_MS || measuredAt > now + SKEW_MS;
