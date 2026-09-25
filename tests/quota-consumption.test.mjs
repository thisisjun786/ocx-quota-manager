import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaConsumptionPeriods } from '../src/quota-consumption.mjs';
const HOUR = 3600000, NOW = 1800000000000, RESET = NOW + 10 * HOUR;
const periods = [['oneHour', HOUR], ['day', 24 * HOUR]];
const row = (hoursAgo, used, extra = {}) => ({at: NOW - hoursAgo * HOUR, observedPercent: used,
  epoch: 1, source: 'test/quota', sourceVersion: '1', method: 'reported_percent', scopeKey: 'all',
  unit: 'percent', limitValue: null, limitState: 'missing', windowSemantics: 'fixed_reset',
  usedAccumulation: 'unknown', reconciliation: 'unverified', reset: RESET,
  cycleKey: new Date(RESET).toISOString(), ...extra});
const calc = (rows, extra = {}) => quotaConsumptionPeriods(rows, {now: NOW, periods, identityEpoch: 1, ...extra});

test('recover a whole fixed-cycle gap without inventing its hourly allocation or observation', () => {
  const r = calc([row(3,20), row(1,35)]);
  assert.equal(r.day.deltaPp,15); assert.equal(r.day.recoveredDeltaPp,15);
  assert.equal(r.day.recoveredHours,2); assert.equal(r.day.observedHours,0);
  assert.equal(r.day.coverage,0); assert.equal(r.oneHour.deltaPp,null);
  assert.equal(r.day.periodEndedAt,new Date(NOW).toISOString());
  assert.equal(r.day.observedAt,new Date(NOW-HOUR).toISOString());
  assert.equal(calc([row(3,20),row(1,20)]).day.deltaPp,0);
  assert.equal(calc([row(1,20)]).day.deltaPp,null);
  assert.equal(calc([row(3,20),row(1,35)],{now:NOW+25*HOUR}).day.deltaPp,null);
});

test('refuse recovery across incompatible or unproven evidence', () => {
  const changes = [{epoch:2},{source:'other'},{sourceVersion:'2'},{scopeKey:'model'},
    {unit:'credits'},{method:'used_limit'},{limitValue:200,limitState:'present'},
    {reset:RESET+HOUR},{cycleKey:'new-cycle'},{windowSemantics:'sliding'},
    {windowSemantics:'unknown'},{usedAccumulation:'interval'},{reconciliation:'mismatch'}];
  for (const extra of changes) assert.equal(calc([row(3,20),row(1,35,extra)]).day.deltaPp,null,JSON.stringify(extra));
  for (const extra of [{epoch:null},{source:null},{windowSemantics:'sliding'},
    {windowSemantics:'unknown'},{limitState:'zero',limitValue:0},{limitState:'unlimited'},
    {method:'used_limit',limitState:'missing'},{reconciliation:'mismatch'}]) {
    assert.equal(calc([row(3,20,extra),row(1,35,extra)],{identityEpoch:extra.epoch??1}).day.deltaPp,null,JSON.stringify(extra));
  }
  const measured={method:'used_limit',limitState:'present',limitValue:100,usedAccumulation:'cumulative'};
  assert.equal(calc([row(3,20,measured),row(1,35,measured)]).day.deltaPp,15);
  for(const usedAccumulation of ['unknown','interval']) {
    const evidence={...measured,usedAccumulation};
    assert.equal(calc([row(3,20,evidence),row(1,35,evidence)]).day.deltaPp,null);
  }
  assert.equal(calc([row(3,20,{epoch:null}),row(1,35,{epoch:null})],{identityEpoch:null}).day.deltaPp,null);
  assert.equal(calc([row(.3,20,{epoch:null}),row(.1,35,{epoch:null})],{identityEpoch:null}).day.deltaPp,15);
  const expired={reset:NOW-2*HOUR,cycleKey:new Date(NOW-2*HOUR).toISOString()};
  assert.equal(calc([row(3,20,expired),row(1,35,expired)]).day.deltaPp,null);
});

test('reset keys tolerate ISO and millisecond jitter but never chain drift or opaque changes', () => {
  for(const key of [n=>new Date(n).toISOString(),String]) {
    const a=row(3,20,{cycleKey:key(RESET)});
    const b=row(2,30,{reset:RESET+40000,cycleKey:key(RESET+40000)});
    const c=row(1,40,{reset:RESET+80000,cycleKey:key(RESET+80000)});
    assert.equal(calc([a,b,c]).day.deltaPp,10);
  }
  assert.equal(calc([row(3,20,{cycleKey:'cycle-1'}),row(1,35,{cycleKey:'cycle-2'})]).day.deltaPp,null);
});

test('excluded identities, intervening basis changes and reversed time are barriers', () => {
  assert.equal(calc([row(3,20),row(2,25,{epoch:2}),row(1,35)]).day.deltaPp,null);
  assert.equal(calc([row(.3,20,{epoch:null}),row(.2,25),row(.1,35,{epoch:null})],{identityEpoch:null}).day.deltaPp,null);
  assert.equal(calc([row(3,20),row(2,25,{source:'other'}),row(1,35)]).day.deltaPp,null);
  const r=calc([row(3,20),row(1,35),row(2,22),row(.5,40)]).day;
  assert.equal(r.deltaPp,15); assert.equal(r.recoveredHours,2);
  assert.equal(calc([row(3,20),row(3,25),row(1,35)]).day.deltaPp,null);
});

test('unattributed readings interleaved in an identified stream are skipped, not severing', () => {
  // The dual write paths store an unattributed row between an epoch's own measurements. It
  // cannot join the identified stream, but it is not evidence that another account was read.
  assert.equal(calc([row(3,20),row(2.5,22,{epoch:null}),row(1,35)]).day.deltaPp,15);
  assert.equal(calc([row(3,20),row(2.9,22,{epoch:null}),row(2.8,23,{epoch:null}),row(1,35)]).day.deltaPp,15);
  // An unattributed row that also contradicts the stream still severs it.
  assert.equal(calc([row(3,20),row(3.5,22,{epoch:null}),row(1,35)]).day.deltaPp,null);
  // And an identified foreign epoch between them still severs it.
  assert.equal(calc([row(3,20),row(2.5,22,{epoch:null}),row(2,25,{epoch:2}),row(1,35)]).day.deltaPp,null);
});

test('the running high spans recovered gaps so small corrections cannot invent rebound usage', () => {
  assert.equal(calc([row(3,20),row(1,19.5),row(.9,20)]).day.deltaPp,0);
  assert.equal(calc([row(3,20),row(1,10)]).day.deltaPp,null);
  assert.equal(calc([row(3,99),row(1,110)]).day.deltaPp,11);
});

test('short observed pairs retain boundary estimates; uncovered prefix and tail reduce coverage', () => {
  const r=calc([row(1.1,10),row(.9,20),row(.7,22)]).oneHour;
  assert.ok(Math.abs(r.deltaPp-7)<1e-9);
  assert.ok(Math.abs(r.observedHours-.3)<1e-9);
  assert.ok(Math.abs(r.coverage-.3)<1e-9);
  assert.equal(r.recoveredHours,0);
});

test('a reset inside a collection gap is reported as a reset gap and never bridged', () => {
  const later = { reset: RESET + 5 * HOUR, cycleKey: new Date(RESET + 5 * HOUR).toISOString() };
  const r = calc([row(3, 20), row(1, 35, later), row(0.5, 40, later)]).day;
  // Only the new cycle's own movement counts; the old cycle's unobserved tail is a floor.
  assert.equal(r.deltaPp, 5);
  assert.equal(r.recoveredDeltaPp, 5);
  assert.equal(r.resetGapCount, 1);
  assert.equal(r.resetGaps[0].lastPercent, 20);
  assert.equal(r.resetGaps[0].nextPercent, 35);
  assert.equal(r.resetGaps[0].barrier, false);
  assert.equal(r.resetGaps[0].from, new Date(NOW - 3 * HOUR).toISOString());
  // A reset between close readings is an observed boundary, not a gap event.
  assert.equal(calc([row(0.4, 20), row(0.2, 35, later)]).day.resetGapCount, 0);
  // Excluded evidence inside the gap marks the event as muddied rather than hiding it.
  const muddy = calc([row(3, 20), row(2, 25, { epoch: 2 }), row(1, 35, later)]).day;
  assert.equal(muddy.resetGapCount, 1);
  assert.equal(muddy.resetGaps[0].barrier, true);
  // A same-cycle gap that lacks recovery evidence is neither bridged nor a reset.
  assert.equal(calc([row(3, 20, { source: null }), row(1, 35, { source: null })],
    { identityEpoch: 1 }).day.resetGapCount, 0);
});
