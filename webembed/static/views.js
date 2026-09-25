import { finite, usd, number, count, percent, date, STATES, PERIODS, periodLabel, age, reset, until, windowLabel, quotaFigure } from './format.js';
import { freshWindow, measurementReason, lookupDelay, coverage, periodState, excludedNote, cacheNote, directStatusNote, directStatusIsWarning, instantNote, limitStateNote, reconciliationNote, precisionNote, semanticsNote, nextAttemptNote, withheldReading } from './quota.js';
import { weeklyQuotaUsage } from './quota.js';
import { node, svg, metric, quotaTrack, historyChart, methodology } from './dom.js';
import { asPeriodKey, asRecord, directQuota, num, periodMap, recommendationOf, refreshState, str, subscriptionInfo, windowAnalytics } from './types.js';
function requireNode(id) {
    const el = document.getElementById(id);
    if (!el)
        throw new Error(`missing-control:${id}`);
    return el;
}
function htmlEl(el) {
    return el instanceof HTMLElement ? el : null;
}
function winA(w) {
    return windowAnalytics(w.analytics) ?? {};
}
function accountPeriods(a) {
    return periodMap(asRecord(a.analytics)?.periods);
}
function providerPeriods(p) {
    return periodMap(asRecord(p.analytics)?.periods);
}
function parseOllama(value) {
    const o = asRecord(value);
    if (!o || !Array.isArray(o.windows))
        return null;
    return {
        windows: o.windows.map(row => {
            const w = asRecord(row) ?? {};
            const models = Array.isArray(w.models) ? w.models : [];
            return {
                label: str(w.label) ?? '',
                models: models.map(item => {
                    const m = asRecord(item) ?? {};
                    return {
                        model: str(m.model) ?? '',
                        inputTokensPerPp: num(m.inputTokensPerPp) ?? 0,
                        outputTokensPerPp: num(m.outputTokensPerPp) ?? 0,
                        apiUsdPerPp: num(m.apiUsdPerPp),
                        requests: num(m.requests) ?? 0,
                    };
                }),
            };
        }),
    };
}
function sourcesOf(value) {
    if (!Array.isArray(value))
        return [];
    return value.map(item => {
        const o = asRecord(item) ?? {};
        return {
            url: str(o.url) ?? undefined,
            label: str(o.label) ?? undefined,
            checkedAt: str(o.checkedAt) ?? undefined,
        };
    });
}
// 표본 부족은 두 축이 따로 답한다. 요약 칸에는 상태어 하나만 두고 분수 전문은 title과
// 상세 줄로 보낸다. 네 절짜리 문구는 좁은 화면에서 요약 행 자체를 무너뜨린다.
function markPeriod(item, key, state, selectedPeriod, label) {
    item.dataset.period = key;
    item.dataset.periodState = state.state;
    item.dataset.record = state.record;
    item.dataset.observation = state.observation;
    // 행 글자에서 뺀 추정 사실은 셀에 남는다. 검사가 문구 대신 이 속성을 겨냥할 수 있다.
    if (state.partial)
        item.dataset.pricing = 'partial';
    if (state.cacheEstimated)
        item.dataset.cache = 'estimated';
    if (key === selectedPeriod) {
        item.classList.add('selected');
        item.setAttribute('aria-current', 'true');
    }
    item.title = [`${label} API 환산액`, state.estimateNote, state.coverageNote,
        state.record === 'partial' || state.record === 'none'
            ? '기록 길이는 보관된 사용 로그 전체의 속성이며 이 계정을 그만큼 관측했다는 뜻이 아닙니다.' : null]
        .filter(Boolean).join(' · ');
    return item;
}
export function periodGrid(analytics, selectedPeriod) {
    const grid = node('div', 'metrics usage-totals');
    for (const { key, label } of PERIODS) {
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
    for (const { key, label } of PERIODS) {
        const option = node('option', '', label);
        option.value = key;
        option.selected = key === selectedPeriod;
        select.append(option);
    }
    select.addEventListener('change', () => changePeriod(asPeriodKey(select.value)));
    label.append(select);
    return label;
}
function selectedRecommendation(provider, period) {
    const recs = asRecord(asRecord(provider.analytics)?.quotaRecommendations);
    return recs ? recommendationOf(recs[period]) : null;
}
export function recommendationView(rec) {
    const line = node('div', 'recommend');
    const ready = rec?.status !== 'collecting' && finite(rec?.recommendedAccounts);
    line.append(node('span', '', '필요 계정'), node('strong', '', ready && rec ? `약 ${count.format(rec.recommendedAccounts ?? 0)}개` : '—'));
    const r = rec;
    if (ready && r && finite(r.totalConsumedPp)) {
        line.title = `${periodLabel(r.basisPeriod ?? '')} 동안 관측된 쿼타 소모 ${quotaFigure(r.totalConsumedPp)}%p (${r.sampleAccounts ?? 0}개 계정 합계)를 한도 주기로 환산했습니다. ${r.reason ?? ''}`;
    }
    else if (rec?.reason)
        line.title = rec.reason;
    return line;
}
export function subscriptionNote(sub, ratio, basis) {
    if (!finite(sub?.monthlyUsd))
        return '구독료 미확인';
    return `${sub.label ?? ''} 월 ${usd(sub.monthlyUsd)}` +
        (sub.basis === 'user-confirmed' ? ' · 사용자 확인' : '') +
        (finite(ratio) ? ` · 구독료 대비 최근 30일 환산액 약 ${number.format(ratio)}배${['partial', 'lower-bound'].includes(basis ?? '') ? ' (일부 사용)' : ''}` : '');
}
export function windowAnalyticsView(w) {
    const a = winA(w);
    const prior = !finite(a.capacityApiUsd) ? a.historicalCapacity : null;
    const value = prior?.apiUsd ?? a.capacityApiUsd;
    const grid = node('div', 'quota-values');
    // '보수 추정' means unpriced quota movement was divided into the estimate. The value
    // keeps '≈': integer-percent rounding can still push it above the real limit.
    const capacity = metric('100% 한도', finite(value) ? `≈ ${usd(value)}` : '—', prior ? null : a?.capacityBasis === 'workload-estimate' ? '작업 비율 추정' : a?.capacityBasis === 'lower-bound' ? '보수 추정' : a?.capacityBasis === 'partial' ? '일부 관측' : null);
    capacity.title = prior ? `${instantNote(prior.observedAt, value => date.format(value))} 기준 · ${prior.reason ?? ''}` : a.capacityReason || a.reason || '계산할 기록 없음';
    const remaining = prior ? prior.remainingApiUsd : a.remainingApiUsd;
    const balance = metric('잔여분', finite(remaining) ? `≈ ${usd(remaining)}` : '—');
    if (prior)
        balance.title = '현재 잔여량이 아닙니다. 마지막 측정 당시의 잔여율에 과거 한도 추산을 곱했습니다.';
    grid.append(capacity, balance);
    let eta = a.status === 'collecting' ? '관측 중' : '—';
    if (a.status === 'ok') {
        if (w.remainingPercent === 0)
            eta = '소진됨';
        else if (a.forecastRatePpHour === 0)
            eta = '소모 없음';
        else if (a.resetBeforeExhaustion)
            eta = '리셋이 먼저';
        else if (a.exhaustsAt)
            eta = Date.parse(a.exhaustsAt) <= Date.now() ? '예상 시각 지남' : until(a.exhaustsAt) || '—';
    }
    const forecast = metric('소진 예상', eta, a.exhaustsAt && (w.remainingPercent ?? 0) > 0 && (a.forecastObservedHours ?? 0) < 24 ? '초기 추정' : null);
    forecast.title = a.exhaustsAt ? date.format(new Date(a.exhaustsAt)) : a.reason || '계산할 기록 없음';
    grid.append(forecast);
    return grid;
}
export function windowView(account, w) {
    const fresh = freshWindow(account, w);
    const valid = finite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100;
    const item = node('div', `window${!fresh ? ' stale' : ''}${valid && (w.remainingPercent ?? 0) < 20 ? ' low' : ''}`);
    const quota = node('div', 'window-quota');
    const title = node('div', 'window-title');
    const label = node('span', '', windowLabel(w));
    label.title = w.label;
    title.append(label, node('strong', '', valid ? `${quotaFigure(w.remainingPercent)}% 남음` : '—'));
    const reason = fresh ? null : measurementReason(account, w);
    // Account status and observation age stay in the heading/metadata. Badges
    // identify window failures under a recent account observation.
    const observedAt = Date.parse(account.updatedAt ?? ''), now = Date.now();
    const recentObservation = finite(observedAt) && observedAt <= now + 60000 && now - observedAt <= 15 * 60000;
    const ownReason = reason && recentObservation && !['reauth', 'paused', 'unavailable'].includes(account.status) ? reason : null;
    if (ownReason)
        title.append(node('span', 'badge warning', ownReason));
    const track = quotaTrack(valid ? w.remainingPercent : null, `${w.label} 남은 한도${reason ? ` · ${reason}` : ''}`);
    const meta = node('div', 'window-meta');
    const resetAt = Date.parse(w.resetAt ?? '');
    const resetLabel = ownReason && finite(resetAt) && resetAt <= Date.now()
        ? `리셋 ${date.format(new Date(resetAt))}` : reset(w.resetAt);
    meta.append(node('span', '', fresh || ownReason ? resetLabel : reason ?? ''));
    if (w.resetAt && finite(Date.parse(w.resetAt)))
        meta.title = date.format(new Date(w.resetAt));
    quota.append(title, track, meta);
    const analytics = fresh ? w : { ...w, analytics: { status: 'stale', reason,
            historicalCapacity: winA(w).historicalCapacity ?? null } };
    item.append(quota);
    if (!['paused', 'reauth', 'unavailable'].includes(account.status))
        item.append(windowAnalyticsView(analytics));
    return item;
}
export function accountView(provider, a, selectedPeriod, changePeriod) {
    const article = node('article', 'account');
    const heading = node('div', 'account-heading');
    const name = node('span', 'account-name', a.label);
    name.title = a.label;
    heading.append(name);
    const sub = subscriptionInfo(asRecord(a.analytics)?.subscription);
    if (sub?.monthlyUsd)
        heading.append(node('span', 'badge', sub.label ?? ''));
    else if (a.plan === 'pro')
        heading.append(node('span', 'badge', 'Pro'));
    if (a.status === 'reauth')
        heading.append(node('span', 'badge warning', '로그인 필요'));
    else if (a.status === 'paused')
        heading.append(node('span', 'badge', '일시 중지'));
    const ratio = a.analytics?.monthlyValueRatio;
    const measurement = node('div', 'measurement');
    measurement.append(node('span', '', age(a.updatedAt)));
    if (a.updatedAt && finite(Date.parse(a.updatedAt)))
        measurement.title = `마지막 측정: ${date.format(new Date(a.updatedAt))}`;
    const delay = lookupDelay(a);
    if (delay) {
        const note = node('span', 'refresh-note', delay);
        note.title = '사용량 조회에 실패했습니다. 마지막으로 성공한 측정값을 표시합니다.';
        const lastAttempt = refreshState(a.refresh)?.lastAttemptAt;
        if (lastAttempt && finite(Date.parse(lastAttempt)))
            note.title += ` 마지막 조회 시도: ${date.format(new Date(lastAttempt))}`;
        measurement.append(note);
    }
    // 직접 수집이 이 계정에서 어떤 상태인지. ok 면 아무 말도 하지 않는다.
    const dq = directQuota(a.directQuota);
    const directNote = directStatusNote(dq?.status);
    if (directNote && dq) {
        const warn = directStatusIsWarning(dq.status);
        const badge = node('span', `badge${warn ? ' warning' : ''} direct-status`, directNote);
        badge.dataset.directStatus = dq.status ?? '';
        if (dq.reason)
            badge.title = `사유: ${dq.reason}`;
        heading.append(badge);
    }
    const nextAttempt = nextAttemptNote(a);
    if (nextAttempt) {
        // Deliberately not .refresh-note. That class means "a usage lookup is behind", and two
        // existing checks count it to prove the warning appears exactly once per account that
        // earned it. A direct-read schedule is a different fact and gets its own class rather
        // than quietly inflating theirs.
        const note = node('span', 'direct-next', nextAttempt);
        note.dataset.directNext = dq?.nextAttemptAt ?? '';
        note.title = '제공사 쿼타를 직접 조회하는 다음 시점입니다. 화면을 새로 고쳐도 앞당겨지지 않습니다.';
        measurement.append(note);
    }
    heading.append(measurement);
    article.append(heading);
    const primary = a.windows;
    if (primary.length) {
        const windows = node('div', 'windows');
        primary.forEach(w => windows.append(windowView(a, w)));
        article.append(windows);
    }
    else
        article.append(node('p', 'unavailable', '쿼타 —'));
    const details = node('details', 'method account-details');
    details.dataset.expand = `account:${provider.id}:${a.id}`;
    details.append(node('summary', '', '사용 기록과 계산 근거'));
    details.append(detailPeriod(details.dataset.expand, selectedPeriod, changePeriod));
    // monthly 고정: 이 계정에 연결된 사용이 있는지의 존재 검사이지 기간 표시가 아니다.
    const linkedUsage = !a.ollama || (accountPeriods(a)?.monthly?.requests ?? 0) > 0;
    if (linkedUsage) {
        details.append(node('h4', '', 'API 환산액'));
        details.append(periodGrid(a.analytics, selectedPeriod));
    }
    else
        details.append(node('p', 'sub-note', '호출 기록은 프로바이더 합계에 표시됩니다.'));
    details.append(node('p', 'sub-note', subscriptionNote(sub, ratio, str(asRecord(a.analytics)?.monthlyValueBasis) ?? undefined)));
    const selected = periodState(accountPeriods(a), selectedPeriod);
    const usage = accountPeriods(a)?.[selectedPeriod];
    const selectedLabel = periodLabel(selectedPeriod);
    const spanNote = selected.coverageNote ? ` · ${selected.coverageNote}` : '';
    if (linkedUsage && usage && usage.requests > 0) {
        const tokens = node('div', 'metrics');
        tokens.append(metric('입력 토큰', count.format(usage.inputTokens)), metric('출력 토큰', count.format(usage.outputTokens)), metric('캐시 읽기', count.format(usage.cachedTokens), '입력 토큰에 포함'));
        if (usage.cacheEstimatedRequests)
            tokens.append(metric('추정 캐시 읽기', count.format(usage.estimatedCachedTokens), '미보고 입력에 평균 비율 적용'));
        details.append(tokens);
        details.append(node('p', 'sub-note', `${selectedLabel} ${count.format(usage.requests)}회 호출 · 가격 확인 ${percent.format(coverage(usage) * 100)}%` + spanNote));
        // 행에서 뺀 근거가 여기 모인다. '회 호출' 은 쓰지 않는다 — 위의 호출 줄을 찾는 검사가 있다.
        for (const line of [excludedNote(usage), cacheNote(usage),
            usage.localPriceRequests > 0 ? `로컬 카탈로그 단가 ${count.format(usage.localPriceRequests)}회` : null]) {
            if (line)
                details.append(node('p', 'sub-note', line));
        }
        // 호출이 없거나 미지원이면 토큰 분해를 만들지 않는다. 서버가 0으로 정규화한 값을
        // 측정된 0처럼 보이게 하는 것이 정확히 피해야 할 표시다.
    }
    else if (linkedUsage)
        details.append(node('p', 'sub-note', `${selectedLabel} ${selected.detailNote}` + spanNote));
    for (const w of a.windows) {
        const section = node('div', 'detail-window');
        section.append(node('h4', '', w.label));
        if (finite(w.usedPercent))
            section.append(node('p', 'sub-note', `${quotaFigure(w.usedPercent)}% 사용`));
        const wa = winA(w);
        section.append(historyChart(wa.history, w.label));
        if (wa.capacityReason || wa.reason)
            section.append(node('p', 'sub-note', wa.capacityReason || wa.reason || ''));
        if (finite(wa.capacityMatchedQuotaCoverage) && wa.capacityMatchedQuotaCoverage < 1)
            section.append(node('p', 'sub-note', `사용액이 연결된 쿼타 변화 ${quotaFigure(wa.capacityMatchedQuotaCoverage * 100)}%`));
        if (finite(wa.unexplainedDeltaPp) && wa.unexplainedDeltaPp > 0)
            section.append(node('p', 'sub-note', `환산 못한 쿼타 변화 ${quotaFigure(wa.unexplainedDeltaPp)}%p 포함`));
        // 창마다 자기 분모로 답한다. 5시간 창처럼 7일 안에 여러 주기가 들어가는 창은 100%p 를 넘을
        // 수 있고, 그때는 그것이 현재 사용률이 아니라 여러 주기의 합임을 회차로 드러낸다.
        const currentSamples = wa.consumptionPeriods;
        const historicalSample = !finite(currentSamples?.[selectedPeriod]?.deltaPp)
            ? wa.historicalConsumptionPeriods?.[selectedPeriod] ?? null : null;
        const samples = historicalSample ? wa.historicalConsumptionPeriods : currentSamples;
        const sample = samples?.[selectedPeriod];
        const consumed = sample ? sample.deltaPp : selectedPeriod === 'weekly' ? wa.forecastDeltaPp : null;
        if (finite(consumed))
            section.append(node('p', 'sub-note', `${periodLabel(selectedPeriod)} ${sample?.basis === 'observed-increase' ? '관측 증가분 추정' : '소모'} ≈ ${quotaFigure(consumed)}%p` +
                (historicalSample ? ` · 이전 관측 ${instantNote(historicalSample.periodEndedAt, value => date.format(value))}까지 · 현재 기간 미관측` : '') +
                (consumed > 100 ? ` · 이 한도 약 ${number.format(consumed / 100)}회분` : '') +
                ((sample?.recoveredHours ?? 0) > 0 ? ` · 공백 복원 ${quotaFigure(sample?.recoveredDeltaPp)}%p 포함` : '')));
        if (finite(wa.forecastRatePpHour))
            section.append(node('p', 'sub-note', `평균 ${quotaFigure(wa.forecastRatePpHour)}%p/시간 · ${number.format(wa.forecastObservedHours ?? 0)}시간 관측`));
        // 이 숫자가 무엇에 근거하는가. 제공사가 준 값과 우리가 나눈 값을 나란히 두고, 어느 쪽도
        // 다른 쪽으로 고치지 않는다.
        basisRows(asRecord(w.measurement)).forEach(row => section.append(row));
        details.append(section);
    }
    directQuotaBlocks(a).forEach(block => details.append(block));
    const ollama = parseOllama(a.ollama);
    if (ollama) {
        const calibration = node('div', 'detail-window');
        calibration.append(node('h4', '', '모델별 쿼타 관측'));
        let rows = 0;
        for (const w of ollama.windows)
            for (const m of w.models) {
                rows++;
                calibration.append(node('p', 'sub-note', `${w.label} · ${m.model} · 1%p 순증가당 입력 ${count.format(m.inputTokensPerPp)} / 출력 ${count.format(m.outputTokensPerPp)} 토큰 · 환산 ${usd(m.apiUsdPerPp)} · ${m.requests}회 관측`));
                calibration.append(node('p', 'sub-note', `같은 작업 비율로 100% 추산: 입력 ${count.format(m.inputTokensPerPp * 100)} / 출력 ${count.format(m.outputTokensPerPp * 100)} 토큰 · 환산 ${finite(m.apiUsdPerPp) ? usd(m.apiUsdPerPp * 100) : '—'}`));
            }
        if (!rows)
            calibration.append(node('p', 'unavailable', '단일 모델 사용 구간 수집 중'));
        calibration.append(node('p', 'sub-note', '관측 구간의 입출력 비율 기준 추산입니다. 공식 한도가 아니며 모델별·기간별 값은 더하지 않습니다. 리셋 주기·캐시 할인·호출별 정확한 차감량은 확인되지 않았습니다.'));
        details.append(calibration);
    }
    if (sub?.reason)
        details.append(node('p', 'unavailable', sub.reason));
    article.append(details);
    return article;
}
export function providerAnalytics(p, ctx) {
    const wrap = node('div', 'provider-analytics');
    const title = node('div', 'section-caption');
    const bag = asRecord(p.analytics) ?? {};
    const periods = periodMap(bag.periods);
    title.append(node('h4', '', 'API 환산액'), node('span', '', '전체 계정 합계'));
    wrap.append(title, periodGrid(p.analytics, null));
    const subMonthly = num(bag.subscriptionMonthlyUsd);
    if (finite(subMonthly))
        wrap.append(node('p', 'sub-note', `현재 월 구독료 ${usd(subMonthly)} · 전체 등록 계정`));
    const cache = asRecord(bag.cacheAssumption);
    if (cache) {
        const stats = periods?.[ctx.selectedPeriod];
        const applied = num(cache.appliedRate);
        const note = finite(applied)
            ? `캐시 ${percent.format(applied * 100)}% 가정 · Ollama와 같은 최근 30일 실측 평균 · 입력·출력 토큰도 추정값` + (cache.stale ? ' · 이전 평균 사용' : '')
            : '캐시 평균을 계산할 실측 자료가 없어 캐시 할인을 적용하지 않았습니다.';
        wrap.append(node('p', 'sub-note', note));
        if (stats?.cacheEstimatedRequests)
            wrap.append(node('p', 'sub-note', `${periodLabel(ctx.selectedPeriod)} 캐시 미적용 ${usd(stats.noCacheApiUsd)} → 추정 캐시 적용 ${usd(stats.apiUsd)}`));
    }
    const unpriced = Array.isArray(bag.unpricedModels) ? bag.unpricedModels : [];
    if (unpriced.length)
        wrap.append(node('p', 'sub-note', `최근 30일 미환산: ${unpriced.map(item => {
            const m = asRecord(item) ?? {};
            return `${str(m.model) || '모델 미기록'} ${count.format(num(m.requests) ?? 0)}회`;
        }).join(', ')} · 기준 단가가 없어 환산에서 제외`));
    const details = node('details', 'method provider-details');
    details.dataset.expand = `provider:${p.id}`;
    details.append(node('summary', '', '사용 예상과 필요 계정'));
    const expandKey = details.dataset.expand ?? `provider:${p.id}`;
    details.append(detailPeriod(expandKey, ctx.selectedPeriod, ctx.changePeriod ?? (() => undefined)));
    const pace = asRecord(bag.pace), rec = selectedRecommendation(p, ctx.selectedPeriod);
    if (pace?.stale)
        details.append(node('p', 'sub-note', '이전 사용 기록 기준'));
    if (rec && finite(rec.currentAccounts))
        details.append(node('p', 'sub-note', `현재 ${count.format(rec.currentAccounts)}개 계정`));
    const projections = node('div', 'metrics');
    // 사용 예상은 기존 7일 표본을, 필요 계정은 선택 기간의 평균 속도를 쓴다.
    const paceBasis = pace && str(pace.basisPeriod) === 'weekly' ? '최근 7일 속도 기준' : null;
    const demand = rec?.demandBasis === 'quota-consumption' ? periodLabel(ctx.selectedPeriod) + ' 소모 합계 기준' : rec?.demandBasis === 'recent-week' ? '최근 7일 수요 기준'
        : rec?.demandBasis === 'monthly-baseline' ? '최근 30일 평균 기준' : null;
    const demandBasis = demand ? `${demand} · ${rec?.windowId === 'monthly' ? '월간' : '주간'} 한도 기준` : null;
    projections.append(metric('5시간 사용 예상', usd(num(pace?.projectedFiveHourUsd)), paceBasis), metric('7일 사용 예상', usd(num(pace?.projectedWeekUsd)), paceBasis), metric('필요 계정', rec && finite(rec.recommendedAccounts) ? `약 ${count.format(rec.recommendedAccounts)}개` : '—', demandBasis));
    details.append(projections);
    const capacities = node('div', 'metrics');
    for (const [id, label] of [['five-hour', '5시간 한도'], ['weekly', '주간 한도']]) {
        const measured = p.accounts.flatMap(a => {
            const w = a.windows.find(win => win.id === id || (id === 'five-hour' && win.id === 'short' && win.label === '5시간'));
            if (!w)
                return [];
            const wa = winA(w);
            const current = freshWindow(a, w) && finite(wa.capacityApiUsd);
            const prior = wa.historicalCapacity;
            const value = current ? wa.capacityApiUsd : prior?.apiUsd;
            return finite(value) && value > 0 ? [{ value, historical: !current,
                    basis: current ? wa.capacityBasis : prior?.basis, at: prior?.observedAt }] : [];
        });
        const average = measured.length ? measured.reduce((sum, row) => sum + row.value, 0) / measured.length : null;
        const conservative = measured.filter(row => row.basis === 'lower-bound').length;
        const historical = measured.filter(row => row.historical);
        const item = metric(label, finite(average) ? `≈ ${usd(average)}` : '—', measured.length ? `${measured.length}개 계정 평균${conservative ? ` · ${conservative}개는 보수 추정` : ''}` : '관측 부족');
        if (historical.length)
            item.title = '이전 한도 추산 기준: ' + historical.map(row => instantNote(row.at, value => date.format(value))).join(', ');
        capacities.append(item);
    }
    capacities.append(metric('예상 구독료', usd(rec?.estimatedMonthlyUsd), '계정별 월 구독료 기준'));
    details.append(capacities);
    if (rec?.reason)
        details.append(node('p', 'sub-note', rec.reason));
    const unattr = asRecord(bag.unattributed);
    if (unattr && num(unattr.requests))
        details.append(node('p', 'sub-note', `최근 7일 계정 미연결 ${usd(num(unattr.apiUsd))} (전체 합계에 포함)`));
    for (const { key, label } of PERIODS) {
        const stats = periods?.[key];
        if (!stats)
            continue;
        const state = periodState(periods, key);
        const excluded = excludedNote(stats, { lead: '미확인', compact: true });
        const line = node('p', 'sub-note', `${label} ${count.format(stats.requests)}회 호출 · 단가 확인 ${percent.format(coverage(stats) * 100)}%` +
            (stats.localPriceRequests ? ` · 토큰·캐시·단가 추정 ${count.format(stats.localPriceRequests)}회` : '') +
            (excluded ? ` · ${excluded}` : '') +
            (state.coverageNote ? ` · ${state.coverageNote}` : ''));
        line.dataset.period = key;
        if (key === ctx.selectedPeriod)
            line.classList.add('selected-period');
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
    const snapA = asRecord(ctx.snapshot?.analytics) ?? {};
    const catalog = asRecord(snapA.pricingCatalog);
    if (catalog)
        notes.push(`등록된 기준 단가로 자동 계산하며, 없는 모델은 로컬 카탈로그의 동일 제공자·모델 단가를 사용합니다. 카탈로그 ${str(catalog.status) === 'ok' ? '정상' : str(catalog.status) === 'stale' ? '이전 자료 사용' : '조회 불가'}.`);
    const efficiency = requireNode('efficiency');
    efficiency.replaceChildren(methodology({ sources: sourcesOf(snapA.sources), notes }, { key: 'top-method', title: '계산 기준과 단가 출처' }));
    const monthlySub = num(snapA.subscriptionMonthlyUsd);
    if (finite(monthlySub))
        efficiency.prepend(node('p', 'sub-note', `등록 계정 월 구독료 합계 ${usd(monthlySub)}`));
}
export function quotaOverview(p) {
    const groups = new Map();
    for (const a of p.accounts)
        for (const w of a.windows) {
            const key = `${w.id.startsWith('custom-') ? 'custom' : w.id}:${w.usageScope || ''}:${w.label}`;
            if (!groups.has(key))
                groups.set(key, { label: windowLabel(w), fullLabel: w.label, remaining: 0, accounts: 0, lowest: null, reset: null });
            if (!freshWindow(a, w))
                continue;
            const group = groups.get(key);
            if (!group)
                continue;
            const value = w.remainingPercent ?? 0;
            group.remaining += value;
            group.accounts++;
            if (group.lowest === null || value < group.lowest)
                group.lowest = value;
            const at = w.resetAt ? Date.parse(w.resetAt) : NaN;
            if (finite(at) && at > Date.now() && (group.reset === null || at < group.reset))
                group.reset = at;
        }
    const values = node('div', 'quota-bars');
    values.append(node('span', 'mobile-quota-caption', '남은 한도 · 계정 평균'));
    for (const g of groups.values()) {
        const remaining = g.accounts ? g.remaining / g.accounts : null;
        const severity = severityOf(g.lowest);
        const bar = node('div', `quota-bar${remaining === null ? ' stale' : severity === 'critical' ? ' crit' : severity === 'warning' ? ' low' : ''}`);
        const caption = node('div', 'quota-caption');
        caption.append(node('span', '', g.label), node('strong', '', remaining === null ? '—' : `${quotaFigure(remaining)}% 남음`));
        bar.title = remaining === null ? `${g.fullLabel}: 최근 측정 없음` : `${g.fullLabel}: 측정된 ${g.accounts}개 계정의 평균 잔여율`;
        bar.append(caption, quotaTrack(remaining, `${p.name} ${g.fullLabel}, ${g.accounts}개 계정 평균 잔여율`));
        if (remaining === null)
            bar.append(node('p', 'quota-note', '최근 측정 없음'));
        else {
            const notes = [];
            if (g.accounts > 1 && g.lowest !== null && Math.abs(g.lowest - remaining) >= 1)
                notes.push(`최저 ${quotaFigure(g.lowest)}%`);
            if (g.reset !== null)
                notes.push(countdown(g.reset));
            if (notes.length)
                bar.append(node('p', 'quota-note', notes.join(' · ')));
        }
        values.append(bar);
    }
    if (!groups.size)
        values.append(node('p', 'unavailable', '한도 조회 불가'));
    return values;
}
// 선택 기간 쿼타 소모 한 칸. 고를 창과 계정 합계와 상태는 quota.js 가 이미 끝냈고 여기서는
// 그리기만 한다. 열 머리가 금액만 가리키므로 이 칸은 데스크톱에서도 자기 라벨을 달고 있다.
function quotaUsageCell(provider, period) {
    const usage = weeklyQuotaUsage(provider, period);
    const cell = metric(`${periodLabel(period)} 쿼타 소모 합계`, usage.value);
    cell.classList.add('quota-used');
    cell.dataset.quotaUsage = usage.state;
    if (usage.windowId)
        cell.dataset.quotaWindow = usage.windowId;
    cell.title = [usage.note, usage.title].filter(Boolean).join('. ');
    return cell;
}
export function overviewView(providers, ctx) {
    const wrap = node('div', 'overview');
    wrap.append(attentionStrip(ctx));
    wrap.append(summaryList(providers, ctx));
    return wrap;
}
function summaryList(providers, ctx) {
    const list = node('section', 'summary-list');
    list.setAttribute('aria-label', '제공자별 사용 현황');
    const header = node('div', 'summary-columns');
    // 이 응답이 선택 기간을 아예 모르면 열 머리에서 먼저 말한다. 다른 기간 값으로 메우지 않는다.
    const unsupported = providers.length > 0 &&
        providers.every(p => periodState(p.analytics?.periods, ctx.selectedPeriod).state === 'unsupported');
    header.append(node('span', '', '제공자'), node('span', '', '남은 한도 · 계정 평균'), node('span', '', `${periodLabel(ctx.selectedPeriod)} API 환산액` + (unsupported ? ' · 미지원' : '')));
    list.append(header);
    for (const p of providers) {
        const row = node('article', 'summary-provider');
        const identity = node('div', 'summary-identity');
        const button = node('button', 'provider-link', p.name);
        button.dataset.focus = `provider:${p.id}`;
        button.addEventListener('click', () => ctx.select(p.id));
        const title = node('h3');
        title.append(button);
        identity.append(title, node('span', '', `${p.accounts.length}개 계정`));
        const concerns = [];
        if (!p.enabled)
            concerns.push('연결 비활성');
        for (const [key, label] of Object.entries(STATES)) {
            const total = p.accounts.filter(a => a.status === key).length;
            if (total)
                concerns.push(`${label} ${total}`);
        }
        const delayed = p.accounts.filter(a => a.status === 'ok' && refreshState(a.refresh)?.status === 'delayed').length;
        if (delayed)
            concerns.push(`갱신 지연 ${delayed}`);
        if (concerns.length)
            identity.append(node('small', 'attention', concerns.join(' · ')));
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
    if (!providers.length)
        list.append(node('div', 'empty', str(asRecord(ctx.snapshot?.analytics)?.status) === 'collecting'
            ? '저장된 사용 기록을 불러오고 있습니다.'
            : '연결된 제공자가 없습니다. OpenCodex에서 계정을 연결해 주세요.'));
    return list;
}
export function renderOrderEditor(providers, ctx) {
    const host = requireNode('provider-order-list');
    const focused = host.contains(document.activeElement) ? htmlEl(document.activeElement)?.dataset.orderMove ?? null : null;
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
                const other = index + direction;
                const here = ids[index];
                const swap = ids[other];
                if (here === undefined || swap === undefined)
                    return;
                ids[index] = swap;
                ids[other] = here;
                ctx.providerOrder = ids;
                try {
                    localStorage.setItem(ctx.ORDER_KEY, JSON.stringify(ids));
                    ctx.orderStorageFailed = false;
                }
                catch {
                    ctx.orderStorageFailed = true;
                }
                ctx.render();
                const buttons = [...host.querySelectorAll('button')];
                (buttons.find(b => b.dataset.orderMove === `${p.id}:${direction}` && !b.disabled) ||
                    buttons.find(b => b.dataset.orderMove === `${p.id}:${-direction}` && !b.disabled))?.focus({ preventScroll: true });
            });
            row.append(button);
        }
        host.append(row);
    });
    requireNode('provider-order-note').textContent = ctx.orderStorageFailed ? '저장할 수 없어 현재 탭에서만 유지됩니다.' : '이 브라우저에 자동 저장됩니다.';
    if (focused)
        [...host.querySelectorAll('button')].find(b => b.dataset.orderMove === focused && !b.disabled)?.focus({ preventScroll: true });
}
// --- 직접 수집 근거 (JUN-124) ---
// 한 measurement 의 계산 근거. 원본 값과 계산값을 같은 자리에 두되 합치지 않는다.
// 서로 다른 source 나 scopeKey 를 가진 값은 애초에 이 함수에 함께 들어오지 않는다 —
// 행 하나가 창 하나의 근거이고, 창을 가로질러 더하는 자리는 만들지 않는다.
export function basisRows(measurement) {
    if (!measurement || typeof measurement !== 'object')
        return [];
    const rows = [];
    const grid = node('div', 'metrics measurement-basis');
    grid.dataset.basisSource = str(measurement.source) ?? '';
    grid.dataset.basisScope = str(measurement.scopeKey) ?? '';
    grid.dataset.limitState = str(measurement.limitState) ?? '';
    grid.dataset.reconciliation = str(measurement.reconciliation) ?? '';
    // 제공사가 보고한 비율과 우리가 used/limit 으로 나눈 비율. 한쪽이 없으면 없다고 적는다.
    grid.append(metric('제공사 보고', measurement.reportedPercent === null ? '미보고'
        : `${quotaFigure(measurement.reportedPercent)}%`));
    grid.append(metric('계산값', measurement.calculatedPercent === null ? '계산 불가'
        : `${quotaFigure(measurement.calculatedPercent)}%`, limitStateNote(measurement) ?? undefined));
    // 원본 수량. 단위를 함께 적지 않으면 크레딧과 센트가 같은 숫자로 보인다.
    const unit = str(measurement.unit) ? ` ${str(measurement.unit)}` : '';
    grid.append(metric('사용량', measurement.used === null ? '미제공' : `${quotaFigure(measurement.used)}${unit}`));
    grid.append(metric('한도', measurement.limit === null
        ? (limitStateNote(measurement) ?? '미제공') : `${quotaFigure(measurement.limit)}${unit}`));
    rows.push(grid);
    // 이 값들은 data-* 에도 있지만 거기에만 두면 안 된다. 근거를 확인한다는 것은 사람이 읽을
    // 수 있다는 뜻이고, 개발자 도구를 열어야 보이는 것은 확인이 아니다.
    const facts = node('div', 'metrics measurement-origin');
    facts.append(metric('읽은 곳', str(measurement.source) ?? '미제공'));
    facts.append(metric('집계 범위', str(measurement.scopeKey) ?? '미제공'));
    facts.append(metric('주기 키', str(measurement.cycleKey) ?? '미제공'));
    facts.append(metric('단위', str(measurement.unit) ?? '미제공'));
    rows.push(facts);
    // 계약이 null 을 허용하는 자리와, 값이 있는데 읽히지 않는 자리를 구분한다. 잘못된 시각을
    // 그대로 Date 에 넣으면 RangeError 가 나고 화면 전체가 그리다 만다.
    const notes = [reconciliationNote(measurement), semanticsNote(measurement), precisionNote(measurement),
        `관측 ${instantNote(measurement.observedAt, value => date.format(value))}`,
        `조회 ${instantNote(measurement.fetchedAt, value => date.format(value))}`];
    for (const line of notes)
        if (line)
            rows.push(node('p', 'sub-note', line));
    return rows;
}
// 계정 수준의 직접 수집 상태와, 창이 되지 못한 근거들.
export function directQuotaBlocks(a) {
    const dq = directQuota(a.directQuota);
    if (!dq)
        return [];
    const blocks = [];
    // 비율이 없어 창으로 나가지 못한 읽기. 여기에는 usedPercent 가 아예 없으므로 막대도
    // 남은 양도 그리지 않는다. 0 으로 채우면 측정되지 않은 것을 측정된 0 으로 만든다.
    for (const raw of Array.isArray(dq.evidence) ? dq.evidence : []) {
        const row = asRecord(raw) ?? {};
        const section = node('div', 'detail-window evidence-window');
        section.dataset.evidenceWindow = str(row.id) ?? '';
        section.dataset.evidenceEndpoint = str(row.endpointId) ?? '';
        section.append(node('h4', '', str(row.label) ?? str(row.id) ?? ''));
        section.append(node('p', 'sub-note', '비율을 계산할 수 없어 근거만 보관합니다.'));
        if (row.stale)
            section.append(node('span', 'badge warning', '오래된 관측'));
        basisRows(asRecord(row.measurement)).forEach(node_ => section.append(node_));
        blocks.push(section);
    }
    // 보류된 계정이 들고 있는 마지막 읽기. 현재 가용량이 아니라는 것이 이 블록의 요점이다.
    const withheld = withheldReading(a);
    if (withheld) {
        const windows = withheld.windows ?? [];
        const section = node('div', 'detail-window last-known');
        section.dataset.lastKnown = withheld.accountStatus ?? '';
        section.append(node('h4', '', '마지막으로 읽은 값'));
        section.append(node('p', 'sub-note', withheld.accountStatus === 'paused'
            ? '일시 중지된 계정이라 현재 가용량으로 쓰지 않습니다.'
            : '로그인 갱신이 필요해 현재 가용량으로 쓰지 않습니다.'));
        if (!windows.length)
            section.append(node('p', 'unavailable', '보관된 읽기 없음'));
        for (const raw of windows) {
            const w = asRecord(raw) ?? {};
            const line = node('p', 'sub-note', `${windowLabel({ label: str(w.label) ?? '' })} · ${quotaFigure(w.usedPercent)}% 사용`
                + ` · ${instantNote(w.measuredAt, value => date.format(value))} 관측`);
            line.dataset.lastKnownWindow = str(w.id) ?? '';
            section.append(line);
        }
        blocks.push(section);
    }
    return blocks;
}
const HEALTH_LABEL = { critical: '위험', warning: '주의', ok: '정상', unknown: '확인 불가', idle: '일시 중지' };
function n0(value) { return num(value) ?? 0; }
function costCell(value) {
    const o = asRecord(value) ?? {};
    return { requests: n0(o.requests), tokens: n0(o.tokens), inputTokens: n0(o.inputTokens), outputTokens: n0(o.outputTokens),
        cachedTokens: n0(o.cachedTokens), apiUsd: n0(o.apiUsd), unpricedRequests: n0(o.unpricedRequests), tokenlessRequests: n0(o.tokenlessRequests), lastRequestAt: str(o.lastRequestAt) };
}
function windowRow(value) {
    const o = asRecord(value);
    if (!o)
        return null;
    return { id: str(o.id) ?? '', label: str(o.label) ?? '', remainingPercent: num(o.remainingPercent), resetAt: str(o.resetAt), stale: o.stale === true };
}
function isHealth(value) {
    return value === 'critical' || value === 'warning' || value === 'ok' || value === 'unknown' || value === 'idle';
}
export function accountRows(snapshot) {
    const raw = asRecord(snapshot?.analytics)?.accounts;
    if (!Array.isArray(raw))
        return [];
    return raw.flatMap(item => {
        const o = asRecord(item);
        if (!o)
            return [];
        return [{ provider: str(o.provider) ?? '', providerName: str(o.providerName) ?? str(o.provider) ?? '', id: str(o.id) ?? '', label: str(o.label) ?? '',
                plan: str(o.plan), status: str(o.status) ?? '', health: isHealth(o.health) ? o.health : 'unknown', reason: str(o.reason) ?? '',
                lowest: windowRow(o.lowest), nextResetAt: str(o.nextResetAt),
                windows: Array.isArray(o.windows) ? o.windows.flatMap(w => { const r = windowRow(w); return r ? [r] : []; }) : [],
                day: costCell(o.day), week: costCell(o.week), lastRequestAt: str(o.lastRequestAt) }];
    });
}
function costRows(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap(item => {
        const o = asRecord(item);
        if (!o)
            return [];
        return [{ ...costCell(o), key: str(o.key) ?? '', provider: str(o.provider) ?? '', name: str(o.name) ?? '',
                configured: typeof o.configured === 'boolean' ? o.configured : null, share: n0(o.share) }];
    });
}
function costPeriod(value) {
    const o = asRecord(value);
    if (!o)
        return null;
    return { hours: n0(o.hours), total: costCell(o.total), providers: costRows(o.providers), models: costRows(o.models), accounts: costRows(o.accounts) };
}
export function severityOf(remaining) {
    if (remaining === null)
        return 'unknown';
    return remaining < 10 ? 'critical' : remaining < 30 ? 'warning' : 'ok';
}
export function countdown(at) {
    const ms = (typeof at === 'string' ? Date.parse(at) : at ?? NaN) - Date.now();
    if (!finite(ms))
        return '리셋 미제공';
    if (ms <= 0)
        return '리셋됨 · 새 측정 대기';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d > 0 ? `${d}일 ${h % 24}시간 후 리셋` : h > 0 ? `${h}시간 ${m % 60}분 후 리셋` : `${Math.max(1, m)}분 후 리셋`;
}
function ago(value) {
    if (!value)
        return '기록 없음';
    const ms = Date.now() - Date.parse(value);
    if (!finite(ms))
        return '기록 없음';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return m < 1 ? '방금' : m < 60 ? `${m}분 전` : h < 24 ? `${h}시간 전` : `${d}일 전`;
}
const compact = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });
function tokens(value) { return value > 0 ? compact.format(value) : '0'; }
function money(value) { return value > 0 ? usd(value) : '$0'; }
function healthBadge(health) {
    const badge = node('span', `badge health-${health}`, HEALTH_LABEL[health]);
    return badge;
}
function miniBar(remaining, label) {
    const wrap = node('div', `mini-bar sev-${severityOf(remaining)}`);
    wrap.append(quotaTrack(remaining, label));
    return wrap;
}
export function attentionStrip(ctx) {
    const rows = accountRows(ctx.snapshot).filter(r => r.health === 'critical' || r.health === 'warning');
    const box = node('section', 'attention-strip');
    box.setAttribute('aria-label', '주의가 필요한 계정');
    if (!accountRows(ctx.snapshot).length) {
        box.hidden = true;
        return box;
    }
    if (!rows.length) {
        box.classList.add('calm');
        box.append(node('strong', '', '모든 계정 정상'), node('span', '', '한도가 30% 미만인 계정이 없습니다.'));
        return box;
    }
    const head = node('div', 'attention-head');
    head.append(node('strong', '', `주의가 필요한 계정 ${rows.length}개`));
    const more = node('button', 'link-button', '계정 전체 보기');
    more.addEventListener('click', () => ctx.select('accounts'));
    head.append(more);
    box.append(head);
    const list = node('div', 'attention-list');
    for (const r of rows.slice(0, 6)) {
        const item = node('button', `attention-item health-${r.health}`);
        item.addEventListener('click', () => ctx.select(r.provider));
        const top = node('div', 'attention-top');
        top.append(node('span', 'attention-name', `${r.providerName} · ${r.label}`), node('strong', 'num', r.lowest?.remainingPercent != null ? `${quotaFigure(r.lowest.remainingPercent)}%` : '—'));
        item.append(top, node('span', 'attention-reason', r.reason));
        const reset = r.lowest?.resetAt ?? r.nextResetAt;
        if (reset)
            item.append(node('span', 'attention-reset', countdown(reset)));
        list.append(item);
    }
    box.append(list);
    return box;
}
export function accountsView(ctx, query) {
    const all = accountRows(ctx.snapshot);
    const rows = all.filter(r => `${r.providerName} ${r.label} ${r.plan ?? ''}`.toLowerCase().includes(query));
    const section = node('section', 'accounts-view');
    const counts = node('div', 'health-summary');
    for (const h of ['critical', 'warning', 'ok', 'unknown', 'idle']) {
        const total = all.filter(r => r.health === h).length;
        if (!total)
            continue;
        const chip = node('span', `health-chip health-${h}`);
        chip.append(node('span', 'dot'), node('span', '', `${HEALTH_LABEL[h]} ${total}`));
        counts.append(chip);
    }
    section.append(counts);
    if (!all.length) {
        section.append(node('div', 'empty', '계정 정보를 불러오는 중입니다.'));
        return section;
    }
    if (!rows.length) {
        section.append(node('div', 'empty', '일치하는 계정이 없습니다'));
        return section;
    }
    const table = node('div', 'account-table');
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', '계정 현황');
    const head = node('div', 'account-tr head');
    head.setAttribute('role', 'row');
    for (const label of ['계정', '상태', '가장 낮은 한도', '다음 리셋', '24시간', '7일', '최근 요청']) {
        const cell = node('span', '', label);
        cell.setAttribute('role', 'columnheader');
        head.append(cell);
    }
    table.append(head);
    for (const r of rows) {
        const tr = node('div', `account-tr health-${r.health}`);
        tr.setAttribute('role', 'row');
        const cell = (cls, label) => { const c = node('div', `cell ${cls}`); c.setAttribute('role', 'cell'); c.dataset.label = label; tr.append(c); return c; };
        const who = cell('who', '계정');
        const name = node('button', 'account-name', r.label);
        name.addEventListener('click', () => ctx.select(r.provider));
        who.append(name, node('small', '', [r.providerName, r.plan].filter(Boolean).join(' · ')));
        const state = cell('state', '상태');
        state.append(healthBadge(r.health));
        if (r.health !== 'ok')
            state.append(node('small', '', r.reason));
        const low = cell('lowest', '가장 낮은 한도');
        if (r.lowest && r.lowest.remainingPercent !== null) {
            const cap = node('div', 'mini-caption');
            cap.append(node('span', '', r.lowest.label), node('strong', 'num', `${quotaFigure(r.lowest.remainingPercent)}%`));
            low.append(cap, miniBar(r.lowest.remainingPercent, `${r.label} ${r.lowest.label} 남은 한도`));
            const others = r.windows.filter(w => w.id !== r.lowest?.id && w.remainingPercent !== null);
            if (others.length)
                low.append(node('small', '', others.map(w => `${w.label} ${quotaFigure(w.remainingPercent)}%`).join(' · ')));
        }
        else
            low.append(node('span', 'muted', '—'));
        const reset = cell('reset', '다음 리셋');
        reset.append(node('span', '', r.nextResetAt ? countdown(r.nextResetAt).replace(' 후 리셋', ' 후') : '—'));
        const day = cell('money', '24시간 환산액');
        day.append(node('strong', 'num', money(r.day.apiUsd)), node('small', '', `${count.format(r.day.requests)}회`));
        const week = cell('money', '7일 환산액');
        week.append(node('strong', 'num', money(r.week.apiUsd)), node('small', '', `${count.format(r.week.requests)}회 · ${tokens(r.week.tokens)} 토큰`));
        const last = cell('last', '최근 요청');
        last.append(node('span', '', ago(r.lastRequestAt)));
        table.append(tr);
    }
    section.append(table);
    section.append(node('p', 'sub-note', '금액은 기록된 토큰을 API 단가로 환산한 참고값입니다. 계정이 확인되지 않은 요청은 제공자 합계에만 들어갑니다.'));
    return section;
}
const COST_PERIODS = [{ key: 'day', label: '24시간' }, { key: 'week', label: '7일' }, { key: 'month', label: '30일' }];
let costSelection = 'week';
const PALETTE = ['#4f7cff', '#a36bff', '#18a7a0', '#e0607e', '#e0932f', '#6c9a2e', '#7a8499', '#2fb7d8', '#c4a13a', '#8a5a44'];
// One colour per provider, the same in every chart. Official accents where the
// brand publishes one (Claude coral, ChatGPT green, Google blue, Xiaomi orange,
// Command Code violet); monochrome brands get a distinct colour chosen here so
// that no two providers share a hue. Unknown providers fall back to PALETTE.
const PROVIDER_COLOUR = {
    anthropic: '#d97757', // official: Claude
    openai: '#10a37f', // official: ChatGPT
    google: '#4285f4', // official: Google blue
    mimo: '#ff6900', // official: Xiaomi
    'command-code': '#7b5bff', // official: site accent
    xai: '#6b7280', // chosen: monochrome brand
    cursor: '#c08532', // chosen: site highlight
    devin: '#d946ef', // chosen
    kimi: '#06b6d4', // chosen
    'ollama-cloud': '#a16207', // chosen
    'opencode-go': '#65a30d', // chosen
    unknown: '#9ca3af',
};
function providerColours(ids) {
    let spare = 0;
    return new Map(ids.map(id => [id, PROVIDER_COLOUR[id] ?? PALETTE[spare++ % PALETTE.length] ?? '#888']));
}
export function costsView(ctx) {
    const costs = asRecord(asRecord(ctx.snapshot?.analytics)?.costs);
    const section = node('section', 'costs-view');
    if (!costs) {
        section.append(node('div', 'empty', '비용 집계를 불러오는 중입니다.'));
        return section;
    }
    const periods = asRecord(costs.periods) ?? {};
    const period = costPeriod(periods[costSelection]);
    const picker = node('div', 'period-picker cost-picker');
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', '비용 집계 기간');
    for (const { key, label } of COST_PERIODS) {
        const b = node('button', '', label);
        b.setAttribute('aria-pressed', String(key === costSelection));
        b.dataset.focus = `cost-period:${key}`;
        b.addEventListener('click', () => { costSelection = key; ctx.render(); });
        picker.append(b);
    }
    const head = node('div', 'cost-head');
    const total = node('div', 'cost-total');
    const label = COST_PERIODS.find(p => p.key === costSelection)?.label ?? '';
    total.append(node('span', '', `최근 ${label} API 환산액`), node('strong', 'num', period ? money(period.total.apiUsd) : '—'));
    if (period) {
        const t = period.total;
        const facts = [`${count.format(t.requests)}회 호출`, `${tokens(t.tokens)} 토큰`, `입력 ${tokens(t.inputTokens)} · 출력 ${tokens(t.outputTokens)} · 캐시 ${tokens(t.cachedTokens)}`];
        if (t.unpricedRequests)
            facts.push(`단가 미확인 ${count.format(t.unpricedRequests)}회 제외`);
        if (t.tokenlessRequests)
            facts.push(`토큰 미보고 ${count.format(t.tokenlessRequests)}회`);
        total.append(node('small', '', facts.join(' · ')));
    }
    head.append(total, picker);
    section.append(head);
    const unattributed = period?.accounts.find(r => r.key.endsWith('\u0000'));
    const series = costSeries(asRecord(asRecord(costs.series)?.[costSelection]));
    const providerOrder = [...new Set(series.buckets.flatMap(b => Object.keys(b.byProvider)))]
        .sort((a, b) => series.buckets.reduce((s, d) => s + (d.byProvider[b] ?? 0), 0) - series.buckets.reduce((s, d) => s + (d.byProvider[a] ?? 0), 0));
    const colour = providerColours(providerOrder);
    const names = new Map((ctx.snapshot?.providers ?? []).map(p => [p.id, p.name]));
    if (series.buckets.length)
        section.append(bucketChart(series, providerOrder, colour, names, label));
    if (period) {
        const grid = node('div', 'cost-grid');
        grid.append(rankTable('제공자별', period.providers, r => names.get(r.provider) ?? r.name, colour, true), rankTable('모델별', period.models.slice(0, 12), r => r.name, colour, false), rankTable('계정별', period.accounts.slice(0, 12), r => `${names.get(r.provider) ?? r.provider} · ${r.name}`, colour, false));
        if (unattributed)
            grid.append(node('p', 'sub-note unattributed-note', `계정 미확인 ${count.format(unattributed.requests)}회: OpenCodex가 계정 표시 없이 기록한 호출입니다(직접 로그인·기본 계정 경로). 제공자 합계에는 포함되지만 계정별로 나눌 근거가 없어 추정하지 않습니다.`));
        section.append(grid);
    }
    section.append(node('p', 'sub-note', 'API 환산액은 실제 청구액이 아니며, 기록된 토큰에 모델별 API 단가를 곱한 참고값입니다. 제공자 가격표나 공개 카탈로그(models.dev)에 없는 모델은 단가 미확인, 토큰 수를 보고하지 않은 호출은 토큰 미보고로 합계에서 빠집니다.'));
    return section;
}
function amounts(value) {
    const out = {};
    for (const [k, amount] of Object.entries(asRecord(value) ?? {})) {
        const x = num(amount);
        if (x !== null)
            out[k] = x;
    }
    return out;
}
function costSeries(value) {
    const o = asRecord(value) ?? {};
    const buckets = Array.isArray(o.buckets) ? o.buckets.flatMap(item => {
        const b = asRecord(item);
        return b ? [{ from: str(b.from) ?? '', to: str(b.to) ?? '', apiUsd: n0(b.apiUsd), requests: n0(b.requests), tokens: n0(b.tokens),
                unpricedRequests: n0(b.unpricedRequests), byProvider: amounts(b.byProvider), byModel: amounts(b.byModel),
                trailingUsd: num(b.trailingUsd), trailingComplete: b.trailingComplete === true }] : [];
    }) : [];
    return { bucketHours: n0(o.bucketHours), spanHours: n0(o.spanHours), buckets };
}
const barTime = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const barDay = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' });
function barRange(b, hours) {
    const from = new Date(b.from), to = new Date(b.to);
    if (!finite(from.getTime()))
        return '';
    if (hours >= 24)
        return barDay.format(from);
    const sameDay = from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth() && from.getDate() === to.getDate();
    // A bar ending exactly at midnight belongs to the same day it started.
    const endsAtMidnight = to.getHours() === 0 && to.getTime() - from.getTime() <= 24 * 3600000 && new Date(to.getTime() - 1).getDate() === from.getDate();
    const hhmm = `${String(to.getHours()).padStart(2, '0')}:${String(to.getMinutes()).padStart(2, '0')}`;
    return `${barTime.format(from)} – ${sameDay || endsAtMidnight ? hhmm : barTime.format(to)}`;
}
function axisLabel(iso, hours) {
    const d = new Date(iso);
    if (!finite(d.getTime()))
        return '';
    return hours >= 24 ? `${d.getMonth() + 1}/${d.getDate()}` : hours >= 5 ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}시` : `${String(d.getHours()).padStart(2, '0')}시`;
}
function detailNodes(range, d, colour) {
    const head = node('div', 'tip-head');
    head.append(node('strong', '', range));
    for (const s of d.summary)
        head.append(node('span', 'num', s));
    const out = [head];
    if (d.empty) {
        out.push(node('p', 'tip-note', d.empty));
        return out;
    }
    if (d.rows.length) {
        const table = node('table', 'tip-table');
        const thead = node('thead');
        const hr = node('tr');
        hr.append(node('th', '', ''), ...d.columns.map(c => node('th', 'num', c)));
        thead.append(hr);
        const body = node('tbody');
        for (const r of d.rows) {
            const tr = node('tr');
            const name = node('td', 'tip-name');
            const sw = node('span', 'swatch');
            sw.style.background = colour.get(r.id) ?? '#888';
            name.append(sw, node('span', '', r.name));
            tr.append(name, ...r.values.map(x => node('td', 'num', x)));
            body.append(tr);
        }
        table.append(thead, body);
        out.push(table);
    }
    for (const n of d.notes)
        out.push(node('p', 'tip-note', n));
    return out;
}
function stackedChart(opts) {
    const { bars, bucketHours, order, colour, names } = opts;
    const box = node('figure', 'daily-chart');
    const cap = node('figcaption');
    cap.append(node('strong', '', opts.title));
    const legend = node('div', 'legend');
    for (const id of order.slice(0, 8)) {
        const item = node('span', 'legend-item');
        const sw = node('span', 'swatch');
        sw.style.background = colour.get(id) ?? '#888';
        item.append(sw, node('span', '', names.get(id) ?? id));
        legend.append(item);
    }
    const hasLine = !!opts.lineLabel && bars.some(b => typeof b.line === 'number');
    if (hasLine) {
        const item = node('span', 'legend-item legend-line');
        item.append(node('span', 'line-swatch'), node('span', '', opts.lineLabel ?? ''));
        legend.append(item);
    }
    cap.append(legend);
    box.append(cap);
    const max = Math.max(1e-9, ...bars.map(b => Math.max(b.total ?? 0, hasLine ? b.line ?? 0 : 0)));
    const plot = node('div', 'chart-plot');
    const W = 600, H = 160, pad = bars.length > 30 ? 1 : 2, bw = W / bars.length;
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', class: 'bars' });
    chart.setAttribute('aria-label', `${opts.title}, 최대 ${opts.valueLabel(max)}`);
    // The detail lives in its own strip under the caption, never over the bars,
    // so moving along the chart keeps every bar visible.
    const tip = node('div', 'chart-tip idle');
    tip.setAttribute('role', 'status');
    tip.setAttribute('aria-live', 'polite');
    const idle = () => { tip.className = 'chart-tip idle'; tip.replaceChildren(node('span', '', '막대에 마우스를 올리거나 눌러 구간별 내역을 봅니다.')); };
    idle();
    const show = (i) => {
        const b = bars[i];
        if (!b)
            return;
        tip.className = 'chart-tip';
        tip.replaceChildren(...detailNodes(barRange(b, bucketHours), opts.describe(i), colour));
        chart.querySelectorAll('g.bar').forEach((g, k) => g.classList.toggle('active', k === i));
    };
    const hide = () => { idle(); chart.querySelectorAll('g.bar.active').forEach(g => g.classList.remove('active')); };
    bars.forEach((d, i) => {
        let y = H;
        const g = svg('g', { class: 'bar' });
        for (const id of order) {
            const v = d.parts[id] ?? 0;
            if (v <= 0)
                continue;
            const h = v / max * (H - 4);
            y -= h;
            g.append(svg('rect', { x: String(i * bw + pad / 2), y: String(y), width: String(Math.max(1, bw - pad)), height: String(h), fill: colour.get(id) ?? '#888' }));
        }
        if (!d.total || d.total <= 0)
            g.append(svg('rect', { x: String(i * bw + pad / 2), y: String(H - 1), width: String(Math.max(1, bw - pad)), height: '1', class: d.total === null ? 'zero missing' : 'zero' }));
        g.append(svg('rect', { x: String(i * bw), y: '0', width: String(bw), height: String(H), class: 'hit' }));
        g.addEventListener('mouseenter', () => show(i));
        g.addEventListener('click', () => show(i));
        chart.append(g);
    });
    if (hasLine) {
        // Two paths over the same points: solid where the moving window is fully
        // covered by retained history, dashed where it is not yet.
        const pt = (i) => `${(i + 0.5) * bw},${H - (bars[i]?.line ?? 0) / max * (H - 4)}`;
        const segs = { full: [], partial: [] };
        for (let i = 0; i < bars.length; i++) {
            const b = bars[i], n = bars[i + 1];
            if (typeof b?.line !== 'number' || typeof n?.line !== 'number')
                continue;
            (b.lineComplete && n.lineComplete ? segs.full : segs.partial).push(`M${pt(i)}L${pt(i + 1)}`);
        }
        const line = svg('g', { class: 'trend' });
        if (segs.partial.length)
            line.append(svg('path', { d: segs.partial.join(''), class: 'trend-line partial', 'vector-effect': 'non-scaling-stroke' }));
        if (segs.full.length)
            line.append(svg('path', { d: segs.full.join(''), class: 'trend-line', 'vector-effect': 'non-scaling-stroke' }));
        chart.append(line);
    }
    chart.addEventListener('mouseleave', hide);
    let focusIndex = bars.length - 1;
    chart.setAttribute('tabindex', '0');
    chart.addEventListener('focus', () => show(focusIndex));
    chart.addEventListener('blur', hide);
    chart.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            focusIndex = Math.max(0, Math.min(bars.length - 1, focusIndex + (e.key === 'ArrowLeft' ? -1 : 1)));
            show(focusIndex);
        }
    });
    plot.append(chart);
    box.append(plot);
    const axis = node('div', 'chart-axis');
    const firstB = bars[0], lastB = bars[bars.length - 1];
    axis.append(node('span', '', firstB ? axisLabel(firstB.from, bucketHours) : ''), node('span', '', `최대 ${opts.valueLabel(max)}`), node('span', '', lastB ? axisLabel(lastB.from, bucketHours) : ''));
    box.append(axis, tip);
    // The detail strip is reserved at the height of the tallest bar detail, so
    // hovering never moves what sits below the chart. Measured once the chart is
    // in the page and again whenever its width changes; anything taller than the
    // reservation scrolls inside the strip instead of growing it.
    let measuredWidth = -1;
    const reserve = () => {
        const width = tip.clientWidth;
        if (!tip.isConnected || width === measuredWidth)
            return;
        measuredWidth = width;
        const active = chart.querySelector('g.bar.active');
        const activeIndex = active ? [...chart.querySelectorAll('g.bar')].indexOf(active) : -1;
        tip.style.height = 'auto';
        let tallest = tip.offsetHeight;
        // Measure in the detail styling, not the smaller idle hint styling.
        tip.className = 'chart-tip';
        for (let i = 0; i < bars.length; i++) {
            const b = bars[i];
            if (!b)
                continue;
            tip.replaceChildren(...detailNodes(barRange(b, bucketHours), opts.describe(i), colour));
            tallest = Math.max(tallest, tip.offsetHeight);
        }
        tip.style.height = `${tallest}px`;
        if (activeIndex >= 0)
            show(activeIndex);
        else
            idle();
    };
    requestAnimationFrame(reserve);
    new ResizeObserver(reserve).observe(tip);
    // Web fonts change text metrics; measure again once they have loaded.
    void document.fonts?.ready.then(() => { measuredWidth = -1; reserve(); });
    return box;
}
function bucketChart(series, order, colour, names, spanLabel) {
    const { buckets, bucketHours, spanHours } = series;
    const unit = bucketHours >= 24 ? '일별' : `${bucketHours}시간 단위`;
    // The line is the trailing span's total rescaled to one bar: the average
    // amount per bar over the last 24 hours / 7 days / 30 days at each bar's end.
    // Bars clipped to the span edge are shorter than bucketHours, but the average
    // is still stated per full bar so it reads against a full bar's height.
    const perBar = (b) => b.trailingUsd === null || spanHours <= 0 ? null : b.trailingUsd * bucketHours / spanHours;
    const spanWord = spanHours >= 24 * 28 ? '30일' : spanHours >= 24 * 7 ? '7일' : '24시간';
    return stackedChart({
        bars: buckets.map(b => ({ from: b.from, to: b.to, parts: b.byProvider, total: b.apiUsd, line: perBar(b), lineComplete: b.trailingComplete })),
        lineLabel: `${spanWord} 이동평균`,
        bucketHours, title: `최근 ${spanLabel} ${unit} 환산액`, order, colour, names, valueLabel: v => usd(v),
        describe: i => {
            const b = buckets[i];
            if (!b)
                return { summary: [], columns: [], rows: [], notes: [] };
            const share = (x) => b.apiUsd > 0 ? `${percent.format(x / b.apiUsd * 100)}%` : '';
            const models = Object.entries(b.byModel).sort((x, y) => y[1] - x[1]).slice(0, 3);
            return {
                summary: [money(b.apiUsd), `${count.format(b.requests)}회`, ...(b.tokens ? [`${tokens(b.tokens)} 토큰`] : [])],
                columns: ['환산액', '비중'],
                rows: Object.entries(b.byProvider).sort((x, y) => y[1] - x[1]).slice(0, 5)
                    .map(([id, amount]) => ({ id, name: names.get(id) ?? id, values: [money(amount), share(amount)] })),
                notes: [
                    ...(b.trailingUsd !== null ? [`${spanWord} 이동평균 ${money(perBar(b) ?? 0)}/${bucketHours >= 24 ? '일' : `${bucketHours}시간`} · 직전 ${spanWord} 합계 ${money(b.trailingUsd)}${b.trailingComplete ? '' : ' (기록이 기간보다 짧음)'}`] : []),
                    ...(models.length ? ['상위 모델 · ' + models.map(([m, a]) => `${m.split('/').slice(1).join('/') || m} ${money(a)}`).join(' · ')] : []),
                    ...(b.unpricedRequests ? [`단가 미확인 ${count.format(b.unpricedRequests)}회 제외`] : []),
                ],
                ...(b.requests ? {} : { empty: '이 구간에는 호출 기록이 없습니다.' }),
            };
        },
    });
}
function rankTable(title, rows, label, colour, showRemoved) {
    const box = node('section', 'rank');
    box.append(node('h3', '', title));
    if (!rows.length) {
        box.append(node('p', 'muted', '기록 없음'));
        return box;
    }
    const list = node('ol', 'rank-list');
    for (const r of rows) {
        const li = node('li');
        const top = node('div', 'rank-top');
        const name = node('span', 'rank-name', label(r));
        top.append(name, node('strong', 'num', money(r.apiUsd)));
        const bar = node('div', 'share');
        const fill = node('div', 'share-fill');
        fill.style.width = `${Math.max(0, Math.min(1, r.share)) * 100}%`;
        fill.style.background = colour.get(r.provider) ?? 'var(--muted)';
        bar.append(fill);
        const meta = [`${count.format(r.requests)}회`, `${tokens(r.tokens)} 토큰`];
        if (r.share > 0)
            meta.unshift(`${percent.format(r.share * 100)}%`);
        if (r.unpricedRequests)
            meta.push(`단가 미확인 ${count.format(r.unpricedRequests)}회`);
        if (r.tokenlessRequests)
            meta.push(`토큰 미보고 ${count.format(r.tokenlessRequests)}회`);
        li.append(top, bar, node('small', '', meta.join(' · ')));
        list.append(li);
    }
    box.append(list);
    return box;
}
// ---- 쿼타 분석 ---------------------------------------------------------------
// Same layout as 비용 분석: one chart stacked by provider, then provider and
// account breakdowns. Bars come from each provider's analytics.quotaSeries
// (identical bar edges) and add up to its quotaConsumption for the span. %p
// of different providers are shares of different limits, so the header lists
// them per provider instead of adding them into one figure.
let quotaSelection = 'week';
const QUOTA_PERIOD_KEY = { day: 'twentyFourHour', week: 'weekly', month: 'monthly' };
function quotaBars(value) {
    const o = asRecord(value) ?? {};
    const buckets = Array.isArray(o.buckets) ? o.buckets.flatMap(item => {
        const b = asRecord(item);
        return b ? [{ from: str(b.from) ?? '', to: str(b.to) ?? '', deltaPp: num(b.deltaPp), byAccount: amounts(b.byAccount), apiUsd: n0(b.apiUsd), requests: n0(b.requests) }] : [];
    }) : [];
    return { bucketHours: n0(o.bucketHours), buckets };
}
export function quotaView(ctx) {
    const section = node('section', 'costs-view quota-view');
    const key = QUOTA_PERIOD_KEY[quotaSelection];
    const usdPeriod = costPeriod(asRecord(asRecord(asRecord(ctx.snapshot?.analytics)?.costs)?.periods)?.[quotaSelection]);
    const rows = (ctx.snapshot?.providers ?? []).flatMap(provider => {
        const bag = asRecord(provider.analytics) ?? {};
        const series = asRecord(bag.quotaSeries) ?? {};
        const windowId = str(series.windowId);
        if (!windowId)
            return [];
        const bars = quotaBars(series[quotaSelection]);
        const total = asRecord(asRecord(bag.quotaConsumption)?.[key]) ?? {};
        const rec = asRecord(asRecord(bag.quotaRecommendations)?.[key]) ?? {};
        return [{ provider, windowLabel: windowId === 'monthly' ? '월간' : '주간', bars: bars.buckets, bucketHours: bars.bucketHours,
                total: num(total.deltaPp), measured: num(total.measuredAccounts) ?? 0, held: num(total.accounts) ?? 0,
                need: num(rec.recommendedAccounts), apiUsd: usdPeriod?.providers.find(r => r.provider === provider.id)?.apiUsd ?? null,
                accounts: new Map(Object.entries(asRecord(series.accounts) ?? {}).map(([id, label]) => [id, str(label) ?? id])) }];
    });
    const spanLabel = COST_PERIODS.find(p => p.key === quotaSelection)?.label ?? '';
    const head = node('div', 'cost-head');
    const totalBox = node('div', 'cost-total');
    totalBox.append(node('span', '', `최근 ${spanLabel} 쿼타 소모 · 제공자별 한도 기준`));
    const chips = node('div', 'quota-chips');
    for (const r of [...rows].sort((a, b) => (b.total ?? -1) - (a.total ?? -1))) {
        const chip = node('span', 'quota-chip');
        chip.append(node('span', '', r.provider.name), node('strong', 'num', r.total === null ? '미관측' : `${quotaFigure(r.total)}%p`));
        chips.append(chip);
    }
    totalBox.append(chips);
    totalBox.append(node('small', '', '%p는 각 제공자의 주간(없으면 월간) 한도 사용률 증가분입니다. 한도가 서로 달라 제공자끼리 더하지 않습니다.'));
    const picker = node('div', 'period-picker cost-picker');
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', '쿼타 분석 기간');
    for (const { key: k, label } of COST_PERIODS) {
        const b = node('button', '', label);
        b.setAttribute('aria-pressed', String(k === quotaSelection));
        b.dataset.focus = `quota-period:${k}`;
        b.addEventListener('click', () => { quotaSelection = k; ctx.render(); });
        picker.append(b);
    }
    head.append(totalBox, picker);
    section.append(head);
    if (!rows.length) {
        section.append(node('div', 'empty', '제공자 전체 주간·월간 한도가 있는 제공자가 없습니다.'));
        return section;
    }
    const base = rows.find(r => r.bars.length) ?? rows[0];
    const order = [...rows].sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).map(r => r.provider.id);
    const colour = providerColours(order);
    const names = new Map(rows.map(r => [r.provider.id, r.provider.name]));
    const byId = new Map(rows.map(r => [r.provider.id, r]));
    if (base && base.bars.length) {
        const bars = base.bars.map((b, i) => {
            const parts = {};
            let observed = false;
            for (const r of rows) {
                const x = r.bars[i]?.deltaPp;
                if (x === null || x === undefined)
                    continue;
                observed = true;
                parts[r.provider.id] = Math.max(0, x);
            }
            return { from: b.from, to: b.to, parts, total: observed ? Object.values(parts).reduce((s, x) => s + x, 0) : null };
        });
        const unit = base.bucketHours >= 24 ? '일별' : `${base.bucketHours}시간 단위`;
        section.append(stackedChart({
            bars, bucketHours: base.bucketHours, title: `최근 ${spanLabel} ${unit} 쿼타 소모`, order, colour, names,
            valueLabel: v => `${quotaFigure(v)}%p`,
            describe: i => {
                const present = rows.filter(r => r.bars[i]?.deltaPp !== null && r.bars[i]?.deltaPp !== undefined)
                    .sort((a, b) => (b.bars[i]?.deltaPp ?? 0) - (a.bars[i]?.deltaPp ?? 0));
                if (!present.length)
                    return { summary: [], columns: [], rows: [], notes: [], empty: '이 구간은 관측이 없습니다. 사용량이 0이라는 뜻이 아닙니다.' };
                const usdSum = present.reduce((s, r) => s + (r.bars[i]?.apiUsd ?? 0), 0);
                return {
                    summary: [`${money(usdSum)} 환산`],
                    columns: ['쿼타', '환산액', '1%p당'],
                    rows: present.map(r => {
                        const bar = r.bars[i];
                        const pp = bar?.deltaPp ?? 0, spent = bar?.apiUsd ?? 0;
                        return { id: r.provider.id, name: r.provider.name,
                            values: [`${quotaFigure(pp)}%p`, money(spent), pp > 0 && spent > 0 ? money(spent / pp) : '—'] };
                    }),
                    notes: ['%p는 제공자마다 다른 한도 기준이라 합산하지 않습니다.'],
                };
            },
        }));
    }
    const grid = node('div', 'cost-grid quota-grid');
    const provRank = node('section', 'rank');
    provRank.append(node('h3', '', '제공자별'));
    const provList = node('ol', 'rank-list');
    for (const id of order) {
        const r = byId.get(id);
        if (!r)
            continue;
        const li = node('li');
        const top = node('div', 'rank-top');
        top.append(node('span', 'rank-name', r.provider.name), node('strong', 'num', r.total === null ? '미관측' : `≈ ${quotaFigure(r.total)}%p`));
        const share = node('div', 'share');
        const fill = node('div', 'share-fill');
        fill.style.width = `${Math.min(100, Math.max(0, r.total ?? 0) / Math.max(1, ...rows.map(x => x.total ?? 0)) * 100)}%`;
        fill.style.background = colour.get(id) ?? 'var(--muted)';
        share.append(fill);
        const facts = [`${r.windowLabel} 한도`, `${r.measured}/${r.held}계정 관측`];
        if (r.apiUsd !== null)
            facts.push(`API 환산 ${money(r.apiUsd)}`);
        if (r.total && r.apiUsd)
            facts.push(`1%p당 ${money(r.apiUsd / r.total)}`);
        if (r.need !== null)
            facts.push(`필요 계정 약 ${count.format(r.need)}개`);
        li.append(top, share, node('small', '', facts.join(' · ')));
        provList.append(li);
    }
    provRank.append(provList);
    const accRank = node('section', 'rank');
    accRank.append(node('h3', '', '계정별'));
    const accList = node('ol', 'rank-list');
    const accRows = [];
    for (const r of rows) {
        const sums = new Map();
        for (const b of r.bars)
            for (const [id, x] of Object.entries(b.byAccount))
                sums.set(id, (sums.get(id) ?? 0) + x);
        const windowId = r.windowLabel === '월간' ? 'monthly' : 'weekly';
        for (const [id, pp] of sums) {
            const w = r.provider.accounts.find(a => a.id === id)?.windows.find(x => x.id === windowId);
            accRows.push({ pid: r.provider.id, id, label: `${r.provider.name} · ${r.accounts.get(id) ?? id}`, pp, remaining: w && finite(w.remainingPercent) ? w.remainingPercent : null, windowLabel: r.windowLabel });
        }
    }
    const accMax = Math.max(1, ...accRows.map(a => a.pp));
    for (const a of accRows.sort((x, y) => y.pp - x.pp)) {
        const li = node('li');
        const top = node('div', 'rank-top');
        top.append(node('span', 'rank-name', a.label), node('strong', 'num', `≈ ${quotaFigure(a.pp)}%p`));
        const share = node('div', 'share');
        const fill = node('div', 'share-fill');
        fill.style.width = `${Math.max(0, a.pp) / accMax * 100}%`;
        fill.style.background = colour.get(a.pid) ?? 'var(--muted)';
        share.append(fill);
        li.append(top, share, node('small', '', [`${a.windowLabel} 한도`, a.remaining !== null ? `지금 ${quotaFigure(a.remaining)}% 남음` : null].filter(Boolean).join(' · ')));
        accList.append(li);
    }
    if (!accRows.length)
        accList.append(node('li', 'muted', '관측된 소모 없음'));
    accRank.append(accList);
    grid.append(provRank, accRank);
    section.append(grid);
    return section;
}
