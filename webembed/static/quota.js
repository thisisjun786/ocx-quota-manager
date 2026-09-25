import { finite, usd, count, number, quotaFigure, windowLabel, periodLabel } from './format.js';
import { asRecord, directQuota, num, periodStats, refreshState, str, windowAnalytics } from './types.js';
// 한 기간의 표본이 얼마나 닫혀 있는지. 값이나 구간 길이를 모르면 단정하지 않는다.
const TOL = 1 / 3600;
export function coverageAxis(value, hours) {
    if (!finite(value) || !finite(hours) || hours <= 0)
        return 'unknown';
    if (value <= TOL)
        return 'none';
    return value < hours - TOL ? 'partial' : 'full';
}
// 기간 하나의 표시 상태. usageAmount/usageNote는 그대로 두고 여기서만 확장한다.
// record는 보관된 사용 로그가 구간을 얼마나 덮는가이고 observation은 그 구간을 실제로
// 읽고 있었는가다. 서로 다른 질문이므로 다른 단어로 말한다.
const NO_ESTIMATE = { partial: false, cacheEstimated: false, estimateNote: '' };
export function periodState(periods, key) {
    if (!periods || typeof periods !== 'object') {
        return { state: 'unknown', record: 'unknown', observation: 'unknown', amount: '—', note: '기간 정보 없음',
            detailNote: '기간 정보 없음', coverageNote: '', ...NO_ESTIMATE };
    }
    const bag = asRecord(periods);
    const stats = bag ? periodStats(bag[key]) : null;
    if (stats === undefined || stats === null) {
        return { state: 'unsupported', record: 'unknown', observation: 'unknown', amount: '—', note: '미지원',
            detailNote: '미지원', coverageNote: '', ...NO_ESTIMATE };
    }
    const hours = stats.hours;
    const record = coverageAxis(stats.logCoverageHours, hours);
    const observation = coverageAxis(stats.observedCoverageHours, hours);
    const short = (axis) => axis === 'none' || axis === 'partial';
    // 관측 0이 먼저다. 기록 상태가 그것을 가리면 읽지 않은 구간이 침묵한다.
    // 기록 길이 0은 행이 없다는 뜻이 아니다. 첫 호출이 읽기 순간에 놓이면 길이는 0이고
    // 호출은 존재한다. 그래서 호출이 있으면 '기록 없음'이 아니라 '기록 부족'이다.
    let word = null;
    if (observation === 'none')
        word = '미관측';
    else if (record === 'none' && !stats.requests)
        word = '기록 없음';
    else if (short(record) && short(observation))
        word = (stats.observedCoverageHours ?? 0) <= (stats.logCoverageHours ?? 0) ? '관측 부족' : '기록 부족';
    else if (observation === 'partial')
        word = '관측 부족';
    else if (short(record))
        word = '기록 부족';
    const spans = [];
    const span = (value) => number.format(value ?? 0) + '/' + number.format(hours ?? 0) + '시간';
    if (short(record))
        spans.push('기록 ' + span(stats.logCoverageHours));
    if (short(observation))
        spans.push('관측 ' + span(stats.observedCoverageHours));
    // 상태어를 붙이는 규칙은 행과 상세가 같다. 앞에 오는 문구만 다르다.
    const withWord = (base) => word === '기록 없음' ? word : word ? base + ' · ' + word : base;
    const partial = stats.unknownPriceRequests > 0;
    const cacheEstimated = stats.cacheEstimatedRequests > 0;
    return {
        state: record === 'none' || observation === 'none' ? 'attention' : record === 'partial' || observation === 'partial' ? 'partial' : 'ok',
        record, observation,
        amount: usageAmount(stats),
        note: withWord(rowNote(stats)),
        detailNote: withWord(usageNote(stats)),
        coverageNote: spans.join(' · '),
        partial, cacheEstimated,
        // 행 글자에서 뺀 추정 사실은 셀 설명에 남긴다. 그러지 않으면 다음 정리 때 흔적까지 사라진다.
        estimateNote: [partial ? `단가 미확인 ${count.format(stats.unknownPriceRequests)}회` : null,
            cacheEstimated ? `캐시 추정 ${count.format(stats.cacheEstimatedRequests)}회` : null].filter(Boolean).join(' · '),
    };
}
export function freshWindow(account, window) {
    const observed = Date.parse(account.updatedAt ?? ''), now = Date.now();
    return !['reauth', 'paused', 'unavailable'].includes(account.status) && !window.stale &&
        finite(observed) && now - observed <= 15 * 60000 && observed - now <= 60000 &&
        finite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100 &&
        (!window.resetAt || (finite(Date.parse(window.resetAt)) && Date.parse(window.resetAt) > now));
}
export function measurementReason(account, window) {
    if (account.status === 'reauth')
        return '로그인 확인 필요';
    if (account.status === 'paused')
        return '일시 중지';
    const now = Date.now(), observed = Date.parse(account.updatedAt ?? ''), resetAt = Date.parse(window.resetAt ?? '');
    if (!finite(observed) || observed > now + 60000)
        return '측정 시각 확인 필요';
    if (finite(resetAt) && resetAt <= now)
        return '리셋 후 갱신 대기';
    if (now - observed > 15 * 60000)
        return '15분 이상 갱신 없음';
    return '측정값 확인 필요';
}
export function lookupDelay(account) {
    const refresh = refreshState(account.refresh);
    if (refresh?.status !== 'delayed' || ['reauth', 'paused'].includes(account.status))
        return null;
    const wait = Date.parse(refresh.nextAttemptAt ?? '') - Date.now();
    const retry = !finite(wait) || wait <= 0 ? '재시도 대기' : wait < 60000 ? `${Math.ceil(wait / 1000)}초 후 재시도` : `${Math.ceil(wait / 60000)}분 후 재시도`;
    return `갱신 지연 · ${retry}`;
}
export function usageAmount(stats) {
    if (!stats || !finite(stats.apiUsd))
        return '—';
    return usd(stats.apiUsd);
}
// 행과 상세가 함께 쓰는 앞머리. 해당하는 상태가 없으면 null 이고, 거기서부터 두 문구가 갈린다.
function baseNote(stats) {
    if (!stats)
        return '기록 없음';
    if (!stats.requests)
        return '호출 없음';
    if (!finite(stats.apiUsd))
        return '단가 미확인';
    return null;
}
// 계산 상세가 쓰는 전체 문구. tests/server.test.mjs 가 이 문자열을 고정한다.
export function usageNote(stats) {
    const head = baseNote(stats);
    if (head)
        return head;
    if (!stats)
        return '기록 없음';
    return (stats.unknownPriceRequests > 0 ? '일부' : `${count.format(stats.requests)}회 호출`) +
        (stats.cacheEstimatedRequests > 0 ? ' · 캐시 추정' : '');
}
// 사용현황 행이 쓰는 문구. 캐시 추정은 프로바이더 단위 한 가정이라 행마다 되풀이해도 정보가 늘지
// 않으므로 하단 안내와 상세로 보낸다. 남는 것은 이 행에서만 달라지는 호출 수와 부분 가격 여부다.
export function rowNote(stats) {
    const head = baseNote(stats);
    if (head)
        return head;
    if (!stats)
        return '기록 없음';
    return `${count.format(stats.requests)}회 호출` + (stats.unknownPriceRequests > 0 ? ' · 일부' : '');
}
// 정수 포매터는 0.1 을 0 으로 반올림한다. 양수를 0 으로 적으면 측정된 0 과 섞이므로,
// usd() 가 아주 작은 금액에 쓰는 표기를 토큰에도 그대로 빌린다.
const tokenCount = (value) => value > 0 && count.format(value) === '0' ? '< 1' : count.format(value);
// 합계에서 빠진 범위. 아는 만큼만 말한다. 기록된 제외 토큰과, 그 합계가 크기를 말해 주지 못하는
// 호출 수는 다른 사실이다. 저장된 토큰이 0 인 호출은 보고가 없었는지 실제로 0 이었는지 저장값만으로
// 구분되지 않으므로 어느 쪽이라고도 단정하지 않고, 어떤 경로로도 '기록된 0 토큰'을 만들지 않는다.
export function excludedNote(stats, { lead = '단가 미확인', compact = false } = {}) {
    if (!stats || !(stats.unknownPriceRequests > 0))
        return null;
    const parts = [`${lead} ${count.format(stats.unknownPriceRequests)}회`];
    if (stats.unknownPriceTokens > 0)
        parts.push(compact
            ? `기록된 ${tokenCount(stats.unknownPriceTokens)} 토큰 제외`
            : `기록된 ${tokenCount(stats.unknownPriceTokens)} 토큰이 합계에서 빠짐`);
    if (stats.unknownPriceUnsizedRequests > 0)
        parts.push(compact
            ? `${count.format(stats.unknownPriceUnsizedRequests)}회 토큰 기록 0`
            : `${count.format(stats.unknownPriceUnsizedRequests)}회는 토큰 기록이 0이라 이 값에 들어가지 않음`);
    return parts.join(' · ');
}
// 캐시 추정이 금액을 얼마나 움직였는가. 행에서 뺀 '캐시 추정'이 가리키던 사실이 여기에 있다.
export function cacheNote(stats) {
    if (!stats || !(stats.cacheEstimatedRequests > 0))
        return null;
    return `캐시 추정 ${count.format(stats.cacheEstimatedRequests)}회` +
        (finite(stats.apiUsd) && finite(stats.noCacheApiUsd)
            ? ` · 캐시 미적용 ${usd(stats.noCacheApiUsd)} → 추정 적용 ${usd(stats.apiUsd)}` : '');
}
export function coverage(stats, pace) {
    if (!stats)
        return 0;
    if (pace && finite(pace.pricedCoverage))
        return pace.pricedCoverage;
    if (!stats.requests)
        return 0;
    return stats.pricedRequests / stats.requests;
}
// --- 직접 수집 표시 판정 (JUN-124) ---
// 문구 결정은 전부 여기 모은다. views.js 가 상태 문자열을 조립하기 시작하면 같은 상태가
// 자리마다 다른 말로 나오고, 그걸 잡는 검사는 아무도 안 쓴다.
// merge() 가 낼 수 있는 값 전부. quota-transport 의 FAILURES 열넷에 수집 쪽 상태 둘이 더 붙는다.
const DIRECT_STATUS = {
    ok: '조회 정상',
    partial: '일부 조회 실패',
    unknown: '조회 기록 없음',
    observation_unavailable: '읽을 수 있는 창 없음',
    credential_expired: '로그인 만료',
    credential_missing: '자격 증명 없음',
    unauthorized: '권한 거부',
    access_denied: '권한 거부',
    rate_limited: '요청 제한',
    timeout: '연결 실패',
    network: '연결 실패',
    server_error: '제공사 응답 오류',
    unexpected_status: '제공사 응답 오류',
    invalid_json: '응답 해석 실패',
    oversized: '응답 해석 실패',
    // 요청을 보내기 전에 막힌 것과 보낸 뒤에 거부한 것은 다른 말을 써야 한다. redirect 와
    // credential_echoed 는 이미 인증된 요청이 나간 뒤에 판정되므로 '미전송' 이라고 하면 거짓말이다.
    endpoint_not_allowed: '대상 확인 실패로 미전송',
    base_url_mismatch: '대상 확인 실패로 미전송',
    redirect: '응답 거부',
    credential_echoed: '응답 거부',
};
export function directStatusNote(status) {
    if (typeof status !== 'string')
        return null;
    // 모르는 코드가 오면 뭉뚱그리되 원문을 숨기지는 않는다. 이 값들은 저장소가 정한 고정
    // 열거형이지 제공사가 준 문자열이 아니라 그대로 보여도 새는 것이 없다.
    return DIRECT_STATUS[status] ?? '조회 실패';
}
// ok 만 경고가 아니다. 나머지는 전부 사용자가 알아야 할 이유가 있어서 존재한다.
export function directStatusIsWarning(status) {
    return typeof status === 'string' && status !== 'ok';
}
// 계약이 null 을 허용하는 자리와, 값이 있지만 읽을 수 없는 자리를 구분해 적는다.
export function instantNote(value, format) {
    if (value === null || value === undefined)
        return '미제공';
    const at = Date.parse(typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
    return finite(at) ? format(new Date(at)) : '확인 불가';
}
// limitState 의 zero 는 한도가 0 이라는 뜻이다. 사용량이 0 이라는 뜻이 절대 아니다.
const LIMIT_STATE = { present: null, zero: '한도 0', missing: '한도 미제공', unlimited: '한도 없음' };
export function limitStateNote(measurement) {
    const key = str(measurement?.limitState);
    return key ? LIMIT_STATE[key] ?? null : null;
}
const RECONCILIATION = { matched: '제공사 값과 계산값 일치',
    mismatch: '제공사 값과 계산값 불일치', unverified: '대조할 짝 없음' };
export function reconciliationNote(measurement) {
    const key = str(measurement?.reconciliation);
    return key ? RECONCILIATION[key] ?? null : null;
}
// 소수점을 한 번 봤다는 것은 그 읽기에 대한 증거지 제공사가 늘 준다는 보장이 아니고,
// 정수만 봤다는 것은 못 준다는 증거가 아니다. 그래서 unknown 을 그대로 말한다.
const PRECISION = { observed_fraction: '소수점 보고 확인',
    integer_only: '정수만 보고', unknown: '소수점 보고 여부 미확인' };
export function precisionNote(measurement) {
    const key = str(measurement?.precisionEvidence);
    return key ? PRECISION[key] ?? null : null;
}
// 창이 재는 것이 무엇인가. sliding 이나 unknown 인 창의 변화를 총소모량이라고 부르면 안 되고,
// 그 판단의 근거가 이 필드다.
const SEMANTICS = { fixed_reset: '고정 주기', sliding: '이동 구간', unknown: '주기 미확인' };
export function semanticsNote(measurement) {
    const key = str(measurement?.windowSemantics);
    return key ? SEMANTICS[key] ?? null : null;
}
// 다음 조회 시점. account.refresh 쪽 lookupDelay 와 같은 모양으로 말한다.
export function nextAttemptNote(account) {
    const at = Date.parse(directQuota(account?.directQuota)?.nextAttemptAt ?? '');
    if (!finite(at))
        return null;
    const wait = at - Date.now();
    if (wait <= 0)
        return '다음 조회 대기';
    return wait < 60000 ? `${Math.ceil(wait / 1000)}초 후 조회` : `${Math.ceil(wait / 60000)}분 후 조회`;
}
// 보류된 계정이 들고 있는 값인가. 이 함수가 true 를 내면 화면은 그 숫자를 현재 가용량이
// 아니라 과거 읽기로 표시해야 한다.
export function withheldReading(account) {
    const lastKnown = directQuota(account?.directQuota)?.lastKnown;
    return lastKnown && Array.isArray(lastKnown.windows) ? lastKnown : null;
}
// --- 선택 기간 쿼타 소모 ---
// 창 고르기·계정 평균·상태 판정·문구를 전부 여기서 끝낸다. views.js 가 이 판단을 나눠 갖기
// 시작하면 같은 제공자가 자리마다 다른 숫자를 들게 된다.
//
// 대표 창은 제공자 전체를 재는 주간, 없으면 월간이다. 5시간 창은 7일 안에 서른 번 넘게
// 리셋되므로 그 합은 같은 열의 주간 %p 와 견줄 수 있는 수가 아니다 — 운영 기록 사본에서 한
// 계정이 345%p 를 냈고 같은 제공자의 주간 창은 81%p 였다. 모델별 창은 서버가
// providerWide=false 로 답하므로 저절로 빠진다. 그 판정의 정본은 src/window-scope.mjs 이고,
// 브라우저가 창 id 를 보고 그것을 다시 정하지 않는다.
const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
const QUOTA_BASIS = ['weekly', 'monthly'];
// 구간을 더해 만든 비율에 남는 합산 잔차만 흡수하는 크기. 실제로 관측이 빠진 구간은 이보다
// 훨씬 크게 나타나므로 이 값이 관측 부족을 가려 주지는 않는다.
const FLOAT_SLACK = 1e-9;
const candidateWindow = (account, id) => account?.windows?.find(w => w.id === id) ?? null;
// 창 목록이 비어 있는 계정은 자기 한도 구성을 말해 주지 않는다. src/snapshot.mjs:205 에서 읽을
// 수 있는 창이 하나도 없는 계정은 status 가 'unavailable' 이 되므로, 빈 목록은 '이 한도가 없다'
// 가 아니라 읽지 못했다는 뜻이다. 그것을 한도 없음으로 세면 화면이 조회 실패를 구성 사실로
// 바꿔 말하게 된다. 창을 보고했는데 그중에 없는 것은 그때가 진짜 없는 것이다.
const unread = (account) => !(account?.windows?.length);
// 값이 어떻게 만들어졌는지를 한 문장에 담는다. 셀에 들어가기엔 길고, 빠지면 화면이 추정을
// 측정처럼 말하게 되는 내용이다.
const HOW = '스냅샷 시각 기준 최근 7일의 저장 기록입니다. 수집이 끊겨도 과거 기록은 유지합니다. '
    + '같은 계정·한도·고정 리셋 주기가 확인되는 공백은 전후 차이로 복원합니다. '
    + '기간 경계에 걸친 긴 공백과 리셋을 넘은 공백은 배분하지 않습니다. '
    + '관측 비율은 선택 기간 중 연속 관측 시간만 세며 복원 시간은 제외합니다. '
    + '1%p 이하의 하향 보정은 구간 상한으로 평탄화한 추정이라 0도 확정된 0이 아닙니다. '
    + '현재 한도 사용률과는 다른 값이며 API 환산액에서 역산하지 않습니다.';
function analyzed(w) {
    return { ...w, analytics: windowAnalytics(w.analytics) };
}
export function weeklyQuotaUsage(provider, period = 'weekly') {
    const published = asRecord(asRecord(asRecord(provider?.analytics)?.quotaConsumption)?.[period]);
    if (published)
        return fromPublished(published, provider?.accounts ?? [], period);
    const accounts = provider?.accounts ?? [];
    // 범위를 말해 주지 않은 응답과 "이 창은 제공자 전체가 아니다" 라고 답한 응답은 다른 사실이다.
    // 둘을 같은 글자로 쓰면 필드를 아직 안 내보내는 서버에 대고 화면이 한도가 없다고 거짓말한다.
    let undeclared = false;
    for (const id of QUOTA_BASIS) {
        const candidates = accounts.map(a => candidateWindow(a, id)).filter((w) => w !== null).map(analyzed);
        const held = candidates.filter(w => w.analytics?.providerWide === true);
        if (held.length)
            return summariseQuotaUsage(held, id, accounts, period);
        if (candidates.some(w => w.analytics?.providerWide === undefined))
            undeclared = true;
    }
    if (undeclared) {
        return { state: 'unknown-scope', windowId: null, value: '범위 확인 불가', note: null,
            title: '이 응답은 주간·월간 한도 창이 제공자 전체를 재는지 알려주지 않습니다. 사용량이 0이라는 뜻이 아닙니다.' };
    }
    // 어느 계정의 창 목록도 읽지 못했으면 한도가 없다는 근거가 없다. 그 상태를 미지원이라고 적는
    // 것은 조회 실패를 없음으로 단정하는 일이다.
    if (accounts.length && accounts.every(unread)) {
        return { state: 'unobserved', windowId: null, value: '미관측', note: '0/' + accounts.length + '계정',
            title: '이 제공자의 쿼타를 읽지 못해 주간·월간 한도가 있는지도 확인할 수 없습니다. 사용량이 0이라는 뜻이 아닙니다.' };
    }
    return { state: 'unsupported', windowId: null, value: '미지원', note: null,
        title: '제공자 전체를 재는 주간·월간 한도 창이 없어 ' + periodLabel(period) + ' 소모를 낼 수 없습니다.' };
}
const PERIOD_HOURS = { oneHour: 1, fiveHour: 5, twentyFourHour: 24, weekly: 168, monthly: 720 };
function summariseQuotaUsage(heldIn, windowId, accounts, period) {
    const periodHours = PERIOD_HOURS[period] ?? 0;
    const anyCurrent = heldIn.some(w => finite(w.analytics?.consumptionPeriods?.[period]?.deltaPp));
    const held = heldIn.map(w => {
        const a = w.analytics ?? {};
        const current = a.consumptionPeriods?.[period];
        // A past period of another account is not consumption in the selected span.
        // Borrowing it only when no account has a current reading keeps the figure
        // honest: a paused account's last busy hour must not be added to today's.
        const historical = !finite(current?.deltaPp) && !anyCurrent ? a.historicalConsumptionPeriods?.[period] ?? null : null;
        const sample = historical ?? current;
        return { ...w, analytics: { ...a,
                selectedHistoricalPeriod: historical, selectedPeriodSample: sample,
                forecastDeltaPp: sample ? sample.deltaPp ?? null : period === 'weekly' ? a.forecastDeltaPp ?? null : null,
                forecastSpanHours: sample ? sample.spanHours ?? null : period === 'weekly' ? a.forecastSpanHours ?? null : null,
                forecastCoverage: sample ? sample.coverage ?? null : period === 'weekly' ? a.forecastCoverage ?? null : null } };
    });
    const first = held[0];
    const label = first ? windowLabel(first) : '';
    // 관측된 계정만 합산한다. 읽지 못한 계정은0으로 확정하지 않는다.
    const measured = held.filter(w => finite(w.analytics?.forecastDeltaPp));
    const m = held.length, n = measured.length;
    if (!n) {
        return { state: 'unobserved', windowId, value: '미관측', note: label + ' · 0/' + m + '계정',
            title: label + ' 한도는 있으나 ' + periodLabel(period) + ' 안에 쓸 수 있는 관측이 없습니다. 사용량이 0이라는 뜻이 아닙니다.' };
    }
    const value = measured.reduce((sum, w) => sum + (w.analytics?.forecastDeltaPp ?? 0), 0);
    const recovered = measured.map(w => w.analytics?.selectedPeriodSample)
        .filter((sample) => (sample?.recoveredHours ?? 0) > 0);
    const recoveredPp = recovered.reduce((sum, sample) => sum + (sample.recoveredDeltaPp ?? 0), 0);
    // A reset inside a collection gap leaves the pre-reset tail unobservable, so the summed
    // consumption is a floor rather than a complete figure.
    const resetGaps = measured.reduce((sum, w) => sum + (w.analytics?.selectedPeriodSample?.resetGapCount ?? 0), 0);
    const spanHours = mean(measured.map(w => finite(w.analytics?.forecastSpanHours) ? w.analytics.forecastSpanHours : 0));
    const seen = measured.map(w => w.analytics?.forecastCoverage).filter((v) => finite(v));
    // 한 계정이라도 커버리지를 말하지 못하면 평균을 내지 않는다. 모르는 값을 1 로 치면 관측이
    // 모자란 구간이 침묵한다.
    const coverage = seen.length === n ? mean(seen) : null;
    // 167시간은 7일이 아니다. 한 시간을 봐주면 그만큼이 measured 로 올라가므로 여기서도 위의
    // coverageAxis 와 같은 1초 오차만 허용한다.
    const shortSpan = spanHours < periodHours - TOL;
    // 커버리지는 여러 구간의 합에서 나온 비율이라 빠짐없이 관측한 이레도 0.99999999999997 로
    // 내려올 수 있다. 그 잔차를 관측 부족이라고 부르면 화면이 `관측 100%` 라고 적으면서 상태는
    // partial 이라고 말하는 모순에 빠진다.
    const thinCoverage = coverage === null || coverage < 1 - FLOAT_SLACK;
    const observedIncrease = measured.some(w => w.analytics?.selectedPeriodSample?.basis === 'observed-increase');
    const historical = measured.filter(w => w.analytics?.selectedHistoricalPeriod);
    const historicalDates = historical.map(w => w.analytics?.selectedHistoricalPeriod?.periodEndedAt);
    // 이 한도를 들지 않은 계정은 두 부류다. 창을 보고했는데 이 한도가 없는 계정과, 창 목록 자체를
    // 읽지 못한 계정. 둘을 한 글자로 묶으면 조회 실패가 구성 사실로 둔갑한다. 어느 쪽이든 전부를
    // 말하지 못하는 이유이므로 partial 이고, 몇 개인지는 보이는 문구가 밝힌다. title 에만 두면
    // '1/1계정' 이 전부를 관측한 것처럼 읽힌다.
    const totalAccounts = accounts.length;
    const others = accounts.filter(a => !(a?.windows ?? []).some(w => w.id === windowId && windowAnalytics(w.analytics)?.providerWide === true));
    const unreadable = others.filter(unread).length;
    const absent = others.length - unreadable;
    const state = historical.length || observedIncrease || n < m || absent > 0 || unreadable > 0 || shortSpan || thinCoverage ? 'partial' : 'measured';
    return {
        state, windowId,
        // ≈ 는 0 에도 붙는다. 20 → 19.5 → 20 이 0 을 내므로 0 역시 보정을 거친 값일 수 있다.
        value: '≈ ' + quotaFigure(value) + '%p',
        note: [label, n + '/' + m + '계정',
            historical.length ? '마지막 관측까지의 기간' : null,
            observedIncrease ? '관측 증가분 추정' : null,
            absent > 0 ? '한도 없음 ' + absent : null,
            unreadable > 0 ? '조회 불가 ' + unreadable : null,
            // 내림으로 적는다. 166.99시간을 반올림해 7일이라고 쓰면 모자란 기록이 꽉 찬 것처럼 보인다.
            shortSpan ? (period === 'weekly' ? '기록 ' + (Math.floor(spanHours / 24 * 10) / 10) + '/7일' : '기록 ' + (Math.floor(spanHours * 10) / 10) + '/' + periodHours + '시간') : null,
            // 한 자리 포매터는 0.9996 을 100 으로 올린다. 리셋을 가로지른 4분이 빠진 이레가 상태는
            // partial 인데 문구는 '관측 100%' 가 되는 자리였다. quotaFigure 는 두 자리를 열고 100
            // 언저리를 따로 다루므로 99.96 은 그대로, 99.999 는 <100 으로 나온다.
            thinCoverage && coverage !== null ? '관측 ' + quotaFigure(coverage * 100) + '%' : null,
        ].filter(Boolean).join(' · '),
        title: (historical.length ? '현재 기간은 미관측입니다. 일부 계정은 마지막 관측까지의 같은 길이 기간을 표시합니다. 기준 시각: ' + historicalDates.join(', ') + '. 계정별 기준 시각이 달라 현재 합계가 아닙니다. ' : '') + periodLabel(period) + ' 쿼타 소모 추정 · ' + label + ' 한도 기준 · 이 한도를 가진 ' + m
            + '개 계정 중 측정된 ' + n + '개의 소모 합계'
            + (m < totalAccounts ? ' (제공자 계정 ' + totalAccounts + '개 중 이 한도가 없는 계정 ' + absent
                + '개, 쿼타를 읽지 못한 계정 ' + unreadable + '개)' : '') + '. '
            + (recovered.length ? '공백 복원 ' + quotaFigure(recoveredPp) + '%p 포함. ' : '')
            + (resetGaps ? '관측 공백 안에서 리셋 ' + resetGaps + '회가 확인돼 리셋 직전 소모는 알 수 없습니다. 합계는 하한입니다. ' : '')
            + (observedIncrease ? '리셋 주기가 확인되지 않아 연속 관측의 증가분만 합산한 추정입니다. 감소·호출 수 감소·3분 초과 공백은 제외합니다. 회복과 새 사용이 상쇄될 수 있어 실제 소모량과 다르며 확정된 0도 아닙니다.'
                : HOW.replace('7일', periodLabel(period).replace('최근 ', ''))),
    };
}
// The server publishes one consumption total per provider and period
// (analytics.quotaConsumption). The needed-account estimate is derived from the
// same total, so the summary cell only renders it. weeklyQuotaUsage keeps its
// own computation for responses that predate the field.
function fromPublished(t, accounts, period) {
    const windowId = str(t.windowId);
    const periodHours = PERIOD_HOURS[period] ?? 0;
    const label = windowId === 'monthly' ? '월간' : windowId === 'weekly' ? '주간' : '';
    if (!windowId) {
        if (accounts.length && accounts.every(unread)) {
            return { state: 'unobserved', windowId: null, value: '미관측', note: '0/' + accounts.length + '계정',
                title: '이 제공자의 쿼타를 읽지 못해 주간·월간 한도가 있는지도 확인할 수 없습니다. 사용량이 0이라는 뜻이 아닙니다.' };
        }
        return { state: 'unsupported', windowId: null, value: '미지원', note: null,
            title: '제공자 전체를 재는 주간·월간 한도 창이 없어 ' + periodLabel(period) + ' 소모를 낼 수 없습니다.' };
    }
    const held = num(t.accounts) ?? 0, measured = num(t.measuredAccounts) ?? 0;
    const delta = num(t.deltaPp);
    if (delta === null || !measured) {
        return { state: 'unobserved', windowId, value: '미관측', note: label + ' · 0/' + held + '계정',
            title: label + ' 한도는 있으나 ' + periodLabel(period) + ' 안에 관측된 소모가 없습니다. 사용량이 0이라는 뜻이 아닙니다.' };
    }
    const coverage = num(t.coverage), span = num(t.spanHours) ?? 0;
    const partial = t.partial === true || t.observedIncrease === true || measured < held;
    const shortSpan = span < periodHours - TOL;
    const resetGaps = num(t.resetGaps) ?? 0, recovered = num(t.recoveredDeltaPp) ?? 0;
    const thin = coverage === null || coverage < 1 - FLOAT_SLACK;
    return {
        state: partial ? 'partial' : 'measured', windowId,
        value: '≈ ' + quotaFigure(delta) + '%p',
        note: [label, measured + '/' + held + '계정',
            t.observedIncrease === true ? '관측 증가분 추정' : null,
            shortSpan ? (period === 'weekly' ? '기록 ' + (Math.floor(span / 24 * 10) / 10) + '/7일' : '기록 ' + (Math.floor(span * 10) / 10) + '/' + periodHours + '시간') : null,
            thin && coverage !== null ? '관측 ' + quotaFigure(coverage * 100) + '%' : null,
        ].filter(Boolean).join(' · '),
        title: periodLabel(period) + ' 쿼타 소모 · ' + label + ' 한도 기준 · 이 한도를 가진 ' + held + '개 계정 중 선택 기간에 관측된 '
            + measured + '개의 합계. 필요 계정 수도 같은 합계로 계산합니다. '
            + (recovered > 0 ? '공백 복원 ' + quotaFigure(recovered) + '%p 포함. ' : '')
            + (resetGaps ? '관측 공백 안에서 리셋 ' + resetGaps + '회가 확인돼 합계는 하한입니다. ' : '')
            + (t.observedIncrease === true ? '리셋 주기가 확인되지 않아 연속 관측의 증가분만 합산한 추정입니다.' : ''),
    };
}
