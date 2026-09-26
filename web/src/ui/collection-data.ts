import {asRecord} from './types.js';

export const RESULTS: Readonly<Record<string, string>> = {
  ok:'성공', rate_limited:'429 제한', unauthorized:'인증 실패', access_denied:'접근 거부',
  server_error:'서버 오류', unexpected_status:'예상 밖 응답', network:'네트워크 오류',
  timeout:'시간 초과', redirect:'리디렉션 거부', oversized:'응답 크기 초과',
  credential_echoed:'응답 검증 실패', base_url_mismatch:'계정 불일치',
  invalid_json:'응답 해석 실패', observation_unavailable:'측정 불가',
};
export type LogRow = {
  readonly id:number; readonly startedAt:number; readonly provider:string; readonly account:string;
  readonly endpoint:string; readonly result:string; readonly httpStatus:number|null;
  readonly durationMs:number; readonly retryAfterMs:number|null; readonly nextAttemptAt:number; readonly failures:number;
};
export type LogSummary = {readonly provider:string; readonly attempts:number; readonly successes:number;
  readonly rateLimited:number; readonly successRate:number|null; readonly rateLimitRate:number|null; readonly lastSuccessAt:number|null};
export type LogPage = {readonly rows:readonly LogRow[]; readonly summary:readonly LogSummary[];
  readonly providers:readonly string[]; readonly accounts:readonly {provider:string;account:string}[];
  readonly nextBefore:number|null; readonly retentionDays:number; readonly from:number; readonly to:number; readonly period:string};

function record(value:unknown):Record<string,unknown> {
  const row=asRecord(value); if (!row) throw new Error('Invalid collection response'); return row;
}
function text(value:unknown):string {
  if (typeof value!=='string') throw new Error('Invalid collection text'); return value;
}
function number(value:unknown):number {
  if (typeof value!=='number'||!Number.isFinite(value)) throw new Error('Invalid collection number'); return value;
}
function nullable(value:unknown):number|null { return value===null?null:number(value); }
function list(value:unknown):unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid collection list'); return value;
}
export function parseLogPage(value:unknown):LogPage {
  const p=record(value);
  return {period:text(p.period),from:number(p.from),to:number(p.to),retentionDays:number(p.retentionDays),nextBefore:nullable(p.nextBefore),
    providers:list(p.providers).map(text),accounts:list(p.accounts).map(v=>{const a=record(v);return {provider:text(a.provider),account:text(a.account)};}),
    rows:list(p.rows).map(v=>{const r=record(v);const result=text(r.result);if(!Object.hasOwn(RESULTS,result))throw new Error('Invalid collection result');return {
      id:number(r.id),startedAt:number(r.startedAt),provider:text(r.provider),account:text(r.account),endpoint:text(r.endpoint),result,
      httpStatus:nullable(r.httpStatus),durationMs:number(r.durationMs),retryAfterMs:nullable(r.retryAfterMs),nextAttemptAt:number(r.nextAttemptAt),failures:number(r.failures)};}),
    summary:list(p.summary).map(v=>{const s=record(v);return {provider:text(s.provider),attempts:number(s.attempts),successes:number(s.successes),rateLimited:number(s.rateLimited),successRate:nullable(s.successRate),rateLimitRate:nullable(s.rateLimitRate),lastSuccessAt:nullable(s.lastSuccessAt)};}),
  };
}
