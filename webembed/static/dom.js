import { finite, date, quotaFigure } from './format.js';
import { asRecord, num } from './types.js';
const ns = 'http://www.w3.org/2000/svg';
export function node(tag, className, value) {
    const el = document.createElement(tag);
    if (className)
        el.className = className;
    if (value !== undefined)
        el.textContent = value;
    return el;
}
export function svg(tag, attrs) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs || {}))
        el.setAttribute(k, v);
    return el;
}
export function metric(label, value, note) {
    const item = node('div', 'metric');
    item.append(node('span', '', label), node('strong', '', value));
    if (note)
        item.append(node('small', '', note));
    return item;
}
export function quotaTrack(remaining, label) {
    const track = node('div', 'track');
    if (finite(remaining)) {
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-label', label);
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        track.setAttribute('aria-valuenow', String(remaining));
        // 눈에 보이는 숫자와 같은 정밀도로 읽어야 한다. 한쪽만 두 자리로 열면 보는 사람과
        // 듣는 사람이 서로 다른 값을 받는다.
        track.setAttribute('aria-valuetext', `${quotaFigure(remaining)}% 남음`);
        const fill = node('div', 'fill');
        fill.style.width = `${remaining}%`;
        track.append(fill);
    }
    return track;
}
function historyPoint(value) {
    const o = asRecord(value);
    if (!o || typeof o.at !== 'string' || !finite(Date.parse(o.at)))
        return null;
    const used = num(o.usedPercent);
    if (used === null)
        return null;
    return typeof o.resetAt === 'string' ? { at: o.at, usedPercent: used, resetAt: o.resetAt } : { at: o.at, usedPercent: used };
}
export function historyChart(history, label) {
    const wrap = node('div', 'spark');
    const typed = Array.isArray(history) ? history.map(historyPoint).filter((p) => p !== null) : [];
    if (typed.length < 2) {
        wrap.append(node('p', 'unavailable', '데이터 수집 중'));
        return wrap;
    }
    const times = typed.map(p => Date.parse(p.at));
    const minT = Math.min(...times), maxT = Math.max(...times);
    const span = Math.max(1, maxT - minT);
    const w = 220, h = 48, pad = 2;
    const figure = node('figure', 'spark-figure');
    const chart = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', class: 'spark-svg' });
    chart.setAttribute('aria-label', `${label} 사용률 추이, ${typed.length}개 측정`);
    const title = svg('title');
    title.textContent = `${label} 사용률 추이`;
    chart.append(title);
    const first = typed[0];
    let path = '', lastReset = first?.resetAt ?? '';
    for (let i = 0; i < typed.length; i++) {
        const cur = typed[i];
        const prev = typed[i - 1];
        const t = times[i];
        if (!cur || t === undefined)
            continue;
        const x = pad + (t - minT) / span * (w - pad * 2);
        const y = pad + (1 - Math.min(100, Math.max(0, cur.usedPercent)) / 100) * (h - pad * 2);
        const reset = cur.resetAt ?? '';
        const prevT = times[i - 1];
        if (i === 0 || (reset !== lastReset && Math.abs(Date.parse(reset) - Date.parse(lastReset)) > 60000) || (i > 0 && prev && prevT !== undefined && (cur.usedPercent < prev.usedPercent || t - prevT > 20 * 60000))) {
            if (path) {
                const line = svg('path', { d: path });
                chart.append(line);
            }
            path = `M${x.toFixed(1)} ${y.toFixed(1)}`;
            lastReset = reset;
        }
        else
            path += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    if (path)
        chart.append(svg('path', { d: path }));
    figure.append(chart);
    wrap.append(figure);
    return wrap;
}
export function sourceLink(source) {
    const item = node('li');
    if (source?.url) {
        const a = node('a', '', source.label || source.url);
        a.href = source.url;
        a.rel = 'noreferrer noopener';
        a.target = '_blank';
        item.append(a);
        if (source.checkedAt)
            item.append(document.createTextNode(` · ${date.format(new Date(source.checkedAt))}`));
    }
    else
        item.textContent = source?.label || '출처 확인 중';
    return item;
}
export function methodology(analytics, extra) {
    const box = node('details', 'method');
    box.dataset.expand = extra?.key || 'method';
    const summary = node('summary', '', extra?.title || '계산 방식과 출처');
    box.append(summary);
    const notes = [...(analytics?.notes ?? []), ...(extra?.notes ?? [])].filter(Boolean);
    if (notes.length) {
        const list = node('ul', 'notes');
        for (const note of notes)
            list.append(node('li', '', note));
        box.append(list);
    }
    const sources = analytics?.sources ?? extra?.sources ?? [];
    if (sources.length) {
        const list = node('ul', 'sources');
        for (const source of sources)
            list.append(sourceLink(source));
        box.append(list);
    }
    if (extra?.body)
        box.append(extra.body);
    if (!notes.length && !sources.length && !extra?.body)
        box.append(node('p', 'unavailable', '출처가 아직 없습니다.'));
    return box;
}
