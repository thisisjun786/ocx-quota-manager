const DAY = 86400000;
const mean = values => values.reduce((sum,n)=>sum+n,0)/values.length;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const hasCapacity = w => !w?.stale && w?.analytics?.status !== 'stale' && Number.isFinite(w?.analytics?.capacityApiUsd) && w.analytics.capacityApiUsd > 0;
const shortWindow = a => a.windows.find(w => w.id === 'five-hour' || (w.id === 'short' && w.label === '5시간'));
const overallWeekly = w => w?.id === 'weekly' && (w.usageScope == null || w.usageScope === 'all') && hasCapacity(w);

// Estimate a provider's workload against the arithmetic mean of measured accounts.
// Plan names and subscription prices do not determine quota capacity.
export function recommendSubscriptions(provider, store, now, rolling = null) {
  const monthly = provider.analytics.periods.monthly;
  const since = rolling ? null : store.pricedBounds(provider.id,now-30*DAY,now).since;
  const pricedDays = Number.isFinite(since) ? (now-since)/DAY : 0;
  const coverageHours = monthly?.observedCoverageHours;
  const coverageDays = Number.isFinite(coverageHours) && coverageHours >= 0 ? coverageHours/24 : 0;
  const observedDays = rolling ? rolling.hours / 24 : clamp(Math.max(pricedDays, coverageDays), 0, 30);
  // Selection is not usability, and missing quota is not a lost subscription.
  // Bare API keys need a plan or quota evidence before counting as subscriptions.
  const configured = provider.accounts.filter(a => !['reauth','paused'].includes(a.status) &&
    (!a.id?.startsWith('key:') || a.plan || a.windows.length || a.analytics?.subscription?.monthlyUsd > 0));
  const available = configured.filter(a => a.windows.length && (a.status === 'ok' ||
    (a.status === 'stale' && a.windows.some(w => w.stale === false))));
  const result = { status:'collecting', observedDays, weeklyDemandApiUsd:null, weeklyCapacityPerAccountUsd:null,
    minimumAccounts:null,recommendedAccounts:null,currentAccounts:configured.length,additionalAccounts:null,
    estimatedMonthlyUsd:null,headroomPercent:20,reason:'계정당 한도 가치와 사용 기록을 수집 중입니다.',planLabel:null,peakFiveHourAccounts:null,
    capacitySampleAccounts:0,fiveHourSampleAccounts:0,baselineWeeklyDemandApiUsd:null,recentWeeklyDemandApiUsd:null,recentObservedDays:0,demandBasis:null,
    observedAt:provider.analytics.pace?.observedAt ?? null,usageStale:provider.analytics.pace?.stale === true };
  if (rolling && rolling.hours < .25) return {...result, basisPeriod:rolling.key, reason:'선택 기간에 관측한 사용 기록이 15분 이상 필요합니다.'};
  if (!rolling && observedDays < 1) return {...result,reason:'최소 하루의 사용 기록이 필요합니다. 최근 30일이 쌓일수록 안정적입니다.'};
  const usage = rolling?.stats ?? monthly;
  const partialUsage = usage.unknownPriceRequests > 0;
  if (!Number.isFinite(usage.apiUsd)) return {...result,reason:'환산 가능한 사용 기록을 기다리고 있습니다.'};
  if (rolling) {
    result.basisPeriod = rolling.key;
    result.observedHours = rolling.hours;
    result.weeklyDemandApiUsd = usage.apiUsd / rolling.hours * 168;
    result.demandBasis = 'selected-period';
  } else {
    result.recentObservedDays = Math.min(7, observedDays);
    result.baselineWeeklyDemandApiUsd = monthly.apiUsd / observedDays * 7;
    const recentUsd = provider.analytics.periods.weekly.apiUsd;
    if (result.recentObservedDays>=1 && Number.isFinite(recentUsd)) result.recentWeeklyDemandApiUsd = recentUsd/result.recentObservedDays*7;
    result.weeklyDemandApiUsd = Math.max(result.baselineWeeklyDemandApiUsd,result.recentWeeklyDemandApiUsd ?? 0);
    result.demandBasis = result.recentWeeklyDemandApiUsd !== null && result.recentWeeklyDemandApiUsd>=result.baselineWeeklyDemandApiUsd ? 'recent-week' : 'monthly-baseline';
  }
  const candidates = available.filter(a => a.windows.some(overallWeekly));
  const weeklyWindows = candidates.map(a => a.windows.find(overallWeekly));
  if (!weeklyWindows.length) return {...result,reason:'주간 한도가 측정된 계정을 기다리고 있습니다.'};
  result.capacitySampleAccounts = candidates.length;
  result.weeklyCapacityPerAccountUsd = mean(weeklyWindows.map(w=>w.analytics.capacityApiUsd));
  const weeklyNeed = result.weeklyDemandApiUsd / result.weeklyCapacityPerAccountUsd;
  const short = available.map(shortWindow).filter(hasCapacity);
  result.fiveHourSampleAccounts = short.length;
  if (!rolling && short.length) {
    // Reference only: the exclusive lower bound must keep the first burst request.
    const peakUsd = store.peakFiveHour(provider.id, now-30*DAY, now);
    result.peakFiveHourAccounts = Math.ceil(peakUsd / mean(short.map(w=>w.analytics.capacityApiUsd)));
  }
  result.minimumAccounts = Math.max(rolling ? 0 : 1,Math.ceil(weeklyNeed));
  result.recommendedAccounts = Math.max(rolling ? 0 : 1,Math.ceil(weeklyNeed/.8));
  result.additionalAccounts = Math.max(0,result.recommendedAccounts-result.currentAccounts);
  const prices = candidates.map(a=>a.analytics?.subscription?.monthlyUsd).filter(n=>Number.isFinite(n)&&n>0);
  // A missing price affects only the budget estimate, never the recommended count.
  if (prices.length === candidates.length) result.estimatedMonthlyUsd = result.recommendedAccounts * mean(prices);
  result.planLabel = '관측 계정 평균';
  const partialCapacity = weeklyWindows.some(w=>['partial','lower-bound'].includes(w.analytics.capacityBasis));
  const conservativeCapacity = weeklyWindows.some(w=>w.analytics.capacityBasis === 'lower-bound');
  const incompleteSample = candidates.length<configured.length;
  const mixedPlans = new Set(candidates.map(a=>a.plan ?? null)).size > 1;
  const strong = (rolling ? rolling.hours >= rolling.periodHours && rolling.hours >= 24 : observedDays>=30) && weeklyWindows.every(w=>w.analytics.confidence==='medium') && !usage.localPriceRequests && !partialUsage && !partialCapacity && !incompleteSample && !mixedPlans && !result.usageStale;
  result.status = strong?'ready':'provisional';
  result.reason = `여유를 반영한 필요 구독 ${result.recommendedAccounts}개 · 설정된 사용 가능 구독 ${result.currentAccounts}개 · 추가 필요 ${result.additionalAccounts}개. 모든 프로바이더는 주간 한도 기준입니다. ${rolling ? `선택 기간(${rolling.periodHours}시간)의 관측 ${Number(rolling.hours.toFixed(2))}시간 평균 속도를 주간 수요로 환산했습니다.` : '최근 7일 추세와 30일 기준 평균 중 큰 작업량을 사용했습니다.'} 측정된 ${candidates.length}개 계정의 평균 주간 한도 기준, 가동 여유 20%를 반영했습니다. 5시간·모델별 한도는 필요 계정 수에 포함하지 않습니다.` +
    (partialUsage||partialCapacity ? ' 미확인 사용은 제외했습니다.' : '') +
    (conservativeCapacity ? ' 한도를 보수적으로 잡아 기록된 사용량 기준 필요 계정 수가 늘었습니다. 기록되지 않은 사용이 있으면 실제 필요량은 이보다 클 수도 있습니다.' : '') +
    (incompleteSample ? ' 현재 계정 수는 설정된 사용 가능 계정 수이며, 한도는 측정 가능한 계정만 반영했습니다.' : '') +
    (mixedPlans ? ' 서로 다른 플랜의 평균이므로 같은 계정 구성을 유지한다는 가정입니다.' : '') +
    (result.usageStale ? ' 사용량은 마지막 수집 시점 기준입니다.' : '');
  return result;
}

// Match the summary: prefer an overall weekly window, otherwise monthly.
// One account supplies100pp per168 or720 hours, with no USD conversion.
export function recommendQuotaAccounts(provider, key, periodHours) {
  const accounts = provider.accounts ?? [];
  const windowId = ['weekly','monthly'].find(id => accounts.some(a =>
    a.windows?.some(w => w.id === id && w.analytics?.providerWide === true)));
  const capacityHours = windowId === 'weekly' ? 168 : windowId === 'monthly' ? 720 : null;
  const current = accounts.filter(a => !['reauth', 'paused'].includes(a.status)).length;
  const result = {status:'collecting', basisPeriod:key, periodHours, demandBasis:'quota-consumption',
    headroomPercent:0, windowId:windowId ?? null, capacityHours, currentAccounts:current, minimumAccounts:null, recommendedAccounts:null,
    additionalAccounts:null, totalConsumedPp:null, sampleAccounts:0, estimatedMonthlyUsd:null,
    reason:'주간·월간 쿼타 소모 기록을 기다리고 있습니다.'};
  const measured = accounts.flatMap(a => {
    const w = a.windows?.find(w => w.id === windowId && w.analytics?.providerWide === true);
    const current = w?.analytics?.consumptionPeriods?.[key];
    const historical = !Number.isFinite(current?.deltaPp) ? w?.analytics?.historicalConsumptionPeriods?.[key] : null;
    const sample = historical ?? current;
    return w && Number.isFinite(sample?.deltaPp) && sample.deltaPp >= 0 ? [{a, sample, historical:!!historical}] : [];
  });
  if (!measured.length || !(periodHours > 0)) return result;
  const total = measured.reduce((sum, {sample}) => sum + sample.deltaPp, 0);
  const raw = total / 100 * capacityHours / periodHours;
  // Remove only floating-point summation residue at an integer boundary.
  const nearest = Math.round(raw);
  const stable = nearest > 0 && Math.abs(raw - nearest) <= Number.EPSILON * Math.max(1, raw) * 8 ? nearest : raw;
  const needed = Math.ceil(stable);
  const observedIncrease = measured.some(({sample}) => sample.basis === 'observed-increase');
  const historical = measured.filter(row => row.historical);
  const incomplete = measured.length < accounts.length || measured.some(({sample}) =>
    !Number.isFinite(sample.spanHours) || sample.spanHours < periodHours - 1/3600 ||
    !Number.isFinite(sample.coverage) || sample.coverage < 1-1e-9);
  const prices = measured.map(({a})=>a.analytics?.subscription?.monthlyUsd);
  return {...result, status:historical.length || observedIncrease || incomplete?'provisional':'ready', minimumAccounts:needed,
    usageStale:historical.length > 0,
    historicalPeriodEnds:historical.map(({sample})=>sample.periodEndedAt),
    recommendedAccounts:needed, additionalAccounts:Math.max(0,needed-current),
    totalConsumedPp:total, sampleAccounts:measured.length,
    estimatedMonthlyUsd:prices.every(p=>Number.isFinite(p)&&p>0)?needed*mean(prices):null,
    reason:`${windowId === 'weekly' ? '주간' : '월간'} 쿼타 소모 합계 ${Number(total.toFixed(4))}%p ÷ 100 × (${capacityHours}시간 ÷ ${periodHours}시간), 올림 = ${needed}개. 여유분을 더하지 않습니다.` +
      (historical.length?' 현재 기간을 관측하지 못한 계정은 마지막 관측까지의 같은 길이 기간을 사용한 이전 추정입니다. 계정별 기준 시각: '+historical.map(({sample})=>sample.periodEndedAt).join(', ')+'. 현재 수요를 뜻하지 않습니다.':'') +
      (observedIncrease?' 리셋 주기 미확인: 관측 증가분으로 추정한 잠정치입니다. 이동 구간에서 회복된 양과 새 소모가 상쇄되면 실제 필요량보다 적게 나옵니다.':'') +
      (incomplete?' 일부 계정·시간의 기록만 있어 실제 필요량보다 적을 수 있습니다.':'') +
      (new Set(measured.map(({a})=>a.plan ?? null)).size>1?' 계정별100%를 한 계정분으로 세므로 서로 다른 플랜은 직접 비교하기 어렵습니다.':'')};
}
