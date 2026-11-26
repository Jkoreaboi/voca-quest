/**
 * 단어·뜻 정규화. 보기 충돌(복수 정답) 판정과 중복 판정의 기준이 된다.
 */

/** 표시용 정리: 앞뒤 공백 제거, 연속 공백 1칸, 전각 물결/따옴표 통일 */
export function cleanDisplay(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/[ 　]/g, ' ')
    .replace(/[～〜]/g, '~')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bcan't\b/g, 'can not'],
  [/\bcannot\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\bshan't\b/g, 'shall not'],
  [/\b(\w+)n't\b/g, '$1 not'],
  [/\bi'm\b/g, 'i am'],
  [/\b(\w+)'re\b/g, '$1 are'],
  [/\b(\w+)'ve\b/g, '$1 have'],
  [/\b(\w+)'ll\b/g, '$1 will'],
  [/\b(\w+)'d\b/g, '$1 would'],
  [/\b(it|that|what|there|here|who|he|she|let)'s\b/g, '$1 is'],
];

/**
 * 영어 비교 키: 소문자, 축약형 풀기, 구두점·물결 제거, 공백 정리.
 * 'I'm sorry to hear that.' 와 'I am sorry to hear that' 는 같은 키가 된다.
 */
export function englishKey(s: string): string {
  let t = cleanDisplay(s).toLowerCase();
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  t = t
    .replace(/[~?!.,;:"()\[\]]/g, ' ')
    .replace(/\s*\+\s*/g, ' + ')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

/** 오답노트 묶음·중복 출제 방지 키 (영어 기준) */
export const wordKey = englishKey;

/** 뜻 한 조각 정규화: 괄호 설명 제거, 물결·공백·문장부호 제거 */
export function senseKey(s: string): string {
  return cleanDisplay(s)
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[~?!.,;:'"·…\s]/g, '')
    .trim();
}

/**
 * 뜻 문자열 → 뜻 조각 키 배열. 쉼표·세미콜론으로 나눈다.
 * '/' 는 '~에 흥미가/관심이 있다' 처럼 조각 내부에서 쓰이므로 나누지 않는다.
 */
export function senseKeys(meaning: string): string[] {
  const parts = cleanDisplay(meaning)
    // 괄호 안 쉼표로 잘못 나뉘지 않도록 괄호 구간을 먼저 보호
    .replace(/\([^)]*\)/g, (m) => m.replace(/[,;]/g, ' '))
    .split(/[,;]/);
  const keys = parts.map(senseKey).filter((k) => k.length > 0);
  return Array.from(new Set(keys));
}

/** 문항 유형: 단일 단어 / 구 / 문장(회화 표현) */
export function detectKind(english: string): 'word' | 'phrase' | 'sentence' {
  const t = cleanDisplay(english);
  if (/[?!.]$/.test(t)) return 'sentence';
  const tokens = t.split(' ').filter(Boolean);
  if (tokens.length === 1) return 'word';
  // 대문자로 시작하는 3어절 이상 회화 표현 (예: 'Make sure (that) you don't')
  if (/^(I|I'm|You|We|Do|Don't|Can|What|How|Why|Which|Who|Is|Are|Thank|Let|It|That|There)\b/.test(t) && tokens.length >= 3) {
    return 'sentence';
  }
  return 'phrase';
}

/** 이름 비교 키: 공백 제거 + 소문자 (한글은 그대로) */
export function nameKey(name: string): string {
  return cleanDisplay(name).replace(/\s+/g, '').toLowerCase();
}

// ───────── 유사도 ─────────

/** 레벤슈타인 거리 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 철자 유사도 0..1 (1 = 같음) */
export function spellingSimilarity(a: string, b: string): number {
  const x = englishKey(a).replace(/[^a-z ]/g, '');
  const y = englishKey(b).replace(/[^a-z ]/g, '');
  if (!x || !y) return 0;
  const d = levenshtein(x, y);
  return 1 - d / Math.max(x.length, y.length);
}

/** 가장 긴 공통 부분 문자열의 길이 */
export function lcsLength(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 한국어 문자 bigram Dice 계수 0..1 */
export function koreanDice(a: string, b: string): number {
  const grams = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.length || !gb.length) return a === b ? 1 : 0;
  const pool = new Map<string, number>();
  for (const g of gb) pool.set(g, (pool.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of ga) {
    const c = pool.get(g) ?? 0;
    if (c > 0) {
      common++;
      pool.set(g, c - 1);
    }
  }
  return (2 * common) / (ga.length + gb.length);
}

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'and', 'or', 'be', 'is', 'am', 'are',
  'you', 'i', 'me', 'my', 'it', 'that', 'this', 'do', 'not', 'can', 'will', 'would', 'have', 'has', 'what',
  'how', 'about', 'your', 'we', 'one', 'from', 'up', 'out', 'so', 'if', 'as', 'there', 'p', 'pp', 'a', 'b',
]);

/** 영어 내용어 토큰 (4글자 이상, 불용어 제외) */
export function contentTokens(english: string): string[] {
  return englishKey(english)
    .replace(/[^a-z ]/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 4 && !STOP.has(t));
}
