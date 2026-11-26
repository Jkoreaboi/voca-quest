/**
 * 4지선다 보기 생성기.
 * 원칙: 정답은 정확히 하나. 같은 표기(대소문자·공백·축약형 차이 포함), 같은/겹치는 뜻,
 * 문항에서 복수 정답이 될 수 있는 보기는 제외한다. 신뢰할 수 있는 오답 3개를 못 만들면 문항 제외.
 *
 * 우선순위: (1) 원본 제공 혼동어 → (2) 같은 유형(단어/구/문장)·품사 → (3) 철자(한→영) 또는 뜻 길이(영→한)가
 * 비슷한 후보 → (4) 시험 범위 안 단어. 그 안에서 무작위성을 섞어 회차마다 보기가 달라진다.
 */
import type { Direction } from '../shared/api';
import { contentTokens, englishKey, koreanDice, lcsLength, spellingSimilarity } from './normalize';

export interface WordRec {
  id: number;
  unitOrdinal: number;
  unitLabel: string;
  itemNo: number;
  english: string;
  englishKey: string;
  pos: string | null;
  meaning: string;
  senses: string[];
  kind: 'word' | 'phrase' | 'sentence';
  confusables: string[]; // 원본 제공 혼동어 (영어 표기)
  conflicts?: string[]; // 동의·유사 그룹(설정)으로 함께 보기로 내면 안 되는 영어 키
}

export type Rng = () => number;

export interface BuiltQuestion {
  direction: Direction;
  prompt: string;
  options: string[];
  optionWordIds: number[];
  correctIndex: number;
}

export type BuildResult = { ok: true; q: BuiltQuestion } | { ok: false; reason: string };

/** 두 뜻 조각 키가 같은 뜻으로 볼 만큼 겹치는가 (보수적으로 판정) */
export function senseConflict(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 2 && l.includes(s) && s.length / l.length >= 0.5) return true;
  if (Math.min(a.length, b.length) >= 3 && koreanDice(a, b) >= 0.8) return true;
  // '나는~을확신한다' vs '나는~라는것을확신한다' 처럼 핵심 부분(4글자 이상)이 길게 겹치면 같은 뜻으로 본다
  const common = lcsLength(a, b);
  if (common >= 4 && common / s.length >= 0.6) return true;
  return false;
}

export function sensesConflict(as: Iterable<string>, bs: Iterable<string>): boolean {
  const bl = Array.from(bs);
  for (const a of as) for (const b of bl) if (senseConflict(a, b)) return true;
  return false;
}

function maxDice(as: string[], bs: string[]): number {
  let m = 0;
  for (const a of as) for (const b of bs) m = Math.max(m, koreanDice(a, b));
  return m;
}

export class OptionBuilder {
  private sensesByKey = new Map<string, Set<string>>();
  private byKey = new Map<string, WordRec[]>();

  constructor(private readonly pool: WordRec[]) {
    for (const w of pool) {
      if (!this.sensesByKey.has(w.englishKey)) this.sensesByKey.set(w.englishKey, new Set());
      for (const s of w.senses) this.sensesByKey.get(w.englishKey)!.add(s);
      if (!this.byKey.has(w.englishKey)) this.byKey.set(w.englishKey, []);
      this.byKey.get(w.englishKey)!.push(w);
    }
  }

  /** 같은 영어 표기를 가진 모든 행의 뜻 조각 (책 전체 기준) */
  allSensesOf(key: string): string[] {
    return Array.from(this.sensesByKey.get(key) ?? []);
  }

  /** target 에 대해 오답 보기로 써도 안전한가. 안전하지 않으면 사유 문자열 */
  rejectReason(target: WordRec, cand: WordRec, direction: Direction): string | null {
    if (cand.id === target.id) return 'self';
    if (cand.englishKey === target.englishKey) return 'same_english';
    // 설정 파일의 동의·유사 그룹 (교사 검토 가능)
    if (target.conflicts?.includes(cand.englishKey) || cand.conflicts?.includes(target.englishKey)) return 'synonym_group';
    if (direction === 'en2ko') {
      // 보기(뜻)가 제시 영단어의 (책 전체) 뜻과 겹치면 복수 정답
      if (sensesConflict(cand.senses, this.allSensesOf(target.englishKey))) return 'meaning_overlap';
      if (sensesConflict(cand.senses, target.senses)) return 'meaning_overlap';
    } else {
      // 보기(영어)의 책 전체 뜻이 제시된 뜻과 겹치면 복수 정답
      const candSenses = this.allSensesOf(cand.englishKey);
      if (sensesConflict(candSenses, target.senses)) return 'meaning_overlap';
      // 'You'd better' vs 'had better' 처럼 핵심어를 공유하고 뜻도 비슷한 표현
      const shared = contentTokens(cand.english).some((t) => contentTokens(target.english).includes(t));
      if (shared && maxDice(candSenses, target.senses) >= 0.35) return 'near_synonym';
    }
    return null;
  }

  /** 서로 다른 오답끼리 겹치지 않는가 */
  private distinctFromChosen(cand: WordRec, chosen: WordRec[], direction: Direction): boolean {
    for (const c of chosen) {
      if (c.englishKey === cand.englishKey) return false;
      if (direction === 'en2ko') {
        if (c.meaning === cand.meaning) return false;
        if (sensesConflict(c.senses, cand.senses)) return false;
      } else if (englishKey(c.english) === englishKey(cand.english)) {
        return false;
      }
    }
    return true;
  }

  private score(target: WordRec, cand: WordRec, direction: Direction, inRange: Set<number> | null, rng: Rng): number {
    let s = 0;
    if (target.confusables.length) {
      const ck = target.confusables.map(englishKey);
      if (ck.includes(cand.englishKey)) s += 100;
    }
    if (cand.kind === target.kind) s += 30;
    if (target.pos && cand.pos && target.pos === cand.pos) s += 10;
    else if (!target.pos && !cand.pos) s += 5;
    if (direction === 'ko2en') {
      s += 40 * spellingSimilarity(target.english, cand.english);
      if (target.englishKey.slice(0, 3) === cand.englishKey.slice(0, 3)) s += 5;
      const lt = target.english.length;
      const lc = cand.english.length;
      s += 6 * (1 - Math.abs(lt - lc) / Math.max(lt, lc));
    } else {
      const lt = target.meaning.length;
      const lc = cand.meaning.length;
      s += 10 * (1 - Math.abs(lt - lc) / Math.max(lt, lc));
    }
    if (inRange?.has(cand.id)) s += 8;
    s += rng() * 12;
    return s;
  }

  /** 검증을 통과한 오답 후보 (무작위 없이) */
  validCandidates(target: WordRec, direction: Direction): WordRec[] {
    return this.pool.filter((c) => this.rejectReason(target, c, direction) === null);
  }

  build(target: WordRec, direction: Direction, rng: Rng, inRange: Set<number> | null = null): BuildResult {
    const prompt = direction === 'en2ko' ? target.english : target.meaning;
    if (!prompt.trim()) return { ok: false, reason: '제시어가 비어 있음' };
    if (direction === 'ko2en' && target.senses.length === 0) return { ok: false, reason: '뜻 정규화 결과가 비어 있음' };

    const valid = this.validCandidates(target, direction);
    const ranked = valid
      .map((c) => ({ c, s: this.score(target, c, direction, inRange, rng) }))
      .sort((a, b) => b.s - a.s);
    const chosen: WordRec[] = [];
    for (const { c } of ranked) {
      if (chosen.length === 3) break;
      if (this.distinctFromChosen(c, chosen, direction)) chosen.push(c);
    }
    if (chosen.length < 3) {
      return { ok: false, reason: `검증된 오답 보기 부족 (${chosen.length}/3)` };
    }
    const correctText = direction === 'en2ko' ? target.meaning : target.english;
    const items = [{ text: correctText, id: target.id }, ...chosen.map((c) => ({ text: direction === 'en2ko' ? c.meaning : c.english, id: c.id }))];
    // 표시 문자열 중복 최종 확인
    if (new Set(items.map((i) => (direction === 'en2ko' ? i.text : englishKey(i.text)))).size !== 4) {
      return { ok: false, reason: '보기 표기 중복' };
    }
    // Fisher–Yates
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return {
      ok: true,
      q: {
        direction,
        prompt,
        options: items.map((i) => i.text),
        optionWordIds: items.map((i) => i.id),
        correctIndex: items.findIndex((i) => i.id === target.id),
      },
    };
  }

  /** 출제 점검: 방향별 출제 가능 여부 (무작위 영향 없는 판정) */
  check(target: WordRec): { en2ko: string | null; ko2en: string | null } {
    const one = (d: Direction): string | null => {
      if (d === 'ko2en' && target.senses.length === 0) return '뜻 정규화 결과가 비어 있음';
      const valid = this.validCandidates(target, d);
      const chosen: WordRec[] = [];
      for (const c of valid) {
        if (chosen.length === 3) break;
        if (this.distinctFromChosen(c, chosen, d)) chosen.push(c);
      }
      return chosen.length < 3 ? `검증된 오답 보기 부족 (${chosen.length}/3)` : null;
    };
    return { en2ko: one('en2ko'), ko2en: one('ko2en') };
  }
}

// ───────── RNG ─────────

/** 테스트용 결정적 RNG */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 운영용 암호학적 RNG */
export function cryptoRng(): Rng {
  return () => {
    const b = new Uint32Array(1);
    globalThis.crypto.getRandomValues(b);
    return b[0] / 4294967296;
  };
}
