import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendSubscriptions, recommendQuotaAccounts } from '../src/recommendation.mjs';
const now=1800000000000, DAY=86400000;
function fixture({days=30,dollars=6000,peak=300,short=false,weeklyDollars=dollars/Math.min(days,30)*Math.min(days,7)}={}) {
 const account=()=>({plan:'pro',status:'ok',analytics:{subscription:{monthlyUsd:200,label:'Pro'}},windows:[
  {id:'weekly',analytics:{capacityApiUsd:1000,confidence:'medium'}},
  ...(short?[{id:'five-hour',analytics:{capacityApiUsd:100,confidence:'medium'}}]:[]),
 ]});
 return {provider:{id:'openai',accounts:[account(),account()],analytics:{periods:{weekly:{apiUsd:weeklyDollars},monthly:{apiUsd:dollars,unknownPriceRequests:0,localPriceRequests:0,observedCoverageHours:Math.min(days,30)*24}}}},
 store:{pricedBounds:(_provider,from)=>({since:Math.max(now-days*DAY,from+1)}),peakFiveHour:()=>peak}};
}
test('missing costs or no measured weekly capacity keep recommendations collecting',()=>{
 for(const mutate of [p=>p.analytics.periods.monthly.apiUsd=null,p=>p.accounts.forEach(a=>a.windows[0].analytics.capacityApiUsd=null)]) {
  const {provider,store}=fixture();mutate(provider);const r=recommendSubscriptions(provider,store,now);assert.equal(r.status,'collecting');assert.equal(r.recommendedAccounts,null);
 }
});
test('30-day work normalizes to weekly demand and 20% spare utilization',()=>{
 const {provider,store}=fixture();const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.weeklyDemandApiUsd,1400);assert.equal(r.minimumAccounts,2);assert.equal(r.recommendedAccounts,2);assert.equal(r.additionalAccounts,0);assert.equal(r.estimatedMonthlyUsd,400);assert.equal(r.status,'ready');
});
test('peak five-hour work remains a reference without raising weekly account need',()=>{
 const {provider,store}=fixture({short:true});const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.peakFiveHourAccounts,3);assert.equal(r.minimumAccounts,2);assert.equal(r.recommendedAccounts,2);assert.equal(r.additionalAccounts,0);assert.equal(r.estimatedMonthlyUsd,400);
});
test('short histories stay provisional and sub-day histories do not produce recommendations',()=>{
 let f=fixture({days:7,dollars:1400});assert.equal(recommendSubscriptions(f.provider,f.store,now).status,'provisional');
 f=fixture({days:.5});assert.equal(recommendSubscriptions(f.provider,f.store,now).recommendedAccounts,null);
});
test('model-specific caps do not affect weekly confidence but local prices still do',()=>{
 const f=fixture();f.provider.accounts[0].windows.push({id:'custom-0',usedPercent:30});assert.equal(recommendSubscriptions(f.provider,f.store,now).status,'ready');
 f.provider.analytics.periods.monthly.localPriceRequests=1;assert.equal(recommendSubscriptions(f.provider,f.store,now).status,'provisional');
});


test('unknown calls are skipped while known costs still produce a provisional recommendation',()=>{
 const {provider,store}=fixture();provider.analytics.periods.monthly.unknownPriceRequests=141;
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.weeklyDemandApiUsd,1400);assert.equal(r.recommendedAccounts,2);assert.equal(r.status,'provisional');
 assert.match(r.reason,/미확인 사용은 제외/);
});
test('partial weekly and five-hour capacities remain usable as provisional estimates',()=>{
 const {provider,store}=fixture({short:true});
 for(const a of provider.accounts) for(const w of a.windows) w.analytics.capacityBasis='lower-bound';
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.recommendedAccounts,2);assert.equal(r.status,'provisional');
 // A conservative capacity raises the count for RECORDED demand only. Demand is read
 // from the same log, so the reason must not present the count as an upper bound.
 assert.match(r.reason,/기록되지 않은 사용이 있으면 실제 필요량은 이보다 클 수도 있습니다/);
 assert.doesNotMatch(r.reason,/상한/);
 provider.accounts[0].windows[1].analytics.capacityApiUsd=null;
 assert.equal(recommendSubscriptions(provider,store,now).recommendedAccounts,2);
});


test('different plans and widely different capacities use the arithmetic mean',()=>{
 const {provider,store}=fixture({dollars:15000});
 provider.accounts[0].plan='plus';provider.accounts[0].windows[0].analytics.capacityApiUsd=100;
 provider.accounts[1].windows[0].analytics.capacityApiUsd=1000;
 provider.accounts.push({...provider.accounts[1],windows:[{id:'weekly',analytics:{capacityApiUsd:4000,confidence:'medium'}}]});
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.weeklyCapacityPerAccountUsd,1700);assert.equal(r.capacitySampleAccounts,3);assert.equal(r.recommendedAccounts,3);
});
test('one measured account supplies the baseline despite unknown plans and prices',()=>{
 const {provider,store}=fixture();
 for(const a of provider.accounts){a.plan=null;a.analytics.subscription.monthlyUsd=null;}
 provider.accounts[0].windows[0].analytics.capacityApiUsd=null;
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.capacitySampleAccounts,1);assert.equal(r.weeklyCapacityPerAccountUsd,1000);assert.equal(r.recommendedAccounts,2);
 assert.equal(r.currentAccounts,2);assert.equal(r.estimatedMonthlyUsd,null);assert.equal(r.status,'provisional');
});
test('missing five-hour estimates only change the reference sample',()=>{
 const {provider,store}=fixture({short:true});
 provider.accounts[0].windows[1].analytics.capacityApiUsd=null;
 let r=recommendSubscriptions(provider,store,now);assert.equal(r.fiveHourSampleAccounts,1);assert.equal(r.recommendedAccounts,2);assert.equal(r.status,'ready');
 provider.accounts[1].windows[1].analytics.capacityApiUsd=null;
 r=recommendSubscriptions(provider,store,now);assert.equal(r.recommendedAccounts,2);assert.equal(r.status,'ready');assert.equal(r.peakFiveHourAccounts,null);
});
test('stale and reauth accounts are excluded, measured key accounts are usable',()=>{
 const {provider,store}=fixture();provider.accounts[0].status='reauth';provider.accounts[1].id='key:subscription';
 const r=recommendSubscriptions(provider,store,now);assert.equal(r.currentAccounts,1);assert.equal(r.capacitySampleAccounts,1);assert.equal(r.recommendedAccounts,2);
 provider.accounts[1].status='stale';assert.equal(recommendSubscriptions(provider,store,now).recommendedAccounts,null);
});


test('recent growth is not diluted by a quiet month',()=>{
 const {provider,store}=fixture({dollars:17443,weeklyDollars:15148});
 for(const a of provider.accounts)a.windows[0].analytics.capacityApiUsd=8152;
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.baselineWeeklyDemandApiUsd,17443/30*7);assert.equal(r.weeklyDemandApiUsd,15148);
 assert.equal(r.demandBasis,'recent-week');assert.equal(r.recommendedAccounts,3);
});
test('four days of priced history are not divided by thirty days',()=>{
 const {provider,store}=fixture({days:4,dollars:1341,weeklyDollars:1341});
 for(const a of provider.accounts)a.windows[0].analytics.capacityApiUsd=1843;
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.observedDays,4);assert.equal(r.recentObservedDays,4);assert.equal(r.weeklyDemandApiUsd,2346.75);assert.equal(r.recommendedAccounts,2);
});
test('a quiet recent week does not erase the longer workload baseline',()=>{
 const {provider,store}=fixture({dollars:12000,weeklyDollars:1000});
 const r=recommendSubscriptions(provider,store,now);assert.equal(r.weeklyDemandApiUsd,2800);assert.equal(r.demandBasis,'monthly-baseline');assert.equal(r.recommendedAccounts,4);
});

test('temporary quota failures do not remove configured subscriptions or invent additional accounts',()=>{
 for(const status of ['stale','unavailable']) {
  const {provider,store}=fixture();
  provider.accounts[0].status=status;provider.accounts[0].active=false;
  if(status==='unavailable')provider.accounts[0].windows=[];
  const r=recommendSubscriptions(provider,store,now);
  assert.equal(r.currentAccounts,2,status);assert.equal(r.capacitySampleAccounts,1,status);
  assert.equal(r.recommendedAccounts,2,status);assert.equal(r.additionalAccounts,0,status);
  assert.equal(r.status,'provisional',status);
 }
});

test('configured counts exclude paused accounts and unmeasured pay-as-you-go keys',()=>{
 const {provider,store}=fixture();provider.accounts[0].status='paused';
 provider.accounts.push({id:'key:default',status:'unavailable',plan:null,windows:[],analytics:{subscription:{monthlyUsd:null}}});
 const r=recommendSubscriptions(provider,store,now);assert.equal(r.currentAccounts,1);assert.equal(r.additionalAccounts,1);
});

test('an expired secondary window does not exclude a fresh measured weekly window',()=>{
 const {provider,store}=fixture();provider.accounts[0].status='stale';
 provider.accounts[0].windows[0].stale=false;
 provider.accounts[0].windows.push({id:'monthly',stale:true,analytics:{capacityApiUsd:1000}});
 assert.equal(recommendSubscriptions(provider,store,now).capacitySampleAccounts,2);
 provider.accounts[0].windows[0].stale=true;
 assert.equal(recommendSubscriptions(provider,store,now).capacitySampleAccounts,1);
});

test('mixed plans and partial capacity preserve estimates without claiming a ready homogeneous cohort',()=>{
 const {provider,store}=fixture();provider.accounts[0].plan='plus';
 let r=recommendSubscriptions(provider,store,now);
 assert.equal(r.recommendedAccounts,2);assert.equal(r.status,'provisional');
 provider.accounts[0].plan='pro';provider.accounts[0].windows[0].analytics.capacityBasis='partial';
 r=recommendSubscriptions(provider,store,now);assert.equal(r.recommendedAccounts,2);assert.equal(r.status,'provisional');
});

test('all providers use only overall weekly capacity even with extreme secondary limits',()=>{
 for(const id of ['openai','anthropic','cursor','ollama-cloud','new-provider']) {
  const {provider,store}=fixture({short:true,peak:100000});provider.id=id;
  for(const a of provider.accounts) {
   a.windows[1].analytics.capacityBasis='partial';
   a.windows[1].analytics.confidence='low';
   a.windows.push({id:'custom-0',usageScope:'fable',usedPercent:99,analytics:{capacityApiUsd:1}});
  }
  let r=recommendSubscriptions(provider,store,now);
  assert.equal(r.recommendedAccounts,2,id);assert.equal(r.status,'ready',id);assert.equal(r.estimatedMonthlyUsd,400,id);
  for(const a of provider.accounts)a.windows[0].usageScope='fable';
  r=recommendSubscriptions(provider,store,now);assert.equal(r.status,'collecting',id);assert.equal(r.recommendedAccounts,null,id);
  for(const a of provider.accounts)a.windows[0]={id:'monthly',analytics:{capacityApiUsd:10000}};
  assert.equal(recommendSubscriptions(provider,store,now).recommendedAccounts,null,id);
 }
});

test('observed idle days and older monthly activity keep the recent-week denominator intact',()=>{
 const {provider,store}=fixture({dollars:700,weeklyDollars:700});
 store.pricedBounds=()=>({since:now-DAY});
 let r=recommendSubscriptions(provider,store,now);
 assert.equal(r.observedDays,30);assert.equal(r.recentObservedDays,7);assert.equal(r.weeklyDemandApiUsd,700);assert.equal(r.recommendedAccounts,1);assert.equal(r.status,'ready');
 provider.analytics.periods.monthly.observedCoverageHours=0;
 store.pricedBounds=()=>({since:now-29*DAY});
 r=recommendSubscriptions(provider,store,now);assert.equal(r.recentObservedDays,7);assert.equal(r.weeklyDemandApiUsd,700);assert.equal(r.status,'provisional');
});

test('selected-period rolling means scale to weekly capacity without monthly or peak overrides',()=>{
 const {provider,store}=fixture({dollars:999999,peak:999999,short:true});
 for(const [key,hours,usd,need] of [['oneHour',1,10,3],['fiveHour',5,10,1],['twentyFourHour',24,240,3],['weekly',168,1000,2],['monthly',720,1000,1]]) {
  const r=recommendSubscriptions(provider,store,now,{key,hours,periodHours:hours,stats:{apiUsd:usd}});
  assert.equal(r.recommendedAccounts,need,key);
  assert.equal(r.weeklyDemandApiUsd,usd/hours*168,key);
  assert.equal(r.basisPeriod,key);
 }
 const rec=stats=>recommendSubscriptions(provider,store,now,{key:'oneHour',hours:.5,periodHours:1,stats});
 assert.equal(rec({apiUsd:10}).weeklyDemandApiUsd,3360);
 assert.equal(rec({apiUsd:null}).recommendedAccounts,null);
 assert.equal(rec({apiUsd:0}).weeklyDemandApiUsd,0);
 assert.equal(rec({apiUsd:0}).recommendedAccounts,0);
 assert.equal(rec({apiUsd:0}).minimumAccounts,0);
 assert.equal(recommendSubscriptions(provider,store,now,{key:'oneHour',hours:.1,periodHours:1,stats:{apiUsd:10}}).recommendedAccounts,null);
});

test('quota account need is summed weekly percentage points projected to seven days without headroom or prices',async()=>{
 const {weeklyQuotaUsage}=await import('../public/quota.js');
 const account=(deltaPp,key='twentyFourHour',hours=24)=>({status:'ok',windows:[{id:'weekly',analytics:{providerWide:true,
  consumptionPeriods:{[key]:{deltaPp,spanHours:hours,coverage:1}}}}]});
 const p={accounts:[account(10),account(20),account(30),account(40)]};
 assert.equal(weeklyQuotaUsage(p,'twentyFourHour').value,'≈ 100%p');
 let r=recommendQuotaAccounts(p,'twentyFourHour',24);
 assert.equal(r.totalConsumedPp,100);assert.equal(r.recommendedAccounts,7);assert.equal(r.headroomPercent,0);assert.equal(r.status,'ready');
 for(const [key,hours,delta,expected] of [['oneHour',1,1,2],['fiveHour',5,10,4],['weekly',168,400,4],['monthly',720,1000,3]]) {
  r=recommendQuotaAccounts({accounts:[account(delta,key,hours)]},key,hours);assert.equal(r.recommendedAccounts,expected,key);
 }
 assert.equal(recommendQuotaAccounts({accounts:[account(0)]},'twentyFourHour',24).recommendedAccounts,0);
 p.accounts.push(account(null));r=recommendQuotaAccounts(p,'twentyFourHour',24);
 assert.equal(r.recommendedAccounts,7);assert.equal(r.status,'provisional');
 assert.equal(recommendQuotaAccounts({accounts:[account(null)]},'twentyFourHour',24).recommendedAccounts,null);
 const month=account(100);month.windows[0].id='monthly';
 assert.equal(recommendQuotaAccounts({accounts:[month]},'twentyFourHour',24).recommendedAccounts,30);
 assert.equal(recommendQuotaAccounts({accounts:[month]},'twentyFourHour',24).windowId,'monthly');
 assert.equal(recommendQuotaAccounts({accounts:[account(1e-14)]},'twentyFourHour',24).recommendedAccounts,1);
 assert.equal(recommendQuotaAccounts({accounts:[month,account(100)]},'twentyFourHour',24).recommendedAccounts,7);
 const short=account(100);short.windows[0].analytics.consumptionPeriods.twentyFourHour.spanHours=2;
 r=recommendQuotaAccounts({accounts:[short]},'twentyFourHour',24);assert.equal(r.recommendedAccounts,7);assert.equal(r.status,'provisional');
 for(const status of ['stale','reauth','paused']) {
  const historical=account(100);historical.status=status;historical.windows[0].stale=true;
  historical.windows[0].analytics.consumptionPeriods.twentyFourHour.coverage=.2;
  const p={accounts:[historical]};r=recommendQuotaAccounts(p,'twentyFourHour',24);
  assert.equal(weeklyQuotaUsage(p,'twentyFourHour').value,'≈ 100%p');
  assert.equal(r.totalConsumedPp,100);assert.equal(r.recommendedAccounts,7);
  assert.equal(r.currentAccounts,status==='stale'?1:0);assert.equal(r.status,'provisional');
 }
});
