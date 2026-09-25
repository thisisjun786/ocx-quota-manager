const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = value => value === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);

export function comparisonHtml(data, evaluateOllamaScenario) {
  const rows = data.models.map(m => `<tr><th scope="row">${escape(m.model)}</th><td>${m.pricedRequests} / ${m.requests}</td><td>${money(m.noCacheUsd)}</td><td data-model="${escape(m.model)}">${money(m.estimatedUsd)}</td></tr>`).join('');
  const serialized = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Ollama 신 크레딧 비교</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Noto Sans CJK KR',sans-serif;font-variant-numeric:tabular-nums}
main{max-width:1000px;margin:0 auto;padding:32px 24px}h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:24px 0 12px}p{margin:8px 0;word-break:keep-all}a{color:#005dbb}section{background:white;border:1px solid #dedee3;border-radius:12px;padding:20px;margin:20px 0}.note{color:#66666e;font-size:13px}.lead{font-size:18px}.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}input[type=range]{min-height:44px;width:260px;max-width:100%;accent-color:#0071e3}button{min-height:44px;border:1px solid #bbb;border-radius:7px;background:white;padding:8px 12px;color:#005dbb;font:inherit}button:focus-visible,input:focus-visible{outline:3px solid #0071e3;outline-offset:3px}output{font-weight:600;min-width:60px}.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:right;padding:10px 12px;border-bottom:1px solid #dedee3;white-space:nowrap}th:first-child,td:first-child{text-align:left}thead{color:#66666e}dl{display:grid;grid-template-columns:1fr 1fr;gap:12px}dt{font-size:13px;color:#66666e}dd{margin:0;font-size:22px}ul{padding-left:20px}.warning{color:#925300}@media(max-width:600px){main{padding:20px 12px}section{padding:16px}h1{font-size:23px}dl{grid-template-columns:1fr}.controls{gap:8px}}@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}section,button{background:#28282b}section,td,th{border-color:#414146}.note,dt,thead{color:#aaaab2}a,button{color:#63a9ff}.warning{color:#ffbc62}}
</style></head><body><main><h1>Ollama 신 크레딧 비교</h1>
<p class="lead">기록된 작업량을 현재 토큰 가격으로 다시 계산했습니다.</p>
<p class="note">조회 범위 ${escape(data.from)} ~ ${escape(data.through)}<br>Ollama 기록 ${escape(data.usageSince ?? '없음')} ~ ${escape(data.usageThrough ?? '없음')}</p>
<section aria-labelledby="scenario"><h2 id="scenario">캐시 가정 바꾸기</h2>
<div class="controls"><label for="cache-rate">캐시 입력 비율</label><input id="cache-rate" type="range" min="0" max="100" step="0.1" value="${((data.cache.appliedRate ?? 0) * 100).toFixed(1)}"><output id="cache-value" for="cache-rate">${data.cache.appliedRate === null ? '미확인' : (data.cache.appliedRate * 100).toFixed(1) + '%'}</output><button id="observed" type="button" ${data.cache.observedRate === null ? 'disabled' : ''}>관측 평균 적용</button></div>
<p class="note">다른 프로바이더의 캐시 읽기 토큰 합계 ÷ 입력 토큰 합계. 캐시 필드가 없는 호출·추정 토큰은 평균에서 제외합니다. 기록된 Ollama 캐시 값이 있으면 그대로 사용합니다.</p>
<dl aria-live="polite"><div><dt>캐시 미적용 환산액</dt><dd id="no-cache">${money(data.totals.noCacheUsd)}</dd></div><div><dt>캐시 적용 환산액 · 추정</dt><dd id="estimated">${money(data.totals.estimatedUsd)}</dd></div></dl>
<p id="coverage" class="note">${data.totals.requests}회 중 ${data.totals.pricedRequests}회 계산 · ${data.totals.unpricedRequests}회 토큰·단가 미확인 · 피크 요금 ${data.totals.peakRequests}회</p>
${data.partial ? '<p class="warning">일부 기록만 환산했습니다. 미확인 호출은 0원 사용으로 간주하지 않습니다.</p>' : ''}
<p class="note">공식 캐시 단가 미제공 ${data.totals.noCacheRateRequests}회는 입력 정가 기준입니다. 추정값은 구버전 GPU 사용률·실제 청구액과 다릅니다.</p></section>
<section aria-labelledby="models"><h2 id="models">모델별 환산액</h2><div class="table"><table><thead><tr><th>모델</th><th>계산 / 전체 호출</th><th>캐시 미적용</th><th>캐시 적용 · 추정</th></tr></thead><tbody>${rows || '<tr><td colspan="4">조회 구간에 Ollama 호출 기록이 없습니다.</td></tr>'}</tbody></table></div></section>
<section aria-labelledby="plans"><h2 id="plans">신 요금제 크레딧과 비교</h2><p>사용 중인 구버전 Max 구독료는 월 $100입니다.</p><p class="note">아래 비율은 조회 구간 환산액을 신 요금제의 한 달 제공 크레딧과 비교한 값입니다. 실제 월 잔액이나 다음 달 사용 예측이 아닙니다.</p><div class="table"><table><thead><tr><th>신 요금제</th><th>월 구독료</th><th>월 제공 크레딧</th><th>기록 환산액 / 크레딧</th></tr></thead><tbody id="plans-body"></tbody></table></div></section>
<section aria-labelledby="reference"><h2 id="reference">캐시 평균의 근거</h2><div class="table"><table><thead><tr><th>프로바이더</th><th>실측 호출</th><th>입력 토큰</th><th>캐시 읽기 비율</th></tr></thead><tbody>${data.cache.providers.map(s => `<tr><th>${escape(s.provider)}</th><td>${s.requests.toLocaleString('en-US')}</td><td>${s.inputTokens.toLocaleString('en-US')}</td><td>${(s.cachedInputTokens / s.inputTokens * 100).toFixed(2)}%</td></tr>`).join('')}</tbody></table></div>
<p class="note">다른 서비스의 캐시 비율이 Ollama에서도 같다는 보장은 없습니다. 슬라이더로 가정을 바꿔 비교할 수 있습니다.</p></section>
<footer><p><a href="https://ollama.com/pricing" rel="noreferrer">Ollama 공식 가격표</a> · 2026-09-10 확인</p><ul class="note">${data.notes.map(n => `<li>${escape(n)}</li>`).join('')}</ul><p class="note">중복 제외 ${data.duplicates}건 · 잘못된 로그 ${data.invalidLines}줄 · 데이터와 계산은 이 파일 안에서만 처리합니다.</p></footer>
<noscript>기본 가정의 모델별 결과는 위 표에서 볼 수 있습니다. 캐시 비율을 바꾸려면 JavaScript가 필요합니다.</noscript>
<script>const data=${serialized};const evaluate=${evaluateOllamaScenario.toString()};const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;(${reportApp.toString()})();</script></main></body></html>`;
}

function reportApp() {
  const $ = id => document.getElementById(id);
  const usd = value => value === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
  function render(rate) {
    const scenario = evaluate(data.totals, rate);
    $('cache-value').textContent = rate === null ? '미확인' : (rate * 100).toFixed(1) + '%';
    $('estimated').textContent = usd(scenario.estimatedUsd);
    for (const el of document.querySelectorAll('[data-model]')) el.textContent = usd(evaluate(data.models.find(m => m.model === el.dataset.model), rate).estimatedUsd);
    $('plans-body').replaceChildren();
    for (const plan of data.plans) {
      const tr = document.createElement('tr');
      const percent = scenario.estimatedUsd === null ? '—' : (scenario.estimatedUsd / plan.includedCreditsUsd * 100).toFixed(3) + '%';
      for (const value of [plan.label ?? plan.id, usd(plan.monthlyUsd), usd(plan.includedCreditsUsd), percent]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      $('plans-body').append(tr);
    }
  }
  $('cache-rate').addEventListener('input', event => render(Number(event.target.value) / 100));
  $('observed').addEventListener('click', () => { $('cache-rate').value = data.cache.observedRate * 100; render(data.cache.observedRate); });
  render(data.cache.appliedRate);
}
