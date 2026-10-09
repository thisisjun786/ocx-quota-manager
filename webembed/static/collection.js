import { node } from './dom.js';
import { parseLogPage, RESULTS } from './collection-data.js';
const two = (n) => String(n).padStart(2, '0');
const timestamp = (n) => { if (n === null)
    return '—'; const d = new Date(n); return `${two(d.getMonth() + 1)}.${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
const percent = (n) => n === null ? '—' : `${n.toFixed(1)}%`;
const accountValue = (provider, account) => `${provider}\u0000${account}`;
export function collectionView() {
    const root = node('section', 'collection');
    const filters = node('div', 'collection-filters');
    const status = node('p', 'sub-note');
    status.setAttribute('role', 'status');
    const stamp = node('p', 'sub-note');
    stamp.setAttribute('aria-live', 'off');
    const body = node('div');
    const controls = new Map();
    let data = null, providers = [], before = null;
    let pending = null;
    const periods = node('div', 'period-picker');
    periods.setAttribute('aria-label', '수집 로그 기간');
    periods.setAttribute('role', 'group');
    let period = '24h';
    for (const [value, label] of [['1h', '1시간'], ['24h', '24시간'], ['7d', '7일']]) {
        if (!value || !label)
            continue;
        const button = node('button', '', label);
        button.dataset.period = value;
        button.setAttribute('aria-pressed', String(value === period));
        button.onclick = () => { period = value; before = null; for (const b of periods.querySelectorAll('button'))
            b.setAttribute('aria-pressed', String(b.dataset.period === period)); void load({ announce: true }); };
        periods.append(button);
    }
    filters.append(periods);
    for (const [key, label] of [['provider', '프로바이더'], ['account', '계정'], ['result', '결과']]) {
        if (!key || !label)
            continue;
        const wrap = node('label', 'collection-filter', label), select = node('select');
        select.name = key;
        select.setAttribute('aria-label', label);
        select.append(new Option('전체', ''));
        controls.set(key, select);
        wrap.append(select);
        filters.append(wrap);
        select.onchange = () => { before = null; if (key === 'provider') {
            const account = controls.get('account');
            if (account)
                account.value = '';
        } pressed(); void load({ announce: true }); };
    }
    for (const [key, label] of Object.entries(RESULTS))
        controls.get('result')?.append(new Option(label, key));
    const only429 = node('button', 'refresh', '429만 보기');
    function pressed() { only429.setAttribute('aria-pressed', String(controls.get('result')?.value === 'rate_limited')); }
    only429.onclick = () => { const result = controls.get('result'); if (result)
        result.value = result.value === 'rate_limited' ? '' : 'rate_limited'; before = null; pressed(); void load({ announce: true }); };
    pressed();
    filters.append(only429);
    const intro = node('p', 'sub-note', '외부 쿼타 조회 기록 · 모델 추론 호출은 포함하지 않습니다. ');
    intro.append(node('span', 'collection-phrase', '기본 조회 간격은 계정·엔드포인트별 5분입니다.'));
    const meta = node('div', 'collection-meta');
    meta.append(stamp, status);
    root.append(intro, filters, meta, body);
    function name(id) { return providers.find(p => p.id === id)?.name ?? id; }
    function accountName(provider, id) { return providers.find(p => p.id === provider)?.accounts.find(a => a.id === id)?.label ?? id; }
    function choices() {
        if (!data)
            return;
        for (const key of ['provider', 'account']) {
            const select = controls.get(key);
            if (!select)
                continue;
            const selected = select.value;
            const wanted = [['', '전체']];
            if (key === 'provider')
                for (const p of data.providers)
                    wanted.push([p, name(p)]);
            else
                for (const a of data.accounts) {
                    if (controls.get('provider')?.value && controls.get('provider')?.value !== a.provider)
                        continue;
                    wanted.push([accountValue(a.provider, a.account), `${name(a.provider)} · ${accountName(a.provider, a.account)}`]);
                }
            const current = Array.from(select.options).filter(o => o.value !== selected || wanted.some(w => w[0] === o.value)).map(o => [o.value, o.text]);
            if (current.length === wanted.length && current.every((c, i) => c[0] === wanted[i]?.[0] && c[1] === wanted[i]?.[1]))
                continue;
            select.replaceChildren(...wanted.map(([value, label]) => new Option(label, value)));
            if (selected && !Array.from(select.options).some(o => o.value === selected)) {
                const [p, a] = selected.split('\u0000');
                select.append(new Option(a === undefined ? name(selected) : `${name(p ?? '')} · ${accountName(p ?? '', a)}`, selected));
            }
            select.value = selected;
        }
    }
    function table(headers, label, key) {
        const region = node('div', 'collection-table');
        region.tabIndex = 0;
        region.setAttribute('role', 'region');
        region.setAttribute('aria-label', label);
        region.dataset.logFocus = key;
        region.dataset.logScroll = key;
        const table = node('table'), group = node('colgroup'), head = node('thead'), tr = node('tr'), tbody = node('tbody');
        for (const cls of ['time', 'target', 'result', 'next', 'duration']) {
            const col = node('col');
            col.className = cls;
            group.append(col);
        }
        for (const title of headers) {
            const th = node('th', '', title);
            th.scope = 'col';
            tr.append(th);
        }
        head.append(tr);
        table.append(group, head, tbody);
        region.append(table);
        return { region, tbody };
    }
    function draw() {
        if (!data)
            return;
        const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.logFocus : undefined;
        const open = new Set(Array.from(body.querySelectorAll('details[open]')).map(d => d.getAttribute('data-id')));
        const scrolls = new Map(Array.from(body.querySelectorAll('[data-log-scroll]')).map(el => [el.dataset.logScroll, el.scrollLeft]));
        body.replaceChildren();
        const note = node('p', 'sub-note', '선택한 기간·프로바이더·계정의 전체 시도 기준입니다. ');
        note.append(node('span', 'collection-phrase', '결과 필터는 아래 요청 목록에만 적용됩니다.'));
        body.append(node('h2', '', '프로바이더별 수집 상태'), note);
        const cards = node('div', 'collection-cards');
        for (const s of data.summary) {
            const card = node('article', 'collection-card');
            card.append(node('h3', '', name(s.provider)));
            const rows = [['시도', [node('span', 'num', String(s.attempts)), '회']], ['성공률', [node('span', 'num', percent(s.successRate))]], ['429 횟수 · 비율', [node('span', 'num', String(s.rateLimited)), '회 · ', node('span', 'num', percent(s.rateLimitRate))]], ['마지막 성공', [node('span', 'num', timestamp(s.lastSuccessAt))]]];
            for (const [label, parts] of rows) {
                const row = node('div', 'metric'), value = node('strong');
                value.append(...parts);
                row.append(node('span', '', label), value);
                card.append(row);
            }
            cards.append(card);
        }
        if (data.summary.length)
            body.append(cards);
        else
            body.append(node('p', 'empty', '선택한 기간의 수집 기록이 없습니다. 로그를 활성화한 이후의 요청부터 표시합니다.'));
        const requestsHeading = node('h2', '', data.nextBefore === null && before === null ? `요청 목록 · ${data.rows.length}건` : `요청 목록 · 이 페이지 ${data.rows.length}건`);
        requestsHeading.tabIndex = -1;
        body.append(requestsHeading);
        const requests = table(['시각', '대상', '결과', '다음 조회 · 상세', '소요 시간'], '외부 쿼타 요청 목록', 'requests');
        for (const r of data.rows) {
            const tr = node('tr');
            tr.dataset.logId = String(r.id);
            tr.append(node('td', 'collection-time', timestamp(r.startedAt)));
            const target = node('td');
            target.append(node('strong', '', name(r.provider)), node('small', '', accountName(r.provider, r.account)), node('small', 'collection-machine', r.endpoint));
            tr.append(target);
            const result = node('td');
            result.append(node('span', r.result === 'ok' ? 'badge' : 'badge warning', RESULTS[r.result]), r.httpStatus === null ? node('small', '', '응답 없음') : node('small', 'collection-machine', `HTTP ${r.httpStatus}`));
            tr.append(result);
            const detail = node('td'), disclosure = node('details');
            disclosure.dataset.id = String(r.id);
            disclosure.open = open.has(String(r.id));
            const toggle = node('summary', 'collection-machine', timestamp(r.nextAttemptAt));
            toggle.dataset.logFocus = String(r.id);
            toggle.setAttribute('aria-label', `다음 조회 ${timestamp(r.nextAttemptAt)} · 상세 보기`);
            disclosure.append(toggle, node('p', 'sub-note collection-retry', `서버 요청 대기 ${r.retryAfterMs === null ? '없음' : `${r.retryAfterMs / 1000}초`} · 연속 실패 ${r.failures}회`));
            detail.append(disclosure);
            tr.append(detail, node('td', 'collection-machine', `${r.durationMs} ms`));
            requests.tbody.append(tr);
        }
        if (data.rows.length)
            body.append(requests.region);
        else {
            const empty = node('div', 'empty', '선택한 조건에 맞는 요청이 없습니다.');
            const filtered = Array.from(controls.values()).some(s => s.value);
            if (filtered) {
                const clear = node('button', '', '필터 해제');
                clear.onclick = () => { for (const s of controls.values())
                    s.value = ''; before = null; pressed(); void load({ announce: true }); };
                empty.append(clear);
            }
            body.append(empty);
        }
        const paging = node('div', 'collection-paging');
        if (before !== null) {
            const latest = node('button', 'refresh', '최신 기록');
            latest.dataset.logFocus = 'latest';
            latest.onclick = () => { before = null; void load({ announce: true }); };
            paging.append(latest);
        }
        if (data.nextBefore !== null) {
            const next = node('button', 'refresh', '이전 100건');
            next.dataset.logFocus = 'older';
            const cursor = data.nextBefore;
            next.onclick = () => { before = cursor; void load({ announce: true }); };
            paging.append(next);
        }
        const retention = node('p', 'sub-note', `상세 기록 ${data.retentionDays}일 보관 · `);
        retention.append(node('span', 'num', timestamp(data.from)), ' ~ ', node('span', 'num', timestamp(data.to)));
        body.append(paging, retention);
        for (const el of body.querySelectorAll('[data-log-scroll]')) {
            const left = scrolls.get(el.dataset.logScroll);
            if (left)
                el.scrollLeft = left;
        }
        if (focused) {
            const targets = Array.from(body.querySelectorAll('[data-log-focus]'));
            const paged = focused === 'latest' || focused === 'older';
            (targets.find(el => el.dataset.logFocus === focused) ?? (paged ? targets.find(el => el.dataset.logFocus === 'latest' || el.dataset.logFocus === 'older') ?? requestsHeading : undefined))?.focus({ preventScroll: true });
        }
    }
    let pendingAnnounce = false;
    async function load({ announce = false } = {}) {
        if (pending && !announce && pendingAnnounce)
            return;
        pending?.abort();
        const request = new AbortController();
        pending = request;
        pendingAnnounce = announce;
        const params = new URLSearchParams({ period });
        for (const [key, select] of controls) {
            if (!select.value)
                continue;
            if (key === 'account') {
                const [provider, account] = select.value.split('\u0000');
                if (provider && account) {
                    params.set('provider', provider);
                    params.set('account', account);
                }
            }
            else
                params.set(key, select.value);
        }
        if (before !== null)
            params.set('before', String(before));
        if (announce || !data)
            status.textContent = '수집 기록을 불러오는 중…';
        root.setAttribute('aria-busy', 'true');
        try {
            const response = await fetch(`/api/v1/collection-logs?${params}`, { cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
            if (!response.ok)
                throw new Error('Collection unavailable');
            const next = parseLogPage(await response.json());
            if (request.signal.aborted)
                return;
            data = next;
            choices();
            draw();
            stamp.replaceChildren(node('span', 'num', timestamp(data.to)), ` 기준 · ${before === null ? '최신 기록' : '이전 기록 페이지'}`);
            if (announce)
                status.textContent = `${data.rows.length}건 표시`;
            else if (status.textContent)
                status.textContent = '';
        }
        catch (error) {
            if (request.signal.aborted)
                return;
            const message = data ? '수집 로그 갱신 실패 · 이전 기록을 표시합니다. 새로고침으로 다시 시도하세요.' : '수집 로그를 불러오지 못했습니다. 새로고침으로 다시 시도하세요.';
            if (status.textContent !== message)
                status.textContent = message;
        }
        finally {
            if (pending === request) {
                pending = null;
                root.setAttribute('aria-busy', 'false');
            }
        }
    }
    return { root, refresh: () => load(), update: (next) => { providers = next; }, cancel: () => { pending?.abort(); pending = null; } };
}
