import {finite, usd, number, count, percent, date, STATES, PERIODS, periodLabel, age, reset, until, windowLabel, quotaFigure} from './format.js';
import {freshWindow, measurementReason, lookupDelay, coverage, periodState, excludedNote, cacheNote,
  directStatusNote, directStatusIsWarning, instantNote, limitStateNote, reconciliationNote,
  precisionNote, semanticsNote, nextAttemptNote, withheldReading} from './quota.js';
import {weeklyQuotaUsage} from './quota.js';
import {node, metric, quotaTrack, historyChart, methodology} from './dom.js';

// 표본 부족은 두 축이 따로 답한다. 요약 칸에는 상태어 하나만 두고 분수 전문은 title과
// 상세 줄로 보낸다. 네 절짜리 문구는 좁은 화면에서 요약 행 자체를 무너뜨린다.
function markPeriod(item, key, state, selectedPeriod, label) {
  item.dataset.period = key;
  item.dataset.periodState = state.state;
  item.dataset.record = state.record;
  item.dataset.observation = state.observation;
  // 행 글자에서 뺀 추정 사실은 셀에 남는다. 검사가 문구 대신 이 속성을 겨냥할 수 있다.
  if (state.partial) item.dataset.pricing = 'partial';
  if (state.cacheEstimated) item.dataset.cache = 'estimated';
  if (key === selectedPeriod) { item.classList.add('selected'); item.setAttribute('aria-current', 'true'); }
  item.title = [`${label} API 환산액`, state.estimateNote, state.coverageNote,
    state.record === 'partial' || state.record === 'none'
      ? '기록 길이는 보관된 사용 로그 전체의 속성이며 이 계정을 그만큼 관측했다는 뜻이 아닙니다.' : null]
    .filter(Boolean).join(' · ');
  return item;
}
export function periodGrid(analytics, selectedPeriod) {
  const grid = node('div', 'metrics usage-totals');
  for (const {key, label} of PERIODS) {
    const state = periodState(analytics?.periods, key);
    grid.append(markPeriod(metric(label, state.amount, state.note), key, state, selectedPeriod, label));
  }
  return grid;
}
function detailPeriod(key, selectedPeriod, changePeriod) {
  const label = node('label', 'detail-period');
  label.append(node('span', '', '조회 기간'));
  const select = node('select');
  select.dataset.focus = `period:${key}`;
  for (const {key, label} of PERIODS) {
    const option = node('option', '', label);
    option.value = key;
    option.selected = key === selectedPeriod;
    select.append(option);
  }
  select.addEventListener('change', () => changePeriod(select.value));
  label.append(select);
  return label;
}
function selectedRecommendation(provider, period) {
  return provider.analytics?.quotaRecommendations?.[period] ?? null;
}
export function recommendationView(rec) {
  const line = node('div', 'recommend');
  const ready = rec?.status !== 'collecting' && finite(rec?.recommendedAccounts);
  line.append(node('span', '', '필요 계정'), node('strong', '', ready ? `약 ${count.format(rec.recommendedAccounts)}개` : '—'));
  if (rec?.reason) line.title = rec.reason;
  if (rec?.usageStale) line.append(node('small', '', '이전 추정'));
  return line;
}
export function subscriptionNote(sub, ratio, basis) {
  if (!finite(sub?.monthlyUsd)) return '구독료 미확인';
  return `${sub.label} 월 ${usd(sub.monthlyUsd)}` +
    (sub.basis === 'user-confirmed' ? ' · 사용자 확인' : '') +
    (finite(ratio) ? ` · 구독료 대비 최근 30일 환산액 약 ${number.format(ratio)}배${['partial', 'lower-bound'].includes(basis) ? ' (일부 사용)' : ''}` : '');
}
export function windowAnalyticsView(w) {
  const a = w.analytics;
  const prior = !finite(a?.capacityApiUsd) ? a?.historicalCapacity : null;
  const value = prior?.apiUsd ?? a?.capacityApiUsd;
  const grid = node('div', 'quota-values');
  // '보수 추정' means unpriced quota movement was divided into the estimate. The value
  // keeps '≈': integer-percent rounding can still push it above the real limit.
  const capacity = metric('100% 한도', finite(value) ? `≈ ${usd(value)}` : '—',
    prior ? '이전 관측 추산' : a?.capacityBasis === 'workload-estimate' ? '작업 비율 추정' : a?.capacityBasis === 'lower-bound' ? '보수 추정' : a?.capacityBasis === 'partial' ? '일부 관측' : null);
  capacity.title = prior ? `${instantNote(prior.observedAt, value => date.format(value))} 기준 · ${prior.reason ?? ''}` : a?.capacityReason || a?.reason || '계산할 기록 없음';
  const remaining = prior ? prior.remainingApiUsd : a?.remainingApiUsd;
  const balance = metric(prior ? '마지막 관측 잔여분' : '잔여분', finite(remaining) ? `≈ ${usd(remaining)}` : '—',
    prior ? instantNote(prior.readingObservedAt, value => date.format(value)) : null);
  if (prior) balance.title = '현재 잔여량이 아닙니다. 마지막 측정 당시의 잔여율에 과거 한도 추산을 곱했습니다.';
  grid.append(capacity, balance);
  let eta = a?.status === 'collecting' ? '관측 중' : '—';
  if (a?.status === 'ok') {
    if (w.remainingPercent === 0) eta = '소진됨';
    else if (a.forecastRatePpHour === 0) eta = '소모 없음';
    else if (a.resetBeforeExhaustion) eta = '리셋이 먼저';
    else if (a.exhaustsAt) eta = Date.parse(a.exhaustsAt) <= Date.now() ? '예상 시각 지남' : until(a.exhaustsAt) || '—';
  }
  const forecast = metric('소진 예상', eta, a?.exhaustsAt && w.remainingPercent > 0 && a?.forecastObservedHours < 24 ? '초기 추정' : null);
  forecast.title = a?.exhaustsAt ? date.format(new Date(a.exhaustsAt)) : a?.reason || '계산할 기록 없음';
  grid.append(forecast);
  return grid;
}
export function windowView(account, w) {
  const fresh = freshWindow(account, w);
  const valid = finite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100;
  const item = node('div', `window${!fresh ? ' stale' : ''}${valid && w.remainingPercent < 20 ? ' low' : ''}`);
  const quota = node('div', 'window-quota');
  const title = node('div', 'window-title');
  const label = node('span', '', windowLabel(w)); label.title = w.label;
  title.append(label, node('strong', '', valid ? `${quotaFigure(w.remainingPercent)}% 남음` : '—'));
  const reason = fresh ? null : measurementReason(account, w);
  // Account status and observation age stay in the heading/metadata. Badges
  // identify window failures under a recent account observation.
  const observedAt = Date.parse(account.updatedAt), now = Date.now();
  const recentObservation = finite(observedAt) && observedAt <= now + 60000 && now - observedAt <= 15 * 60000;
  const ownReason = reason && recentObservation && !['reauth', 'paused', 'unavailable'].includes(account.status) ? reason : null;
  if (ownReason) title.append(node('span', 'badge warning', ownReason));
  const track = quotaTrack(valid ? w.remainingPercent : null, `${w.label} 남은 한도${reason ? ` · ${reason}` : ''}`);
  const meta = node('div', 'window-meta');
  const resetAt = Date.parse(w.resetAt);
  const resetLabel = ownReason && finite(resetAt) && resetAt <= Date.now()
    ? `리셋 ${date.format(new Date(resetAt))}` : reset(w.resetAt);
  meta.append(node('span', '', fresh || ownReason ? resetLabel : reason));
  if (w.resetAt && finite(Date.parse(w.resetAt))) meta.title = date.format(new Date(w.resetAt));
  quota.append(title, track, meta);
  const analytics = fresh ? w : {...w, analytics:{status:'stale', reason,
    historicalCapacity:w.analytics?.historicalCapacity ?? null}};
  item.append(quota, windowAnalyticsView(analytics));
  return item;
}
export function accountView(provider, a, selectedPeriod, changePeriod) {
  const article = node('article', 'account');
  const heading = node('div', 'account-heading');
  const name = node('span', 'account-name', a.label);
  name.title = a.label;
  heading.append(name);
  const sub = a.analytics?.subscription;
  if (sub?.monthlyUsd) heading.append(node('span','badge',sub.label));
  else if (a.plan === 'pro') heading.append(node('span','badge','Pro'));
  if (a.status === 'reauth') heading.append(node('span','badge warning','로그인 필요'));
  else if (a.status === 'paused') heading.append(node('span','badge','일시 중지'));
  const ratio = a.analytics?.monthlyValueRatio;
  const measurement = node('div','measurement');
  measurement.append(node('span','',age(a.updatedAt)));
  if (a.updatedAt && finite(Date.parse(a.updatedAt))) measurement.title = `마지막 측정: ${date.format(new Date(a.updatedAt))}`;
  const delay = lookupDelay(a);
  if (delay) {
    const note = node('span','refresh-note',delay);
    note.title = '사용량 조회에 실패했습니다. 마지막으로 성공한 측정값을 표시합니다.';
    if (finite(Date.parse(a.refresh.lastAttemptAt))) note.title += ` 마지막 조회 시도: ${date.format(new Date(a.refresh.lastAttemptAt))}`;
    measurement.append(note);
  }
  // 직접 수집이 이 계정에서 어떤 상태인지. ok 면 아무 말도 하지 않는다.
  const directNote = directStatusNote(a.directQuota?.status);
  if (directNote) {
    const warn = directStatusIsWarning(a.directQuota.status);
    const badge = node('span', `badge${warn ? ' warning' : ''} direct-status`, directNote);
    badge.dataset.directStatus = a.directQuota.status;
    if (a.directQuota.reason) badge.title = `사유: ${a.directQuota.reason}`;
    heading.append(badge);
  }
  const nextAttempt = nextAttemptNote(a);
  if (nextAttempt) {
    // Deliberately not .refresh-note. That class means "a usage lookup is behind", and two
    // existing checks count it to prove the warning appears exactly once per account that
    // earned it. A direct-read schedule is a different fact and gets its own class rather
    // than quietly inflating theirs.
    const note = node('span', 'direct-next', nextAttempt);
    note.dataset.directNext = a.directQuota.nextAttemptAt;
    note.title = '제공사 쿼타를 직접 조회하는 다음 시점입니다. 화면을 새로 고쳐도 앞당겨지지 않습니다.';
    measurement.append(note);
  }
  heading.append(measurement);
  article.append(heading);
  const primary = a.windows;
  if (primary.length) {
    const windows = node('div','windows');
    primary.forEach(w => windows.append(windowView(a,w)));
    article.append(windows);
  } else article.append(node('p','unavailable','쿼타 —'));
  const details = node('details','method account-details');
  details.dataset.expand = `account:${provider.id}:${a.id}`;
  details.append(node('summary','','사용 기록과 계산 근거'));
  details.append(detailPeriod(details.dataset.expand, selectedPeriod, changePeriod));
  // monthly 고정: 이 계정에 연결된 사용이 있는지의 존재 검사이지 기간 표시가 아니다.
  const linkedUsage = !a.ollama || a.analytics?.periods?.monthly?.requests > 0;
  if (linkedUsage) { details.append(node('h4', '', 'API 환산액')); details.append(periodGrid(a.analytics, selectedPeriod)); }
  else details.append(node('p','sub-note','호출 기록은 프로바이더 합계에 표시됩니다.'));
  details.append(node('p','sub-note',subscriptionNote(sub,ratio,a.analytics?.monthlyValueBasis)));
  const selected = periodState(a.analytics?.periods, selectedPeriod);
  const usage = a.analytics?.periods?.[selectedPeriod];
  const selectedLabel = periodLabel(selectedPeriod);
  const spanNote = selected.coverageNote ? ` · ${selected.coverageNote}` : '';
  if (linkedUsage && usage && usage.requests > 0) {
    const tokens = node('div','metrics');
    tokens.append(metric('입력 토큰',count.format(usage.inputTokens)),metric('출력 토큰',count.format(usage.outputTokens)),metric('캐시 읽기',count.format(usage.cachedTokens),'입력 토큰에 포함'));
    if (usage.cacheEstimatedRequests) tokens.append(metric('추정 캐시 읽기',count.format(usage.estimatedCachedTokens),'미보고 입력에 평균 비율 적용'));
    details.append(tokens);
    details.append(node('p','sub-note',`${selectedLabel} ${count.format(usage.requests)}회 호출 · 가격 확인 ${percent.format(coverage(usage)*100)}%` + spanNote));
    // 행에서 뺀 근거가 여기 모인다. '회 호출' 은 쓰지 않는다 — 위의 호출 줄을 찾는 검사가 있다.
    for (const line of [excludedNote(usage), cacheNote(usage),
      usage.localPriceRequests > 0 ? `로컬 카탈로그 단가 ${count.format(usage.localPriceRequests)}회` : null]) {
      if (line) details.append(node('p', 'sub-note', line));
    }
  // 호출이 없거나 미지원이면 토큰 분해를 만들지 않는다. 서버가 0으로 정규화한 값을
  // 측정된 0처럼 보이게 하는 것이 정확히 피해야 할 표시다.
  } else if (linkedUsage) details.append(node('p','sub-note',`${selectedLabel} ${selected.detailNote}` + spanNote));
  for (const w of a.windows) {
    const section = node('div','detail-window');
    section.append(node('h4','',w.label));
    if (finite(w.usedPercent)) section.append(node('p', 'sub-note', `${quotaFigure(w.usedPercent)}% 사용`));
    section.append(historyChart(w.analytics?.history,w.label));
    if (w.analytics?.capacityReason || w.analytics?.reason) section.append(node('p','sub-note',w.analytics.capacityReason || w.analytics.reason));
    if (finite(w.analytics?.capacityMatchedQuotaCoverage) && w.analytics.capacityMatchedQuotaCoverage < 1) section.append(node('p', 'sub-note', `사용액이 연결된 쿼타 변화 ${quotaFigure(w.analytics.capacityMatchedQuotaCoverage * 100)}%`));
    if (finite(w.analytics?.unexplainedDeltaPp) && w.analytics.unexplainedDeltaPp > 0) section.append(node('p', 'sub-note', `환산 못한 쿼타 변화 ${quotaFigure(w.analytics.unexplainedDeltaPp)}%p 포함`));
    // 창마다 자기 분모로 답한다. 5시간 창처럼 7일 안에 여러 주기가 들어가는 창은 100%p 를 넘을
    // 수 있고, 그때는 그것이 현재 사용률이 아니라 여러 주기의 합임을 회차로 드러낸다.
    const currentSamples = w.analytics?.consumptionPeriods;
    const historicalSample = !finite(currentSamples?.[selectedPeriod]?.deltaPp)
      ? w.analytics?.historicalConsumptionPeriods?.[selectedPeriod] : null;
    const samples = historicalSample ? w.analytics.historicalConsumptionPeriods : currentSamples;
    const consumed = samples ? samples[selectedPeriod]?.deltaPp : selectedPeriod === 'weekly' ? w.analytics?.forecastDeltaPp : null;
    if (finite(consumed)) section.append(node('p','sub-note', `${periodLabel(selectedPeriod)} ${samples?.[selectedPeriod]?.basis === 'observed-increase' ? '관측 증가분 추정' : '소모'} ≈ ${quotaFigure(consumed)}%p` +
      (historicalSample ? ` · 이전 관측 ${instantNote(historicalSample.periodEndedAt, value => date.format(value))}까지 · 현재 기간 미관측` : '') +
      (consumed > 100 ? ` · 이 한도 약 ${number.format(consumed / 100)}회분` : '') +
      (samples?.[selectedPeriod]?.recoveredHours > 0 ? ` · 공백 복원 ${quotaFigure(samples[selectedPeriod].recoveredDeltaPp)}%p 포함` : '')));
    if (finite(w.analytics?.forecastRatePpHour)) section.append(node('p','sub-note', `평균 ${quotaFigure(w.analytics.forecastRatePpHour)}%p/시간 · ${number.format(w.analytics.forecastObservedHours)}시간 관측`));
    // 이 숫자가 무엇에 근거하는가. 제공사가 준 값과 우리가 나눈 값을 나란히 두고, 어느 쪽도
    // 다른 쪽으로 고치지 않는다.
    basisRows(w.measurement).forEach(row => section.append(row));
    details.append(section);
  }
  directQuotaBlocks(a).forEach(block => details.append(block));
  if (a.ollama) {
    const calibration = node('div','detail-window');
    calibration.append(node('h4','','모델별 쿼타 관측'));
    let rows = 0;
    for (const w of a.ollama.windows) for (const m of w.models) {
      rows++;
      calibration.append(node('p','sub-note',`${w.label} · ${m.model} · 1%p 순증가당 입력 ${count.format(m.inputTokensPerPp)} / 출력 ${count.format(m.outputTokensPerPp)} 토큰 · 환산 ${usd(m.apiUsdPerPp)} · ${m.requests}회 관측`));
      calibration.append(node('p','sub-note',`같은 작업 비율로 100% 추산: 입력 ${count.format(m.inputTokensPerPp * 100)} / 출력 ${count.format(m.outputTokensPerPp * 100)} 토큰 · 환산 ${finite(m.apiUsdPerPp) ? usd(m.apiUsdPerPp * 100) : '—'}`));
    }
    if (!rows) calibration.append(node('p','unavailable','단일 모델 사용 구간 수집 중'));
    calibration.append(node('p','sub-note','관측 구간의 입출력 비율 기준 추산입니다. 공식 한도가 아니며 모델별·기간별 값은 더하지 않습니다. 리셋 주기·캐시 할인·호출별 정확한 차감량은 확인되지 않았습니다.'));
    details.append(calibration);
  }
  if (sub?.reason) details.append(node('p','unavailable',sub.reason));
  article.append(details);
  return article;
}
export function providerAnalytics(p, ctx) {
  const wrap = node('div', 'provider-analytics');
  const title = node('div', 'section-caption');
  title.append(node('h4', '', 'API 환산액'), node('span', '', '전체 계정 합계'));
  wrap.append(title, periodGrid(p.analytics, null));
  if (finite(p.analytics?.subscriptionMonthlyUsd)) wrap.append(node('p', 'sub-note', `현재 월 구독료 ${usd(p.analytics.subscriptionMonthlyUsd)} · 전체 등록 계정`));
  const cache = p.analytics?.cacheAssumption;
  if (cache) {
    const stats = p.analytics.periods?.[ctx.selectedPeriod];
    const note = finite(cache.appliedRate)
      ? `캐시 ${percent.format(cache.appliedRate * 100)}% 가정 · Ollama와 같은 최근 30일 실측 평균 · 입력·출력 토큰도 추정값` + (cache.stale ? ' · 이전 평균 사용' : '')
      : '캐시 평균을 계산할 실측 자료가 없어 캐시 할인을 적용하지 않았습니다.';
    wrap.append(node('p','sub-note',note));
    if (stats?.cacheEstimatedRequests) wrap.append(node('p','sub-note',`${periodLabel(ctx.selectedPeriod)} 캐시 미적용 ${usd(stats.noCacheApiUsd)} → 추정 캐시 적용 ${usd(stats.apiUsd)}`));
  }
  if (p.analytics?.unpricedModels?.length) wrap.append(node('p','sub-note',`최근 30일 미환산: ${p.analytics.unpricedModels.map(m=>`${m.model || '모델 미기록'} ${count.format(m.requests)}회`).join(', ')} · 기준 단가가 없어 환산에서 제외`));
  const details = node('details', 'method provider-details');
  details.dataset.expand = `provider:${p.id}`;
  details.append(node('summary', '', '사용 예상과 필요 계정'));
  details.append(detailPeriod(details.dataset.expand, ctx.selectedPeriod, ctx.changePeriod));
  const pace = p.analytics?.pace, rec = selectedRecommendation(p, ctx.selectedPeriod);
  if (pace?.stale) details.append(node('p', 'sub-note', '이전 사용 기록 기준'));
  if (finite(rec?.currentAccounts)) details.append(node('p', 'sub-note', `현재 ${count.format(rec.currentAccounts)}개 계정`));
  const projections = node('div', 'metrics');
  // 사용 예상은 기존 7일 표본을, 필요 계정은 선택 기간의 평균 속도를 쓴다.
  const paceBasis = pace?.basisPeriod === 'weekly' ? '최근 7일 속도 기준' : null;
  const demand = rec?.demandBasis === 'quota-consumption' ? periodLabel(ctx.selectedPeriod) + ' 소모 합계 기준' : rec?.demandBasis === 'recent-week' ? '최근 7일 수요 기준'
    : rec?.demandBasis === 'monthly-baseline' ? '최근 30일 평균 기준' : null;
  const demandBasis = demand ? `${demand} · ${rec?.windowId === 'monthly' ? '월간' : '주간'} 한도 기준` : null;
  projections.append(metric('5시간 사용 예상', usd(pace?.projectedFiveHourUsd), paceBasis), metric('7일 사용 예상', usd(pace?.projectedWeekUsd), paceBasis), metric('필요 계정', finite(rec?.recommendedAccounts) ? `약 ${count.format(rec.recommendedAccounts)}개` : '—', demandBasis));
  details.append(projections);
  const capacities = node('div', 'metrics');
  for (const [id, label] of [['five-hour', '5시간 한도'], ['weekly', '주간 한도']]) {
    const measured = p.accounts.flatMap(a => {
      const w = a.windows.find(w => w.id === id || (id === 'five-hour' && w.id === 'short' && w.label === '5시간'));
      const current = w && freshWindow(a, w) && finite(w.analytics?.capacityApiUsd);
      const prior = w?.analytics?.historicalCapacity;
      const value = current ? w.analytics.capacityApiUsd : prior?.apiUsd;
      return finite(value) && value > 0 ? [{value, historical:!current,
        basis:current ? w.analytics.capacityBasis : prior.basis, at:prior?.observedAt}] : [];
    });
    const average = measured.length ? measured.reduce((sum, row) => sum + row.value, 0) / measured.length : null;
    const conservative = measured.filter(row => row.basis === 'lower-bound').length;
    const historical = measured.filter(row => row.historical);
    const item = metric(label, finite(average) ? `≈ ${usd(average)}` : '—',
      measured.length ? `${measured.length}개 계정 평균${historical.length ? ` · ${historical.length}개 이전 관측` : ''}${conservative ? ` · ${conservative}개는 보수 추정` : ''}` : '관측 부족');
    if (historical.length) item.title = '이전 한도 추산 기준: ' + historical.map(row => instantNote(row.at, value => date.format(value))).join(', ');
    capacities.append(item);
  }
  capacities.append(metric('예상 구독료', usd(rec?.estimatedMonthlyUsd), '계정별 월 구독료 기준'));
  details.append(capacities);
  if (rec?.reason) details.append(node('p', 'sub-note', rec.reason));
  if (p.analytics?.unattributed?.requests) details.append(node('p','sub-note',`최근 7일 계정 미연결 ${usd(p.analytics.unattributed.apiUsd)} (전체 합계에 포함)`));
  for (const {key, label} of PERIODS) {
    const stats = p.analytics?.periods?.[key];
    if (!stats) continue;
    const state = periodState(p.analytics?.periods, key);
    const excluded = excludedNote(stats, {lead:'미확인', compact:true});
    const line = node('p', 'sub-note', `${label} ${count.format(stats.requests)}회 호출 · 단가 확인 ${percent.format(coverage(stats) * 100)}%` +
      (stats.localPriceRequests ? ` · 토큰·캐시·단가 추정 ${count.format(stats.localPriceRequests)}회` : '') +
      (excluded ? ` · ${excluded}` : '') +
      (state.coverageNote ? ` · ${state.coverageNote}` : ''));
    line.dataset.period = key;
    if (key === ctx.selectedPeriod) line.classList.add('selected-period');
    details.append(line);
  }
  wrap.append(details);
  return wrap;
}
export function topEfficiency(ctx) {
  const notes = [
    '남은 한도는 같은 한도끼리 계정별 잔여율을 평균합니다. 플랜별 용량 차이는 반영하지 않으며, 조회 불가·만료된 측정은 제외합니다.',
    'API 환산액은 기록된 토큰을 API 단가로 계산합니다. 단가를 확인하지 못한 사용은 합계에서 빼고 행에는 일부로 표시하며, 빠진 호출과 토큰은 계정·프로바이더 상세에서 확인합니다.',
    '100% 한도 = 같은 관측 구간의 API 환산액 ÷ 소모량(%p) × 100. 잔여분은 이 추정치에 잔여율을 곱합니다. 한도별 금액은 중복되므로 더하지 않습니다.',
    '선택 기간의 쿼타 소모 합계는 제공자 전체를 재는 주간(없으면 월간) 한도 창에서 계정별로 관측한 증가분을 더한 추정입니다. 수집 공백과 리셋 구간은 빠지고 1%p 이하 하향 보정은 상한으로 평탄화하므로 확정 소모량이 아니며, 현재 한도 사용률과도 다른 값입니다. 서로 다른 한도의 비율은 더하지 않습니다.',
    '소진 예상은 최근 7일의 관측된 소모 속도로 계산합니다. 유휴 시간은 포함하고, 수집 공백과 리셋 구간은 제외합니다.',
    '필요 계정은 쿼타 소모 합계 ÷ 100 × (한도 주기 ÷ 선택 기간)을 올림한 값입니다. 주간은 7일, 월간은 30일로 계산합니다. 여유분은 더하지 않으며, 관측이 부족하면 실제 필요량보다 적을 수 있습니다.',
    '사용액은 OpenCodex 기록 기준입니다. 외부 앱 사용과 갱신 지연은 한도 환산에 영향을 줍니다. 구독료 비교는 최근 30일 사용액과 사용자 확인 구독료(없으면 확인된 정가)를 사용합니다.',
  ];
  const catalog = ctx.snapshot.analytics?.pricingCatalog;
  if (catalog) notes.push(`등록된 기준 단가로 자동 계산하며, 없는 모델은 로컬 카탈로그의 동일 제공자·모델 단가를 사용합니다. 카탈로그 ${catalog.status === 'ok' ? '정상' : catalog.status === 'stale' ? '이전 자료 사용' : '조회 불가'}.`);
  document.getElementById('efficiency').replaceChildren(methodology({sources:ctx.snapshot.analytics?.sources, notes}, {key:'top-method',title:'계산 기준과 단가 출처'}));
  if (finite(ctx.snapshot.analytics?.subscriptionMonthlyUsd)) document.getElementById('efficiency').prepend(node('p', 'sub-note', `등록 계정 월 구독료 합계 ${usd(ctx.snapshot.analytics.subscriptionMonthlyUsd)}`));
}
export function quotaOverview(p) {
  const groups = new Map();
  for (const a of p.accounts) for (const w of a.windows) {
    const key = `${w.id.startsWith('custom-') ? 'custom' : w.id}:${w.usageScope || ''}:${w.label}`;
    if (!groups.has(key)) groups.set(key, {label:windowLabel(w), fullLabel:w.label, remaining:0, accounts:0});
    if (!freshWindow(a, w)) continue;
    const group = groups.get(key); group.remaining += w.remainingPercent; group.accounts++;
  }
  const values = node('div', 'quota-bars');
  values.append(node('span', 'mobile-quota-caption', '남은 한도 · 계정 평균'));
  for (const g of groups.values()) {
    const remaining = g.accounts ? g.remaining / g.accounts : null;
    const bar = node('div', `quota-bar${remaining === null ? ' stale' : remaining < 20 ? ' low' : ''}`);
    const caption = node('div', 'quota-caption');
    caption.append(node('span', '', g.label), node('strong', '', remaining === null ? '—' : `${quotaFigure(remaining)}% 남음`));
    bar.title = remaining === null ? `${g.fullLabel}: 최근 측정 없음` : `${g.fullLabel}: 측정된 ${g.accounts}개 계정의 평균 잔여율`;
    bar.append(caption, quotaTrack(remaining, `${p.name} ${g.fullLabel}, ${g.accounts}개 계정 평균 잔여율`));
    if (remaining === null) bar.append(node('p', 'quota-note', '최근 측정 없음'));
    values.append(bar);
  }
  if (!groups.size) values.append(node('p', 'unavailable', '한도 조회 불가'));
  return values;
}
// 선택 기간 쿼타 소모 한 칸. 고를 창과 계정 합계와 상태는 quota.js 가 이미 끝냈고 여기서는
// 그리기만 한다. 열 머리가 금액만 가리키므로 이 칸은 데스크톱에서도 자기 라벨을 달고 있다.
function quotaUsageCell(provider, period) {
  const usage = weeklyQuotaUsage(provider, period);
  const cell = metric(`${periodLabel(period)} 쿼타 소모 합계`, usage.value);
  cell.classList.add('quota-used');
  cell.dataset.quotaUsage = usage.state;
  if (usage.windowId) cell.dataset.quotaWindow = usage.windowId;
  cell.title = [usage.note, usage.title].filter(Boolean).join('. ');
  return cell;
}
export function overviewView(providers, ctx) {
  const list = node('section', 'summary-list');
  list.setAttribute('aria-label', '제공자별 사용 현황');
  const header = node('div', 'summary-columns');
  // 이 응답이 선택 기간을 아예 모르면 열 머리에서 먼저 말한다. 다른 기간 값으로 메우지 않는다.
  const unsupported = providers.length > 0 &&
    providers.every(p => periodState(p.analytics?.periods, ctx.selectedPeriod).state === 'unsupported');
  header.append(node('span', '', '제공자'), node('span', '', '남은 한도 · 계정 평균'),
    node('span', '', `${periodLabel(ctx.selectedPeriod)} API 환산액` + (unsupported ? ' · 미지원' : '')));
  list.append(header);
  for (const p of providers) {
    const row = node('article', 'summary-provider');
    const identity = node('div', 'summary-identity');
    const button = node('button', 'provider-link', p.name);
    button.dataset.focus = `provider:${p.id}`;
    button.addEventListener('click', () => ctx.select(p.id));
    const title = node('h3'); title.append(button);
    identity.append(title, node('span', '', `${p.accounts.length}개 계정`));
    const concerns = [];
    if (!p.enabled) concerns.push('연결 비활성');
    for (const [key, label] of Object.entries(STATES)) {
      const total = p.accounts.filter(a => a.status === key).length;
      if (total) concerns.push(`${label} ${total}`);
    }
    const delayed = p.accounts.filter(a => a.status === 'ok' && a.refresh?.status === 'delayed').length;
    if (delayed) concerns.push(`갱신 지연 ${delayed}`);
    if (concerns.length) identity.append(node('small', 'attention', concerns.join(' · ')));
    const state = periodState(p.analytics?.periods, ctx.selectedPeriod);
    const label = periodLabel(ctx.selectedPeriod);
    const usage = node('div', 'summary-usage');
    const amount = markPeriod(metric(`${label} 환산액`, state.amount, state.note), ctx.selectedPeriod, state, ctx.selectedPeriod, label);
    // 금액이 첫 metric 으로 남아야 한다. scripts/ui-flow.mjs 와 scripts/ui-check.mjs 가
    // .summary-usage 의 첫 .metric > strong 을 기간별 환산액으로 읽는다.
    usage.append(amount, quotaUsageCell(p, ctx.selectedPeriod), recommendationView(selectedRecommendation(p, ctx.selectedPeriod)));
    row.append(identity, quotaOverview(p), usage);
    list.append(row);
  }
  if (!providers.length) list.append(node('div', 'empty', ctx.snapshot?.analytics?.status === 'collecting'
    ? '저장된 사용 기록을 불러오고 있습니다.'
    : '연결된 제공자가 없습니다. OpenCodex에서 계정을 연결해 주세요.'));
  return list;
}
export function renderOrderEditor(providers, ctx) {
  const host = document.getElementById('provider-order-list');
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.orderMove : null;
  host.replaceChildren();
  providers.forEach((p, index) => {
    const row = node('div', 'order-row');
    row.append(node('span', '', p.name));
    for (const [direction, label] of [[-1, '위로'], [1, '아래로']]) {
      const button = node('button', 'order-move', label);
      button.dataset.orderMove = `${p.id}:${direction}`;
      button.setAttribute('aria-label', `${p.name} ${label}`);
      button.disabled = index + direction < 0 || index + direction >= providers.length;
      button.addEventListener('click', () => {
        const ids = providers.map(item => item.id);
        [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
        ctx.providerOrder = ids;
        try { localStorage.setItem(ctx.ORDER_KEY, JSON.stringify(ids)); ctx.orderStorageFailed = false; }
        catch { ctx.orderStorageFailed = true; }
        ctx.render();
        const buttons = [...host.querySelectorAll('button')];
        (buttons.find(b => b.dataset.orderMove === `${p.id}:${direction}` && !b.disabled) ||
          buttons.find(b => b.dataset.orderMove === `${p.id}:${-direction}` && !b.disabled))?.focus({preventScroll:true});
      });
      row.append(button);
    }
    host.append(row);
  });
  document.getElementById('provider-order-note').textContent = ctx.orderStorageFailed ? '저장할 수 없어 현재 탭에서만 유지됩니다.' : '이 브라우저에 자동 저장됩니다.';
  if (focused) [...host.querySelectorAll('button')].find(b => b.dataset.orderMove === focused && !b.disabled)?.focus({preventScroll:true});
}

// --- 직접 수집 근거 (JUN-124) ---

// 한 measurement 의 계산 근거. 원본 값과 계산값을 같은 자리에 두되 합치지 않는다.
// 서로 다른 source 나 scopeKey 를 가진 값은 애초에 이 함수에 함께 들어오지 않는다 —
// 행 하나가 창 하나의 근거이고, 창을 가로질러 더하는 자리는 만들지 않는다.
export function basisRows(measurement) {
  if (!measurement || typeof measurement !== 'object') return [];
  const rows = [];
  const grid = node('div', 'metrics measurement-basis');
  grid.dataset.basisSource = measurement.source ?? '';
  grid.dataset.basisScope = measurement.scopeKey ?? '';
  grid.dataset.limitState = measurement.limitState ?? '';
  grid.dataset.reconciliation = measurement.reconciliation ?? '';
  // 제공사가 보고한 비율과 우리가 used/limit 으로 나눈 비율. 한쪽이 없으면 없다고 적는다.
  grid.append(metric('제공사 보고', measurement.reportedPercent === null ? '미보고'
    : `${quotaFigure(measurement.reportedPercent)}%`));
  grid.append(metric('계산값', measurement.calculatedPercent === null ? '계산 불가'
    : `${quotaFigure(measurement.calculatedPercent)}%`, limitStateNote(measurement) ?? undefined));
  // 원본 수량. 단위를 함께 적지 않으면 크레딧과 센트가 같은 숫자로 보인다.
  const unit = measurement.unit ? ` ${measurement.unit}` : '';
  grid.append(metric('사용량', measurement.used === null ? '미제공' : `${quotaFigure(measurement.used)}${unit}`));
  grid.append(metric('한도', measurement.limit === null
    ? (limitStateNote(measurement) ?? '미제공') : `${quotaFigure(measurement.limit)}${unit}`));
  rows.push(grid);
  // 이 값들은 data-* 에도 있지만 거기에만 두면 안 된다. 근거를 확인한다는 것은 사람이 읽을
  // 수 있다는 뜻이고, 개발자 도구를 열어야 보이는 것은 확인이 아니다.
  const facts = node('div', 'metrics measurement-origin');
  facts.append(metric('읽은 곳', measurement.source ?? '미제공'));
  facts.append(metric('집계 범위', measurement.scopeKey ?? '미제공'));
  facts.append(metric('주기 키', measurement.cycleKey ?? '미제공'));
  facts.append(metric('단위', measurement.unit ?? '미제공'));
  rows.push(facts);
  // 계약이 null 을 허용하는 자리와, 값이 있는데 읽히지 않는 자리를 구분한다. 잘못된 시각을
  // 그대로 Date 에 넣으면 RangeError 가 나고 화면 전체가 그리다 만다.
  const notes = [reconciliationNote(measurement), semanticsNote(measurement), precisionNote(measurement),
    `관측 ${instantNote(measurement.observedAt, value => date.format(value))}`,
    `조회 ${instantNote(measurement.fetchedAt, value => date.format(value))}`];
  for (const line of notes) if (line) rows.push(node('p', 'sub-note', line));
  return rows;
}

// 계정 수준의 직접 수집 상태와, 창이 되지 못한 근거들.
export function directQuotaBlocks(a) {
  const direct = a.directQuota;
  if (!direct || typeof direct !== 'object') return [];
  const blocks = [];
  // 비율이 없어 창으로 나가지 못한 읽기. 여기에는 usedPercent 가 아예 없으므로 막대도
  // 남은 양도 그리지 않는다. 0 으로 채우면 측정되지 않은 것을 측정된 0 으로 만든다.
  for (const row of Array.isArray(direct.evidence) ? direct.evidence : []) {
    const section = node('div', 'detail-window evidence-window');
    section.dataset.evidenceWindow = row.id;
    section.dataset.evidenceEndpoint = row.endpointId ?? '';
    section.append(node('h4', '', row.label ?? row.id));
    section.append(node('p', 'sub-note', '비율을 계산할 수 없어 근거만 보관합니다.'));
    if (row.stale) section.append(node('span', 'badge warning', '오래된 관측'));
    basisRows(row.measurement).forEach(node_ => section.append(node_));
    blocks.push(section);
  }
  // 보류된 계정이 들고 있는 마지막 읽기. 현재 가용량이 아니라는 것이 이 블록의 요점이다.
  const withheld = withheldReading(a);
  if (withheld) {
    const section = node('div', 'detail-window last-known');
    section.dataset.lastKnown = withheld.accountStatus ?? '';
    section.append(node('h4', '', '마지막으로 읽은 값'));
    section.append(node('p', 'sub-note', withheld.accountStatus === 'paused'
      ? '일시 중지된 계정이라 현재 가용량으로 쓰지 않습니다.'
      : '로그인 갱신이 필요해 현재 가용량으로 쓰지 않습니다.'));
    if (!withheld.windows.length) section.append(node('p', 'unavailable', '보관된 읽기 없음'));
    for (const w of withheld.windows) {
      const line = node('p', 'sub-note', `${windowLabel(w)} · ${quotaFigure(w.usedPercent)}% 사용`
        + ` · ${instantNote(w.measuredAt, value => date.format(value))} 관측`);
      line.dataset.lastKnownWindow = w.id;
      section.append(line);
    }
    blocks.push(section);
  }
  return blocks;
}
