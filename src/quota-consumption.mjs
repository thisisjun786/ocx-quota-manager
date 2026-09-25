import { HOUR, iso } from './time.mjs';
import { cycleKeyInstant } from './quota-observations.mjs';
export const MAX_GAP = 20 * 60000;
const MIN_INTERVAL = 5 * 60000;
const RESET_TOLERANCE = 60000;

// Provider-side corrections can nudge usedPercent down by about a point inside
// one quota cycle. We treat a drop within tolerance as reporting noise and hold
// each sample at the segment's running high, so one blip must not split a
// contiguous run or inflate the measured burn — a real 1pp refund cannot be
// distinguished and is absorbed the same way. A larger drop, a reset change, a
// gap, or time going backwards starts a fresh segment anchored at that point's
// own reset — anchors are never chained from a drifting timestamp.
export const DIP_TOLERANCE_PP = 1;
export function normalizeQuotaPoints(points, {maxGapMs = MAX_GAP, canJoin = () => true} = {}) {
  const normalized = [];
  let adjustedSamples = 0;
  let anchor = null, high = -Infinity, previous = null;
  let segmentId = -1;
  for (const point of points) {
    const gap = previous === null ? null : point.at - previous.at;
    const drop = high - point.used;
    if (!anchor || !Number.isFinite(point.reset) || !Number.isFinite(anchor.reset) ||
        Math.abs(point.reset - anchor.reset) > 60000 ||
        (gap !== null && (gap <= 0 || gap > maxGapMs)) || drop > DIP_TOLERANCE_PP ||
        !canJoin(anchor, previous, point)) {
      anchor = point;
      high = point.used;
      segmentId++;
    } else if (point.used > high) {
      high = point.used;
    } else if (drop > 0) {
      adjustedSamples++;
    }
    // Segment identity is explicit: every downstream consumer (contiguous run,
    // forecast cycle, capacity run) requires a matching segmentId, so a drifted
    // timestamp that happens to sit near the window reset cannot re-bridge a
    // boundary the segmenter already drew. The anchor's reset rides along for
    // the freshness and historical checks that compare against the window.
    normalized.push({ ...point, used: high, reset: anchor.reset, segmentId });
    previous = point;
  }
  return { points: normalized, adjustedSamples };
}

// Consumption is an estimate over retained readings, not a current burn-rate forecast.
// Compare allowance materials explicitly: the stored basis digest covers precision evidence and
// a normalized cycle key, while this pairing keeps to the allowance fields and asks sameCycleKey
// whether the keys themselves report a cycle change the reset comparison did not.
const BASIS_FIELDS = ['source','sourceVersion','method','scopeKey','unit','limitValue',
  'limitState','windowSemantics','usedAccumulation'];
const sameBasis = (a, b) => Boolean(a.legacy) === Boolean(b.legacy) &&
  BASIS_FIELDS.every(key => (a[key] ?? null) === (b[key] ?? null));
const sameCycleKey = (a, b) => (a.cycleKey ?? null) === (b.cycleKey ?? null) ||
  (Math.abs(cycleKeyInstant(a.cycleKey) - a.reset) <= RESET_TOLERANCE &&
   Math.abs(cycleKeyInstant(b.cycleKey) - b.reset) <= RESET_TOLERANCE);
function recoverable(row) {
  if (!Number.isInteger(row.epoch) || row.windowSemantics !== 'fixed_reset' ||
      !['source','sourceVersion','method','scopeKey','unit'].every(key => Boolean(row[key])) ||
      row.reconciliation === 'mismatch' || row.usedAccumulation === 'interval') return false;
  if (row.method === 'used_limit' && row.usedAccumulation !== 'cumulative') return false;
  if (row.limitState === 'present') return Number.isFinite(row.limitValue) && row.limitValue > 0;
  return row.limitState === 'missing' && ['reported_percent','reported_fraction'].includes(row.method);
}

// The observation stream reduced to normalized points, exported so the forecast can read the
// same segmentation the period totals use instead of re-deriving it with different rules.
export function consumptionPoints(rows, identityEpoch, now) {
  const accepted = [];
  let barrier = false, watermark = -Infinity;
  for (const row of rows) {
    const ordered = Number.isFinite(row.at) && row.at > watermark;
    if (Number.isFinite(row.at)) watermark = Math.max(watermark, row.at);
    const coherent = ordered && row.at <= now && Number.isFinite(row.observedPercent) &&
      row.observedPercent >= 0 && Number.isFinite(row.reset) && row.at < row.reset;
    const mismatched = (row.epoch ?? null) !== identityEpoch;
    if (!coherent || mismatched) {
      // Only positive evidence severs a run: a contradictory reading, or one attributed to a
      // different epoch. A row that carries no epoch is merely unattributed — the dual write
      // paths interleave exactly such rows between an epoch's own measurements, so excluding
      // it is enough; treating it as a separator would shatter the stream into single-point
      // segments. Sorting or filtering first would still silently join neighbours or count
      // the same span twice after a reversal, which is why exclusion happens here at all.
      if (!coherent || (row.epoch ?? null) !== null) barrier = true;
      continue;
    }
    accepted.push({...row, used:row.observedPercent, barrier});
    barrier = false;
  }
  return normalizeQuotaPoints(accepted, {maxGapMs:Infinity, canJoin:(anchor, previous, point) =>
    !point.barrier && sameBasis(anchor, point) && sameCycleKey(anchor, point) &&
    point.at < anchor.reset &&
    (point.at - previous.at <= MAX_GAP || (recoverable(previous) && recoverable(point)))}).points;
}

// A reset that happened while nobody was watching. Two consecutive accepted points in
// different cycles with more than a gap between them mean the old cycle ended somewhere
// inside the silence: its last observed level is a floor, and everything between it and the
// reset is unknowable. That is reported, never bridged. A barrier flag marks a gap that also
// contains excluded evidence, where the cycle boundary may coincide with an account change.
//
// sameCycleKey alone cannot decide this: for reset-derived keys it only asks that each
// side's key agree with its own reset, so two different cycles both pass. A boundary is a
// different cycle when the resets themselves moved past the drift tolerance, or when the
// keys disagree in a way that is not explained by both restating their own reset.
const sameCycleBoundary = (a, b) => Math.abs(a.reset - b.reset) <= RESET_TOLERANCE &&
  sameCycleKey(a, b);

export function resetGapsIn(points, { maxGapMs = MAX_GAP } = {}) {
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1], after = points[i];
    if (before.segmentId === after.segmentId) continue;
    if (after.at - before.at <= maxGapMs) continue;
    if (sameCycleBoundary(before, after)) continue;
    gaps.push({ from: before.at, to: after.at, lastPercent: before.observedPercent,
      nextPercent: after.observedPercent, barrier: after.barrier === true });
  }
  return gaps;
}

// The recovered part of a long-term average: same-cycle gaps whose whole delta counts over
// their whole elapsed span. Only gaps lying inside the horizon contribute — splitting an
// unobserved span at the boundary would invent an hourly distribution, the same rule the
// period totals keep.
export function recoveredGapContribution(points, { through, horizonMs }) {
  let hours = 0, deltaPp = 0, gaps = 0;
  const start = through - horizonMs;
  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1], after = points[i];
    const gap = after.at - before.at, consumed = after.used - before.used;
    if (before.segmentId !== after.segmentId || gap <= MAX_GAP || consumed < 0 ||
        before.at <= start) continue;
    // A downward endpoint is not recovery evidence either — the period totals refuse
    // the same pair, and the forecast must not count it as flat time they rejected.
    if (Number.isFinite(before.observedPercent) && Number.isFinite(after.observedPercent) &&
        after.observedPercent < before.observedPercent) continue;
    hours += gap / HOUR; deltaPp += consumed; gaps += 1;
  }
  return { hours, deltaPp, gaps };
}

export function quotaConsumptionPeriods(rows, {now, periods, identityEpoch = null, points = null}) {
  const pts = points ?? consumptionPoints(rows, identityEpoch, now);
  const resetGaps = resetGapsIn(pts);
  return Object.fromEntries(periods.map(([key, horizon]) => {
    const from = now - horizon;
    let delta = 0, observedHours = 0, recoveredDeltaPp = 0, recoveredHours = 0;
    for (let i = 1; i < pts.length; i++) {
      const before = pts[i-1], after = pts[i];
      if (before.segmentId !== after.segmentId || after.at <= from) continue;
      const gap = after.at - before.at, consumed = after.used - before.used;
      if (gap > MAX_GAP) {
        // A total over a long gap says nothing about the part inside a smaller selected tab.
        // A downward endpoint is not recovery evidence; keep the high for subsequent rebounds.
        if (before.at < from || after.observedPercent < before.observedPercent) continue;
        recoveredDeltaPp += consumed;
        recoveredHours += gap / HOUR;
      } else {
        const elapsed = after.at - Math.max(before.at, from);
        observedHours += elapsed / HOUR;
        delta += consumed * elapsed / gap;
      }
    }
    const first = pts[0], last = pts.at(-1);
    const spanHours = last ? Math.max(0, last.at - Math.max(first.at, from)) / HOUR : 0;
    const enough = (observedHours + recoveredHours) * HOUR >= MIN_INTERVAL;
    // A reset gap counts in a period when its far end lands inside it: the cycle ended
    // somewhere in the silence, and whether that was before or after the boundary is
    // exactly what cannot be known.
    const resets = resetGaps.filter(gap => gap.to > from);
    return [key, {deltaPp:enough ? delta + recoveredDeltaPp : null, observedHours, spanHours,
      coverage:pts.length ? Math.min(1, observedHours / (horizon / HOUR)) : null,
      observedAt:last ? iso(last.at) : null, periodEndedAt:iso(now), recoveredDeltaPp, recoveredHours,
      resetGapCount: resets.length,
      resetGaps: resets.slice(-5).map(gap => ({ from: iso(gap.from), to: iso(gap.to),
        lastPercent: gap.lastPercent, nextPercent: gap.nextPercent, barrier: gap.barrier }))}];
  }));
}
