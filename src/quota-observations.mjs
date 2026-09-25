import { createHash } from 'node:crypto';
import { MEASURED_AT, IDENTITY_EPOCH, iso } from './time.mjs';

// A stored quota observation is the reading plus the evidence for it. The reading alone cannot
// answer whether 12.34 and 12.56 are two points on one measurement or two different measurements
// that happen to be expressed in the same unit, and that question decides whether the difference
// between them means anything at all.
//
// Nothing here touches a database or a network. history builds rows with it, analytics reads rows
// with it, and both get the same answers because the rules live in one place.

export const BREAKS = ['first', 'basis', 'cycle', 'time_reversed', 'gap'];

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' && value.length && value.length <= 200 ? value : null;

// The materials of a measurement basis, in fixed positions rather than as an object: object key
// order is not a stable string, which is the same reason src/history.mjs hashes price evidence
// from an array. The reset instant is deliberately absent. Providers nudge it by a few seconds on
// every refresh, so folding it in would open a new segment on each poll and nothing would ever
// join; the 60-second tolerance below compares it instead.
//
// A cycle key needs the same treatment when it only restates that reset. Every shipped adapter
// derives its key from the exact reset timestamp (an ISO string or epoch milliseconds), so a
// sub-minute nudge would change the digest before the reset tolerance could ever apply — each
// poll looked like a new basis, split the run, and bypassed idle deduplication. A key that
// restates the row's own reset within that tolerance contributes a constant marker and leaves
// cycle separation to the reset comparison; any other key — an opaque identifier, or one that
// disagrees with the reset it arrived beside — keeps its literal value as evidence of a real
// contract change.
const RESET_KEY_TOLERANCE_MS = 60000;

// The instant a cycle key encodes, when it encodes one: epoch milliseconds or an ISO timestamp.
// Anything else is an opaque identifier and stays unparseable on purpose.
export const cycleKeyInstant = key => typeof key !== 'string' ? NaN : /^\d+$/.test(key) ? Number(key)
  : /^\d{4}-\d\d-\d\dT/.test(key) ? Date.parse(key) : NaN;

const cycleKeyMaterial = row => {
  const instant = cycleKeyInstant(row.cycleKey);
  return Number.isFinite(instant) && Number.isFinite(row.reset) &&
    Math.abs(instant - row.reset) <= RESET_KEY_TOLERANCE_MS ? 'reset-derived' : row.cycleKey;
};

export const basisDigest = row => createHash('sha256').update(JSON.stringify([
  row.source, row.sourceVersion, row.method, row.scopeKey, cycleKeyMaterial(row), row.unit,
  row.limitValue, row.limitState, row.windowSemantics, row.precisionEvidence,
  row.resolutionPp, row.usedAccumulation, row.epoch,
])).digest('hex');

/**
 * Project one snapshot window into a storable observation, or null when there is nothing to store.
 *
 * A window carrying a measurement (the direct provider path) contributes its whole contract. A
 * window without one (the cached OpenCodex path) is stored as a reading with no evidence rather
 * than not stored at all: the percentage is real and worth keeping, and every evidence field says
 * unknown so that no later reader can mistake it for something that was verified.
 */
export function observationOf(window, { at, epoch = null } = {}) {
  if (window === null || typeof window !== 'object') return null;
  const measurement = window.measurement !== null && typeof window.measurement === 'object'
    ? window.measurement : null;
  const observed = finite(measurement?.reportedPercent ?? measurement?.calculatedPercent)
    ?? finite(window.usedPercent);
  if (observed === null || !Number.isFinite(at)) return null;
  const row = {
    at, epoch: Number.isInteger(epoch) ? epoch : null,
    // Every percentage here is unclamped. The window publishes min(100, percent) for display,
    // but an over-limit reading is evidence and the overage is the part worth keeping, so this
    // is deliberately not the number the window shows.
    reportedPercent: finite(measurement?.reportedPercent),
    calculatedPercent: finite(measurement?.calculatedPercent),
    observedPercent: observed,
    used: finite(measurement?.used),
    limitValue: finite(measurement?.limit),
    limitState: text(measurement?.limitState) ?? 'missing',
    unit: text(measurement?.unit),
    method: text(measurement?.method),
    windowSemantics: text(measurement?.windowSemantics) ?? 'unknown',
    scopeKey: text(measurement?.scopeKey),
    cycleKey: text(measurement?.cycleKey),
    reset: finite(window.resetAt ? Date.parse(window.resetAt) : null),
    source: text(measurement?.source),
    sourceVersion: text(measurement?.sourceVersion),
    precisionEvidence: text(measurement?.precisionEvidence) ?? 'unknown',
    resolutionPp: finite(measurement?.resolutionPp),
    reconciliation: text(measurement?.reconciliation) ?? 'unverified',
    usedAccumulation: text(measurement?.usedAccumulation) ?? 'unknown',
  };
  return { ...row, basis: basisDigest(row) };
}

/** When a window says it was measured, and under which identity. Both ride on symbol keys. */
export const measuredAtOf = window => finite(window?.[MEASURED_AT]);
export const identityEpochOf = window => {
  const epoch = window?.[IDENTITY_EPOCH];
  return Number.isInteger(epoch) ? epoch : null;
};

// Two readings are the same observation only when nothing about them differs: not the evidence,
// not any of the five raw numbers, not the cycle they sit in, and not the instant they were taken
// at. Comparing the published percentage alone is not enough, because it is capped at 100: a
// window moving 137.5 -> 137.1 -> 137.5 reads as 100 -> 100 -> 100, and the correction that
// actually happened disappears. A percentage that holds still while used moves disappears the
// same way.
export function sameReading(previous, next, { resetToleranceMs = 60000 } = {}) {
  if (!previous || !next) return false;
  if (previous.basis !== next.basis) return false;
  for (const key of ['reportedPercent', 'calculatedPercent', 'observedPercent', 'used', 'limitValue']) {
    if (previous[key] !== next[key]) return false;
  }
  // A provider without a cycle key marks a new cycle only by moving its reset, so a reset that
  // moved past the drift tolerance is a different observation even at an identical percentage.
  const bothReset = Number.isFinite(previous.reset) && Number.isFinite(next.reset);
  if (bothReset ? Math.abs(previous.reset - next.reset) > resetToleranceMs
    : previous.reset !== next.reset) return false;
  return true;
}

/**
 * Should this observation be written, given the last one stored for the same window?
 *
 * Time moving backwards is its own reason to write. A reading that repeats every value and only
 * moves its timestamp earlier satisfies none of the other conditions, and dropping it would leave
 * the reversal invisible to every reader downstream — the segmenter would never see the evidence
 * it is supposed to break on. An exact repeat at the same instant is still dropped, because a
 * collector polling every ten seconds re-reads one cached value many times.
 */
export function shouldStore(previous, next, { idleMs, resetToleranceMs = 60000 } = {}) {
  if (!previous) return true;
  // Content first, instant second. Folding the instant into the comparison would make every poll
  // a different observation and defeat the idle rule that keeps a month of history from costing a
  // quarter million rows per window.
  if (!sameReading(previous, next, { resetToleranceMs })) return true;
  if (next.at < previous.at) return true;
  if (next.at === previous.at) return false;
  return next.at - previous.at >= idleMs;
}

// --- reading the stored evidence -----------------------------------------------------------

const sameCycle = (a, b, tolerance) => Number.isFinite(a) && Number.isFinite(b)
  ? Math.abs(a - b) <= tolerance : a === b;

/**
 * Cut the stored stream into runs where a difference between two readings means something.
 *
 * Input must be in storage order, not sorted by instant. Sorting by instant would quietly repair
 * a provider that handed us an earlier observation time than the one before it, and that repair
 * is precisely the event the time_reversed rule exists to record.
 */
export function segmentObservations(rows, { maxGapMs, resetToleranceMs = 60000 } = {}) {
  const segments = [];
  let current = null, previous = null;
  for (const row of rows) {
    const reason = !previous ? 'first'
      // One digest covers denominator, cycle key, scope, source, method, unit, precision, the
      // accumulation declaration and the identity. The reset is the only material left out.
      : previous.basis !== row.basis ? 'basis'
      : !sameCycle(previous.reset, row.reset, resetToleranceMs) ? 'cycle'
      : row.at <= previous.at ? 'time_reversed'
      : row.at - previous.at > maxGapMs ? 'gap'
      : null;
    if (reason) segments.push(current = { reason, at: row.at, rows: [] });
    current.rows.push(row);
    previous = row;
  }
  return segments;
}

// Whether two neighbouring runs belong to one quota cycle. Only then does a drop between them
// need explaining: a cumulative counter is supposed to fall back at a genuine reset.
const joinedCycle = (before, after, tolerance) =>
  sameCycle(before.rows.at(-1).reset, after.rows[0].reset, tolerance);

/**
 * Signed movement, in the vocabulary of occupancy only.
 *
 * Nothing here is named for consumption. A rise in the share of a sliding window is not a total,
 * and a field that quietly becomes one whenever the numbers happen to climb is how a share
 * difference ends up published as usage. Consumption lives behind consumptionOf and nowhere else.
 */
export function observedChanges(segments, { resetToleranceMs = 60000 } = {}) {
  const changes = [];
  let increasePp = 0, decreasePp = 0, netChangePp = 0, unresolvedDecreases = 0, observations = 0;
  for (const [index, segment] of segments.entries()) {
    observations += segment.rows.length;
    for (let i = 1; i < segment.rows.length; i++) {
      const from = segment.rows[i - 1], to = segment.rows[i];
      const deltaPp = to.observedPercent - from.observedPercent;
      changes.push({ at: to.at, fromPercent: from.observedPercent, toPercent: to.observedPercent, deltaPp });
      if (deltaPp > 0) increasePp += deltaPp;
      else if (deltaPp < 0) { decreasePp += deltaPp; unresolvedDecreases += 1; }
    }
    netChangePp += segment.rows.at(-1).observedPercent - segment.rows[0].observedPercent;
    // A drop across the seam counts too. Looking only inside each run lets 12.34-12.56, a gap,
    // then 12.10-12.56 read as two clean rises while the fall between them goes unmentioned.
    const earlier = segments[index - 1];
    if (earlier && joinedCycle(earlier, segment, resetToleranceMs) &&
        segment.rows[0].observedPercent < earlier.rows.at(-1).observedPercent) unresolvedDecreases += 1;
  }
  return { netChangePp, increasePp, decreasePp, unresolvedDecreases, observations,
    monotonic: unresolvedDecreases === 0, changes };
}

const overlaps = (a, b) => a.rows.at(-1).at >= b.rows[0].at;

/**
 * How much was actually consumed, or why that cannot be said.
 *
 * This is the only place a consumption number is produced, and it is deliberately hard to reach.
 * A percentage exists on far more readings than a trustworthy quantity does: a provider can report
 * a share with no used value at all, or a used value counting only the last interval, or one whose
 * unit we never learned. Each condition below is a way a plausible subtraction turns out to mean
 * nothing.
 */
export function consumptionOf(segments, { resetToleranceMs = 60000 } = {}) {
  const refuse = reason => ({ usedDelta: null, totalUsedPp: null, unit: null, basis: null, reason });
  if (!segments.length) return refuse('관측 기록이 없습니다.');
  const head = segments.at(-1).rows[0];
  if (head.windowSemantics !== 'fixed_reset') {
    return refuse('고정 리셋 창이 아니어서 점유율 차이를 소모량이라고 부를 수 없습니다.');
  }
  if (head.usedAccumulation !== 'cumulative') {
    return refuse('이 창의 used 가 누적값이라는 근거가 없습니다. 숫자가 올라가는 것만으로는 확인되지 않습니다.');
  }
  if (head.limitState !== 'present') return refuse('분모가 확인되지 않아 소모량을 계산할 수 없습니다.');
  // Only runs that measure the same thing the same way. The digest carries unit, scope and the
  // denominator, so one comparison refuses three different ways of adding unlike quantities.
  const usable = segments.filter(segment => segment.rows[0].basis === head.basis);
  if (usable.some(segment => segment.rows.some(row => !Number.isFinite(row.used)))) {
    return refuse('일부 관측에 used 수량이 없습니다. 퍼센트가 있다고 수량이 있는 것은 아닙니다.');
  }
  if (usable.some(segment => segment.rows.length < 2)) {
    return refuse('관측이 하나뿐인 구간이 있어 변화를 잴 수 없습니다.');
  }
  for (const segment of usable) {
    for (let i = 1; i < segment.rows.length; i++) {
      if (segment.rows[i].used < segment.rows[i - 1].used) {
        return refuse('같은 구간에서 used 가 줄어, 누적값이라는 선언과 맞지 않습니다.');
      }
      // The percentage is the authoritative figure, and it can fall while the quantity rises.
      // Checking only the quantity published a negative total under a verified label.
      if (segment.rows[i].observedPercent < segment.rows[i - 1].observedPercent) {
        return refuse('같은 구간에서 보고된 퍼센트가 줄어, 수량 근거와 어긋납니다.');
      }
    }
  }
  for (let i = 1; i < usable.length; i++) {
    const before = usable[i - 1], after = usable[i];
    // Time must move forward between runs we are about to add together, or one span is counted twice.
    if (overlaps(before, after)) return refuse('구간의 시간대가 겹쳐 같은 구간을 두 번 셀 수 있습니다.');
    if (joinedCycle(before, after, resetToleranceMs) &&
        (after.rows[0].used < before.rows.at(-1).used ||
         after.rows[0].observedPercent < before.rows.at(-1).observedPercent)) {
      return refuse('같은 주기의 구간 사이에 설명되지 않은 하락이 있어 합계를 낼 수 없습니다.');
    }
  }
  const usedDelta = usable.reduce((sum, s) => sum + (s.rows.at(-1).used - s.rows[0].used), 0);
  const totalUsedPp = usable.reduce((sum, s) =>
    sum + (s.rows.at(-1).observedPercent - s.rows[0].observedPercent), 0);
  return {
    // A quantity whose unit nobody recorded is not a quantity. The percentage-point total does
    // not need one, so it is still published.
    usedDelta: head.unit === null ? null : usedDelta,
    totalUsedPp, unit: head.unit, basis: 'verified_cumulative',
    reason: head.unit === null ? '단위를 확인하지 못해 수량은 내지 않고 퍼센트포인트만 제공합니다.' : null,
  };
}

/**
 * How much of the requested span we were actually watching.
 *
 * Only forward gaps inside the threshold count as watched time, and the resulting spans are merged
 * before they are added. Both matter once readings can arrive out of order: a negative gap would
 * subtract time that did pass, and overlapping spans would add time twice and report more coverage
 * than the span contains.
 */
export function coverageOf(rows, { from, to, maxGapMs }) {
  const spanHours = Math.max(0, to - from) / 3600000;
  const intervals = [];
  for (let i = 1; i < rows.length; i++) {
    const start = rows[i - 1].at, end = rows[i].at;
    if (end <= start || end - start > maxGapMs) continue;
    const low = Math.max(start, from), high = Math.min(end, to);
    if (high > low) intervals.push([low, high]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let observed = 0, open = null;
  for (const [low, high] of intervals) {
    if (open === null || low > open[1]) { if (open) observed += open[1] - open[0]; open = [low, high]; }
    else open[1] = Math.max(open[1], high);
  }
  if (open) observed += open[1] - open[0];
  const observedHours = observed / 3600000;
  return { fromAt: from, toAt: to, spanHours, observedHours,
    ratio: spanHours > 0 ? Math.min(1, observedHours / spanHours) : null,
    observations: rows.length };
}

const EMPTY = {
  basis: 'unavailable', latest: null, segments: 0, breakCount: 0, breaks: [],
  changes: { netChangePp: 0, increasePp: 0, decreasePp: 0, monotonic: true,
    unresolvedDecreases: 0, observations: 0, recent: [] },
  consumption: { usedDelta: null, totalUsedPp: null, unit: null, basis: null,
    reason: '관측 기록이 없습니다.' },
  coverage: null, periods: {},
};

const readable = row => ({
  observedAt: iso(row.at), identityEpoch: row.epoch,
  reportedPercent: row.reportedPercent, calculatedPercent: row.calculatedPercent,
  observedPercent: row.observedPercent, used: row.used, limit: row.limitValue,
  limitState: row.limitState, unit: row.unit, method: row.method,
  windowSemantics: row.windowSemantics, scopeKey: row.scopeKey, cycleKey: row.cycleKey,
  source: row.source, sourceVersion: row.sourceVersion,
  precisionEvidence: row.precisionEvidence, resolutionPp: row.resolutionPp,
  reconciliation: row.reconciliation, usedAccumulation: row.usedAccumulation,
});

/**
 * The whole precision picture for one window, assembled from stored rows.
 *
 * Every period is computed from the retained observations that fall inside it, never from the
 * thinned array the chart is transported as. A total taken from a picture of the data is not a
 * total, and each period says how much of its own span was actually watched so the difference
 * between a quiet span and an unobserved one stays visible.
 *
 * The transported lists are capped while their counts are not: a response must not grow with the
 * number of readings, but losing the count would hide how often the record was interrupted.
 */
export function describePrecision(rows, { now, from, periods = [], maxGapMs,
  resetToleranceMs = 60000, limit = 20 } = {}) {
  if (!Array.isArray(rows) || !rows.length) return { ...EMPTY };
  const segments = segmentObservations(rows, { maxGapMs, resetToleranceMs });
  const changes = observedChanges(segments, { resetToleranceMs });
  const breaks = segments.filter(segment => segment.reason !== 'first');
  const horizonHours = Math.max(0, now - from) / 3600000;
  // Cut first, then narrow. Narrowing first drops the readings that caused a break along with
  // everything else outside the period, and the survivors on either side then read as one
  // uninterrupted run: a reversed reading just outside the hour would take the discontinuity with
  // it and leave a clean rise behind.
  const summarise = start => {
    const parts = segments
      .map(segment => ({ ...segment, rows: segment.rows.filter(row => row.at > start && row.at <= now) }))
      .filter(segment => segment.rows.length);
    const moved = observedChanges(parts, { resetToleranceMs });
    const inside = parts.flatMap(segment => segment.rows);
    return {
      netChangePp: moved.netChangePp, increasePp: moved.increasePp, decreasePp: moved.decreasePp,
      monotonic: moved.monotonic, unresolvedDecreases: moved.unresolvedDecreases,
      observations: moved.observations, segments: parts.length,
      coverage: coverageOf(inside, { from: start, to: now, maxGapMs }),
    };
  };
  return {
    basis: 'observed',
    latest: readable(rows.at(-1)),
    segments: segments.length,
    breakCount: breaks.length,
    breaks: breaks.slice(-limit).map(segment => ({ at: iso(segment.at), reason: segment.reason })),
    changes: {
      netChangePp: changes.netChangePp, increasePp: changes.increasePp,
      decreasePp: changes.decreasePp, monotonic: changes.monotonic,
      unresolvedDecreases: changes.unresolvedDecreases, observations: changes.observations,
      recent: changes.changes.slice(-limit).map(change => ({ at: iso(change.at),
        fromPercent: change.fromPercent, toPercent: change.toPercent, deltaPp: change.deltaPp })),
    },
    consumption: consumptionOf(segments, { resetToleranceMs }),
    coverage: { ...coverageOf(rows, { from, to: now, maxGapMs }),
      segments: segments.length, horizonHours },
    periods: Object.fromEntries(periods.map(([key, ms]) => [key, summarise(now - ms)])),
  };
}
