/**
 * Asia/Seoul 표시 도우미 (서버·화면 공용, 의존성 없음).
 * 한국은 서머타임이 없으므로 UTC+9 고정 오프셋으로 계산한다.
 */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function toDate(v: string | Date): Date {
  return typeof v === 'string' ? new Date(v) : v;
}

/** KST 기준 달력 성분 */
export function kstParts(v: string | Date) {
  const d = new Date(toDate(v).getTime() + KST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: WEEKDAYS[d.getUTCDay()],
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' (KST) */
export function kstDateString(v: string | Date): string {
  const p = kstParts(v);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** KST 날짜 'YYYY-MM-DD' 의 00:00 KST 시각 (UTC Date) */
export function kstStartOfDay(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - KST_OFFSET_MS);
}

/** 'YYYY-MM-DD' 에 days 일 더하기 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 두 KST 날짜 문자열의 일수 차 (b - a) */
export function diffDays(a: string, b: string): number {
  return Math.round((kstStartOfDay(b).getTime() - kstStartOfDay(a).getTime()) / 86400000);
}

/** '11월 25일 (화)' */
export function formatKstDate(v: string | Date): string {
  const p = kstParts(v);
  return `${p.month}월 ${p.day}일 (${p.weekday})`;
}

/** '11/25(화)' */
export function formatKstShortDate(v: string | Date): string {
  const p = kstParts(v);
  return `${p.month}/${p.day}(${p.weekday})`;
}

/** '11월 25일 (화) 14시 05분' */
export function formatKstDateTime(v: string | Date): string {
  const p = kstParts(v);
  return `${formatKstDate(v)} ${p.hour}시 ${pad(p.minute)}분`;
}

/** '11/25(화) 14:05' */
export function formatKstShortDateTime(v: string | Date): string {
  const p = kstParts(v);
  return `${formatKstShortDate(v)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** 소요 시간 '2분 1초' / '6초' */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}시간 ${m}분 ${s}초`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}
