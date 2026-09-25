// Which usage a quota window is consumed by. One declarative place: the estimator
// and the storage layer must not carry provider names.
//
// models absent  -> the window counts every request of its provider.
// models present -> only those model patterns (SQLite GLOB), or everything else
//                   when exclude is set. A row whose model is unknown stays in
//                   either form: we cannot tell which set it belongs to, so it
//                   must keep marking uncertainty rather than disappear.
// emitScope      -> this entry is part of the window's published identity. Only
//                   the two entries that already emit today set it; anything new
//                   stays internal so saved group keys and menu-bar pins survive.
// confirmation   -> observed evidence that this mapping is real. A model name or
//                   a vendor doc is not evidence.

export function confirmScope(record) {
  if (!record || !Number.isFinite(record.movedPp) || !Number.isFinite(record.controlMovedPp)) {
    return { confirmed: false, reason: '이 창의 대상 모델을 관측으로 확인한 기록이 없습니다.' };
  }
  if (!(record.movedPp > 0)) {
    return { confirmed: false, reason: '이 창의 대상 모델에 지출이 기록된 구간에서 창이 움직이지 않았습니다.' };
  }
  if (!(record.controlHours > 0)) {
    return { confirmed: false, reason: '이 매핑이 다른 한도와 구분된다는 대조 관측이 없습니다.' };
  }
  if (record.controlMovedPp > record.movedPp * 0.1) {
    return { confirmed: false, reason: '같은 구간에서 다른 한도도 함께 움직여 어느 쪽이 소모됐는지 가릴 수 없습니다.' };
  }
  return { confirmed: true,
    reason: `${record.at} 관측 · 대상 모델 지출 ${record.spendHours}시간에 이 창 ${record.movedPp}%p 이동, 대조군(${record.control}) ${record.controlHours}시간에 ${record.controlMovedPp}%p` };
}

export const WINDOW_SCOPES = [
  { id: 'fable', provider: 'anthropic', label: 'Fable 주간', emitScope: true,
    match: w => w.id.startsWith('custom-') && /^fable(?:\s+weekly|\s+주간)?$/i.test(String(w.label).trim()),
    models: ['claude-fable', 'claude-fable-[0-9]*'],
    confirmation: { at: '2026-09-13', spendHours: 5, spendUsd: 16.24, movedPp: 4.00,
      control: '비-Fable 모델만 지출한 구간', controlHours: 3, controlMovedPp: 0.00 } },
  { id: 'all', provider: 'anthropic', label: '전체 주간', emitScope: true,
    match: w => w.id === 'weekly' },
  { id: 'cursor-first-party', provider: 'cursor',
    match: w => w.id.startsWith('custom-') && /^first-party models$/i.test(String(w.label).trim()),
    models: ['grok-4.6'],
    confirmation: { at: '2026-09-13', spendHours: 10, spendUsd: 34.10, movedPp: 0.61,
      control: '같은 구간의 API 사용 창', controlHours: 10, controlMovedPp: 0.00 } },
  { id: 'cursor-api', provider: 'cursor',
    match: w => w.id.startsWith('custom-') && /^api usage$/i.test(String(w.label).trim()),
    models: ['grok-4.6'], exclude: true },
];

// Only these window ids are known to measure the provider as a whole. Anything
// else is a limit whose consumers we cannot name, and naming them is the point.
const STANDARD = ['five-hour', 'short', 'weekly', 'monthly'];

export function resolveScope(provider, window) {
  const entry = WINDOW_SCOPES.find(scope => scope.provider === provider.id && scope.match(window));
  if (entry) return entry;
  return STANDARD.includes(window.id) ? { id: 'all' } : null;
}

// A window may publish a dollar value only once its model set is confirmed. A
// scope that counts every request has nothing to confirm.
export function scopePublishes(scope) {
  if (!scope?.models?.length) return { ok: true, reason: null };
  const result = confirmScope(scope.confirmation);
  return { ok: result.confirmed, reason: result.reason };
}
