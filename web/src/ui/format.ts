const number = new Intl.NumberFormat('ko-KR', {maximumFractionDigits:1});
const count = new Intl.NumberFormat('ko-KR', {maximumFractionDigits:0});
const money = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD', maximumFractionDigits:2});
const smallMoney = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD', maximumFractionDigits:6});
const clock = new Intl.DateTimeFormat('ko-KR', {hour:'2-digit', minute:'2-digit'});
const date = new Intl.DateTimeFormat('ko-KR', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
const percent = new Intl.NumberFormat('ko-KR', {maximumFractionDigits:1});
// 쿼타 비율 전용. 두 자리까지 열되 minimumFractionDigits 는 두지 않는다 — 정수만 보고한
// 제공사의 28 을 28.00 으로 적으면 우리가 재지 않은 정밀도를 주장하게 된다.
const quota = new Intl.NumberFormat('ko-KR', {maximumFractionDigits:2});
import type { PeriodDef } from './types.js';

const STATES: Record<string, string> = {stale:'갱신 필요', reauth:'로그인 확인 필요', paused:'일시 중지', unavailable:'쿼타 조회 불가'};
// 사용 집계 기간. 마지막으로 사용 기록을 읽은 시각에서 거꾸로 센 구간이며 제공자가
// 리셋하는 한도 주기가 아니다. 24시간은 달력 하루가 아니므로 라벨에 '1일'을 쓰지 않는다.
const PERIODS: PeriodDef[] = [
  {key:'oneHour', label:'최근 1시간', short:'1시간'},
  {key:'fiveHour', label:'최근 5시간', short:'5시간'},
  {key:'twentyFourHour', label:'최근 24시간', short:'24시간'},
  {key:'weekly', label:'최근 7일', short:'7일'},
  {key:'monthly', label:'최근 30일', short:'30일'},
];

export {number, count, money, smallMoney, clock, date, percent, STATES, PERIODS};

export function periodLabel(key: string): string {
  return PERIODS.find(period => period.key === key)?.label ?? '선택한 기간';
}

export function age(value: string | null | undefined): string {
  if (!value || !finite(Date.parse(value))) return '측정 시각 없음';
  if (Date.parse(value) > Date.now() + 60000) return '측정 시각 확인 필요';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return seconds < 60 ? `${seconds}초 전 측정` : minutes < 60 ? `${minutes}분 전 측정` : `${Math.floor(minutes / 60)}시간 전 측정`;
}
export function reset(value: string | null | undefined): string {
  if (!value || !finite(Date.parse(value))) return '리셋 미제공';
  const ms = Date.parse(value) - Date.now();
  if (ms <= 0) return '리셋 후 새 측정 대기';
  const h = Math.floor(ms / 3600000);
  return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 후 리셋` : h > 0 ? `${h}시간 ${Math.floor(ms / 60000) % 60}분 후 리셋` : `${Math.max(1, Math.floor(ms / 60000))}분 후 리셋`;
}
export function until(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return '이미 소진';
  const h = Math.floor(ms / 3600000);
  return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 후` : h > 0 ? `${h}시간 ${Math.floor(ms / 60000) % 60}분 후` : `${Math.max(1, Math.floor(ms / 60000))}분 후`;
}
export function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
// 단가 한 칸. null 은 미확인이고 0 은 확인된 무료다. 둘을 같은 글자로 쓰면 화면이 모르는
// 값을 0원이라고 말하게 되므로, 여기서 갈라 둔다.
export function unitPrice(value: unknown): string {
  if (!finite(value)) return '미확인';
  // 0 이 아닌 아주 작은 단가도 0 으로 적으면 안 된다. 여섯 자리 아래로 내려가는 값에는
  // usd() 가 금액에 쓰는 표기를 그대로 빌린다.
  if (value > 0 && value < .000001) return '< $0.000001';
  return value === 0 ? '$0.00' : smallMoney.format(value);
}
export function usd(value: unknown): string {
  if (!finite(value)) return '—';
  if (value > 0 && value < .000001) return '< $0.000001';
  return value > 0 && value < .01 ? smallMoney.format(value) : money.format(value);
}
export function windowLabel(w: {label: string}): string {
  const labels: Record<string, string> = {'First-party models':'자체 모델', 'API usage':'API 사용'};
  return labels[w.label] || w.label;
}
// 쿼타 숫자 한 칸. 점유율이든 %p 변화량이든 규칙이 같아서 함수도 하나다.
//
// 0.004 를 두 자리에서 반올림하면 0 이 되어 실제로 측정된 0 과 구별되지 않는다. 금액에서
// unitPrice/usd 가 쓰는 표기를 그대로 빌려 미소값을 따로 말하고, 부호가 뜻을 갖는 %p 를 위해
// 음수 쪽도 같이 다룬다. 그렇게 하지 않으면 -0.004 가 '-0' 으로 나온다.
export function quotaFigure(value: unknown): string {
  if (!finite(value)) return '미확인';
  // 측정된 0 은 0 이다. 음의 0 을 그대로 넘기면 '-0' 이 나온다.
  if (value === 0) return '0';
  if (value > 0 && value < .01) return '<0.01';
  if (value < 0 && value > -.01) return '>-0.01';
  const text = quota.format(value);
  // 100 언저리는 양쪽 다 조심한다. 100.001 이 '100' 이 되면 넘겼다는 사실이 사라지고,
  // 99.999 가 '100' 이 되면 아직 남았는데 다 썼다고 말하게 된다. 창의 막대는 100 에서
  // 잘리지만 근거는 잘리지 않는다.
  if (text === '100' && value !== 100) return value > 100 ? '>100' : '<100';
  return text;
}
