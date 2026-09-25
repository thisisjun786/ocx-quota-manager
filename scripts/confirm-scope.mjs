// Re-derive the observational evidence behind every scoped window in the registry.
// A confirmation record in src/window-scope.mjs is only trustworthy if this script
// reproduces it from real history. Run: npm run confirm:scope [-- --data <dir>]
import { openHistory } from '../src/history.mjs';
import { WINDOW_SCOPES, confirmScope } from '../src/window-scope.mjs';
import { readSnapshot } from '../src/snapshot.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOUR = 3600000;
const argument = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const dataDir = argument('--data') ?? process.env.QUOTA_DATA_DIR ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'quota-monitor');
const days = Number(argument('--days') ?? 30);

const store = await openHistory(dataDir);
const now = Date.now();
const since = now - days * 24 * HOUR;
const matches = (model, patterns) => patterns.some(pattern => {
  const value = String(model ?? '').toLowerCase();
  const glob = pattern.toLowerCase();
  return glob.includes('*') || glob.includes('[')
    ? new RegExp('^' + glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\[([^\]]+)\]/g, '[$1]') + '$').test(value)
    : value === glob;
});

// An hour counts as in-scope evidence only when every priced request in it belongs
// to the scope, and as control evidence only when none of them do. Mixed hours say
// nothing about which limit moved, so they are discarded rather than guessed at.
function evidence(provider, account, window, scope) {
  const spend = store.db.prepare(
    'SELECT at,model,usd FROM usage WHERE provider=? AND account=? AND usd IS NOT NULL AND at>?'
  ).all(provider, account, since);
  const inScope = new Map(), outScope = new Map();
  for (const row of spend) {
    const hit = matches(row.model, scope.models);
    const target = (scope.exclude ? !hit : hit) ? inScope : outScope;
    const bucket = Math.floor(row.at / HOUR);
    target.set(bucket, (target.get(bucket) ?? 0) + row.usd);
  }
  const points = store.points(provider, account, window, since);
  const moved = bucket => {
    const inHour = points.filter(p => Math.floor(p.at / HOUR) === bucket);
    let total = 0;
    for (let i = 1; i < inHour.length; i++) {
      const change = inHour[i].used - inHour[i - 1].used;
      if (change > 0 && Math.abs(inHour[i].reset - inHour[i - 1].reset) <= 60000) total += change;
    }
    return total;
  };
  const sum = (map, other) => { let hours = 0, usd = 0, pp = 0;
    for (const [bucket, amount] of map) { if (other.has(bucket)) continue; hours++; usd += amount; pp += moved(bucket); }
    return { hours, usd, pp }; };
  // Two independent controls. Disjoint spend asks whether other traffic also moves
  // this window; a sibling window asks whether the same traffic also moves a limit
  // it must not. Either one, on its own hours, is real disjointness evidence.
  const siblingMoved = siblingWindow => {
    if (!siblingWindow) return null;
    const points = store.points(provider, account, siblingWindow, since);
    let hours = 0, pp = 0;
    for (const bucket of inScope.keys()) {
      if (outScope.has(bucket)) continue;
      hours++;
      const inHour = points.filter(p => Math.floor(p.at / HOUR) === bucket);
      for (let i = 1; i < inHour.length; i++) {
        const change = inHour[i].used - inHour[i - 1].used;
        if (change > 0 && Math.abs(inHour[i].reset - inHour[i - 1].reset) <= 60000) pp += change;
      }
    }
    return { hours, pp };
  };
  return { target: sum(inScope, outScope), control: sum(outScope, inScope), siblingMoved };
}

let failures = 0;
// Window labels live in the source projection, not in stored samples, so the
// registry matchers need the live window shape to find what they describe.
const projected = await readSnapshot(process.env.OPENCODEX_HOME ?? join(homedir(), '.opencodex'), now,
  process.env.QUOTA_CODEX_HOME ?? join(homedir(), '.codex'));
for (const scope of WINDOW_SCOPES) {
  if (!scope.models?.length) continue;
  const provider = projected.providers.find(p => p.id === scope.provider);
  const accounts = (provider?.accounts ?? []).flatMap(account =>
    account.windows.filter(w => scope.match(w)).map(w => ({ account: account.id, window: w.id, label: w.label })));
  console.log('\n== ' + scope.id + ' (' + scope.provider + (scope.exclude ? ', 제외 집합' : '') + ')');
  const recorded = confirmScope(scope.confirmation);
  console.log('   기록: ' + (recorded.confirmed ? '확인됨' : '미확인') + ' — ' + recorded.reason);
  let best = null;
  for (const row of accounts) {
    const found = evidence(scope.provider, row.account, row.window, scope);
    if (!found.target.hours) continue;
    const sibling = siblingOf(scope, provider, row.account);
    const siblingResult = sibling ? found.siblingMoved(sibling.id) : null;
    console.log('   ' + row.account.slice(0, 12) + '/' + row.window +
      ': 대상 지출 ' + found.target.hours + '시간 $' + found.target.usd.toFixed(2) + ' -> ' + found.target.pp.toFixed(2) + '%p' +
      ' | 서로소 지출 대조 ' + found.control.hours + '시간 -> ' + found.control.pp.toFixed(2) + '%p' +
      (siblingResult ? ' | 형제 창(' + sibling.label + ') 대조 ' + siblingResult.hours + '시간 -> ' + siblingResult.pp.toFixed(2) + '%p' : ''));
    // Prefer whichever control actually observed hours.
    const control = found.control.hours ? found.control : (siblingResult ?? { hours: 0, pp: 0 });
    if (!best || found.target.pp > best.pp) best = { pp: found.target.pp, control: control.pp,
      controlHours: control.hours, hours: found.target.hours, usd: found.target.usd };
  }
  if (!best) {
    console.log('   관측 없음: 이 창에 대상 지출이 기록된 적이 없습니다.');
    // Absence of evidence cannot ratify a recorded confirmation.
    if (recorded.confirmed) { failures++; console.log('   !! 기록은 확인됨이라고 주장하지만 재현할 관측이 없습니다.'); }
    continue;
  }
  const derived = confirmScope({ at: 'now', spendHours: best.hours, spendUsd: best.usd,
    movedPp: Number(best.pp.toFixed(2)), control: 'reproduced', controlHours: best.controlHours,
    controlMovedPp: Number(best.control.toFixed(2)) });
  console.log('   재현: ' + (derived.confirmed ? '확인됨' : '미확인') + ' — ' + derived.reason);
  if (derived.confirmed !== recorded.confirmed) { failures++; console.log('   !! 기록과 재현이 불일치'); }
}

store.close();

// The disjoint sibling of an exclude scope is its include twin, and vice versa.
function siblingOf(scope, provider, account) {
  const twin = WINDOW_SCOPES.find(other => other !== scope && other.provider === scope.provider &&
    JSON.stringify(other.models) === JSON.stringify(scope.models) && Boolean(other.exclude) !== Boolean(scope.exclude));
  if (!twin) return null;
  const owner = provider?.accounts?.find(a => a.id === account);
  const window = owner?.windows?.find(w => twin.match(w));
  return window ? { id: window.id, label: window.label } : null;
}
if (failures) { console.error('\n' + failures + '건이 기록과 어긋납니다.'); process.exit(1); }
console.log('\n모든 스코프의 기록이 실제 히스토리로 재현됩니다.');
