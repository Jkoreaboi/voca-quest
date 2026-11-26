/**
 * 시험(링크) 설정, 퀘스트 기간, 범위 미리보기, 출제 점검.
 */
import type { ExamPublic, PreviewResponse, QuestPeriod, UnitInfo } from '../shared/api';
import { addDays, diffDays, formatKstShortDate, kstDateString, kstStartOfDay } from '../shared/time';
import type { Queryable } from './db';
import { AppError, nowOf, newSlug, type Ctx } from './context';

export interface ExamRow {
  id: number;
  slug: string;
  wordbook_id: number;
  school: string;
  grade: string;
  textbook: string;
  title: string;
  unit_from: number;
  unit_to: number;
  question_count: number;
  time_limit_ms: number;
  pass_percent: number;
  quest_starts_at: Date | null;
  quest_ends_at: Date | null;
  is_sample: boolean;
  is_active: boolean;
}

export async function getExamBySlug(q: Queryable, slug: string, opts: { allowInactive?: boolean } = {}): Promise<ExamRow> {
  if (!/^[a-z0-9-]{3,64}$/.test(slug)) throw new AppError('NOT_FOUND', 404, '시험 링크를 찾을 수 없어요. 선생님께 받은 링크를 다시 확인해 주세요.');
  const r = await q.query<ExamRow>('SELECT * FROM exams WHERE slug = $1', [slug]);
  const e = r.rows[0];
  if (!e) throw new AppError('NOT_FOUND', 404, '시험 링크를 찾을 수 없어요. 선생님께 받은 링크를 다시 확인해 주세요.');
  if (!e.is_active && !opts.allowInactive) throw new AppError('EXAM_INACTIVE', 410, '지금은 응시할 수 없는 시험이에요. 선생님께 문의해 주세요.');
  return e;
}

export function displayTitle(e: Pick<ExamRow, 'school' | 'grade' | 'textbook' | 'title'>) {
  return `${e.school} ${e.grade} ${examLabel(e)}`;
}
export function examLabel(e: Pick<ExamRow, 'textbook' | 'title'>) {
  return e.title ? `${e.textbook} (${e.title})` : e.textbook;
}

export function questPeriod(e: Pick<ExamRow, 'quest_starts_at' | 'quest_ends_at'>, now: Date): QuestPeriod {
  const s = e.quest_starts_at;
  const en = e.quest_ends_at;
  if (!s || !en) {
    return { startsAt: null, endsAt: null, startDate: null, endDate: null, status: 'not_configured', dDay: null };
  }
  const endDate = kstDateString(new Date(en.getTime() - 1));
  const status = now < s ? 'upcoming' : now >= en ? 'ended' : 'active';
  return {
    startsAt: s.toISOString(),
    endsAt: en.toISOString(),
    startDate: kstDateString(s),
    endDate,
    status,
    dDay: status === 'ended' ? null : diffDays(kstDateString(now), endDate),
  };
}

export function periodText(p: QuestPeriod): string {
  if (!p.startsAt || !p.endDate) return '';
  return `${formatKstShortDate(p.startsAt)} ~ ${formatKstShortDate(kstStartOfDay(p.endDate))}`;
}

export async function examUnits(q: Queryable, e: ExamRow): Promise<UnitInfo[]> {
  const r = await q.query<{ ordinal: number; code: string; label: string; word_count: number; usable_count: number }>(
    `SELECT u.ordinal, u.code, u.label,
            count(w.id) FILTER (WHERE w.status <> 'retired')::int AS word_count,
            count(w.id) FILTER (WHERE w.status = 'active' AND (w.check_en2ko IS NULL OR w.check_ko2en IS NULL))::int AS usable_count
       FROM units u LEFT JOIN words w ON w.unit_id = u.id
      WHERE u.wordbook_id = $1 AND u.ordinal BETWEEN $2 AND $3
      GROUP BY u.id ORDER BY u.ordinal`,
    [e.wordbook_id, e.unit_from, e.unit_to],
  );
  return r.rows.map((u) => ({ ordinal: u.ordinal, code: u.code, label: u.label, wordCount: u.word_count, usableCount: u.usable_count }));
}

export async function examPublic(ctx: Ctx, q: Queryable, e: ExamRow): Promise<ExamPublic> {
  const now = nowOf(ctx);
  const units = await examUnits(q, e);
  return {
    slug: e.slug,
    school: e.school,
    grade: e.grade,
    textbook: e.textbook,
    title: e.title,
    displayTitle: displayTitle(e),
    examLabel: examLabel(e),
    isSample: e.is_sample,
    units,
    totalWords: units.reduce((a, u) => a + u.wordCount, 0),
    questionCount: e.question_count,
    timeLimitSec: Math.round(e.time_limit_ms / 1000),
    passPercent: e.pass_percent,
    quest: questPeriod(e, now),
    serverNow: now.toISOString(),
  };
}

/** 범위 검증 → 라벨 반환 */
export async function validateRange(q: Queryable, e: ExamRow, from: unknown, to: unknown) {
  const f = Number(from);
  const t = Number(to);
  if (!Number.isInteger(f) || !Number.isInteger(t)) throw new AppError('INVALID_RANGE', 400, '시작 Unit과 끝 Unit을 골라 주세요.');
  if (f > t) throw new AppError('INVALID_RANGE', 400, '시작 Unit이 끝 Unit보다 뒤에 있어요. 범위를 다시 골라 주세요.');
  if (f < e.unit_from || t > e.unit_to) throw new AppError('INVALID_RANGE', 400, '이 시험에서 고를 수 없는 Unit이 포함되어 있어요.');
  const r = await q.query<{ ordinal: number; label: string }>(
    'SELECT ordinal, label FROM units WHERE wordbook_id = $1 AND ordinal IN ($2, $3)',
    [e.wordbook_id, f, t],
  );
  const lf = r.rows.find((x) => x.ordinal === f);
  const lt = r.rows.find((x) => x.ordinal === t);
  if (!lf || !lt) throw new AppError('INVALID_RANGE', 400, '이 시험에서 고를 수 없는 Unit이 포함되어 있어요.');
  return { from: f, to: t, fromLabel: lf.label, toLabel: lt.label };
}

export async function preview(ctx: Ctx, slug: string, from: unknown, to: unknown): Promise<PreviewResponse> {
  const q = ctx.db;
  const e = await getExamBySlug(q, slug);
  const range = await validateRange(q, e, from, to);
  const r = await q.query<{ word_count: number; usable_count: number }>(
    `SELECT count(DISTINCT w.english_norm) FILTER (WHERE w.status <> 'retired')::int AS word_count,
            count(DISTINCT w.english_norm) FILTER (WHERE w.status = 'active' AND (w.check_en2ko IS NULL OR w.check_ko2en IS NULL))::int AS usable_count
       FROM words w JOIN units u ON u.id = w.unit_id
      WHERE u.wordbook_id = $1 AND u.ordinal BETWEEN $2 AND $3`,
    [e.wordbook_id, range.from, range.to],
  );
  const { word_count, usable_count } = r.rows[0];
  const questionCount = Math.min(e.question_count, usable_count);
  let message: string | null = null;
  if (usable_count === 0) message = '이 범위에는 출제할 수 있는 단어가 없어요. 다른 범위를 고르거나 선생님께 알려 주세요.';
  else if (usable_count < e.question_count) message = `출제할 수 있는 단어가 ${usable_count}개라 ${questionCount}문항으로 진행돼요.`;
  return {
    unitFrom: range.from,
    unitTo: range.to,
    unitFromLabel: range.fromLabel,
    unitToLabel: range.toLabel,
    wordCount: word_count,
    usableCount: usable_count,
    questionCount,
    targetQuestionCount: e.question_count,
    canStart: usable_count > 0,
    message,
  };
}

// ───────── 관리자 ─────────

export interface ExamInput {
  wordbook?: string; // wordbook code
  school?: string;
  grade?: string;
  textbook?: string;
  title?: string;
  unitFrom?: number;
  unitTo?: number;
  questionCount?: number;
  questStart?: string | null; // 'YYYY-MM-DD'(KST, 포함) 또는 ISO 시각
  questEnd?: string | null; // 'YYYY-MM-DD'(KST, 그날 끝까지) 또는 ISO 시각(제외)
  isSample?: boolean;
  isActive?: boolean;
  slug?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseQuestStart(v: string | null | undefined): Date | null {
  if (v == null || v === '') return null;
  if (DATE_RE.test(v)) return kstStartOfDay(v);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError('BAD_REQUEST', 400, `퀘스트 시작일 형식 오류: ${v}`);
  return d;
}

/** 날짜만 주면 그날 끝까지 유효 → 다음날 00:00 KST (제외) */
export function parseQuestEnd(v: string | null | undefined): Date | null {
  if (v == null || v === '') return null;
  if (DATE_RE.test(v)) return kstStartOfDay(addDays(v, 1));
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError('BAD_REQUEST', 400, `퀘스트 마감일 형식 오류: ${v}`);
  return d;
}

function req(v: string | undefined, name: string): string {
  const s = (v ?? '').trim();
  if (!s) throw new AppError('BAD_REQUEST', 400, `${name} 값이 필요합니다.`);
  return s;
}

export async function createExam(ctx: Ctx, input: ExamInput): Promise<ExamRow> {
  const q = ctx.db;
  const wb = (await q.query<{ id: number }>('SELECT id FROM wordbooks WHERE code = $1', [req(input.wordbook, 'wordbook')])).rows[0];
  if (!wb) throw new AppError('NOT_FOUND', 404, `단어장 ${input.wordbook} 이 없습니다. 먼저 임포트하세요.`);
  const units = await q.query<{ min: number; max: number }>('SELECT min(ordinal)::int AS min, max(ordinal)::int AS max FROM units WHERE wordbook_id = $1 AND ordinal > 0', [wb.id]);
  const from = input.unitFrom ?? units.rows[0].min;
  const to = input.unitTo ?? units.rows[0].max;
  if (!(from >= units.rows[0].min && to <= units.rows[0].max && from <= to)) {
    throw new AppError('INVALID_RANGE', 400, `허용 Unit 범위가 잘못되었습니다 (단어장 Unit ${units.rows[0].min}~${units.rows[0].max}).`);
  }
  const starts = parseQuestStart(input.questStart);
  const ends = parseQuestEnd(input.questEnd);
  if ((starts && !ends) || (!starts && ends)) throw new AppError('BAD_REQUEST', 400, '퀘스트 시작일과 마감일은 함께 지정해야 합니다.');
  if (starts && ends && starts >= ends) throw new AppError('BAD_REQUEST', 400, '퀘스트 마감일이 시작일보다 빠릅니다.');
  const slug = input.slug ?? newSlug();
  const r = await q.query<ExamRow>(
    `INSERT INTO exams (slug, wordbook_id, school, grade, textbook, title, unit_from, unit_to, question_count, quest_starts_at, quest_ends_at, is_sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [slug, wb.id, req(input.school, 'school'), req(input.grade, 'grade'), req(input.textbook, 'textbook'), (input.title ?? '').trim(), from, to, input.questionCount ?? 20, starts, ends, !!input.isSample],
  );
  return r.rows[0];
}

export async function updateExam(ctx: Ctx, slug: string, input: ExamInput): Promise<ExamRow> {
  const q = ctx.db;
  const e = await getExamBySlug(q, slug, { allowInactive: true });
  const next = {
    school: input.school ?? e.school,
    grade: input.grade ?? e.grade,
    textbook: input.textbook ?? e.textbook,
    title: input.title ?? e.title,
    unit_from: input.unitFrom ?? e.unit_from,
    unit_to: input.unitTo ?? e.unit_to,
    question_count: input.questionCount ?? e.question_count,
    quest_starts_at: input.questStart !== undefined ? parseQuestStart(input.questStart) : e.quest_starts_at,
    quest_ends_at: input.questEnd !== undefined ? parseQuestEnd(input.questEnd) : e.quest_ends_at,
    is_sample: input.isSample ?? e.is_sample,
    is_active: input.isActive ?? e.is_active,
  };
  if (next.unit_from > next.unit_to) throw new AppError('INVALID_RANGE', 400, '허용 Unit 범위가 잘못되었습니다.');
  const r = await q.query<ExamRow>(
    `UPDATE exams SET school=$2, grade=$3, textbook=$4, title=$5, unit_from=$6, unit_to=$7, question_count=$8,
       quest_starts_at=$9, quest_ends_at=$10, is_sample=$11, is_active=$12, updated_at=now() WHERE id=$1 RETURNING *`,
    [e.id, next.school, next.grade, next.textbook, next.title, next.unit_from, next.unit_to, next.question_count, next.quest_starts_at, next.quest_ends_at, next.is_sample, next.is_active],
  );
  return r.rows[0];
}

export function studentUrl(slug: string): string {
  const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/t/${slug}`;
}

export async function listExams(ctx: Ctx) {
  const now = nowOf(ctx);
  const r = await ctx.db.query<ExamRow & { wordbook_code: string }>(
    'SELECT e.*, w.code AS wordbook_code FROM exams e JOIN wordbooks w ON w.id = e.wordbook_id ORDER BY e.id',
  );
  return r.rows.map((e) => ({
    slug: e.slug,
    url: studentUrl(e.slug),
    displayTitle: displayTitle(e),
    wordbook: e.wordbook_code,
    units: `${e.unit_from}~${e.unit_to}`,
    questionCount: e.question_count,
    quest: questPeriod(e, now),
    isSample: e.is_sample,
    isActive: e.is_active,
  }));
}

/** 출제 점검: Unit별 출제 가능 수와 제외 단어·사유 */
export async function checkExam(ctx: Ctx, slug: string) {
  const e = await getExamBySlug(ctx.db, slug, { allowInactive: true });
  const r = await ctx.db.query<{ ordinal: number; label: string; english: string; meaning: string; status: string; status_reason: string | null; check_en2ko: string | null; check_ko2en: string | null; source_sheet: string; source_cell: string }>(
    `SELECT u.ordinal, u.label, w.english, w.meaning, w.status, w.status_reason, w.check_en2ko, w.check_ko2en, w.source_sheet, w.source_cell
       FROM words w JOIN units u ON u.id = w.unit_id
      WHERE u.wordbook_id = $1 AND u.ordinal BETWEEN $2 AND $3 ORDER BY u.ordinal, w.item_no`,
    [e.wordbook_id, e.unit_from, e.unit_to],
  );
  const units = new Map<number, { ordinal: number; label: string; words: number; usable: number; en2koOnly: number; ko2enOnly: number; excluded: Array<{ english: string; meaning: string; where: string; reason: string }> }>();
  for (const w of r.rows) {
    if (!units.has(w.ordinal)) units.set(w.ordinal, { ordinal: w.ordinal, label: w.label, words: 0, usable: 0, en2koOnly: 0, ko2enOnly: 0, excluded: [] });
    const u = units.get(w.ordinal)!;
    if (w.status === 'retired') continue;
    u.words++;
    const where = `${w.source_sheet} ${w.source_cell}`;
    if (w.status !== 'active') {
      u.excluded.push({ english: w.english, meaning: w.meaning, where, reason: w.status_reason ?? w.status });
    } else if (w.check_en2ko && w.check_ko2en) {
      u.excluded.push({ english: w.english, meaning: w.meaning, where, reason: `영→한: ${w.check_en2ko} / 한→영: ${w.check_ko2en}` });
    } else {
      u.usable++;
      if (w.check_ko2en) u.en2koOnly++;
      if (w.check_en2ko) u.ko2enOnly++;
    }
  }
  return { slug: e.slug, displayTitle: displayTitle(e), units: Array.from(units.values()) };
}

export { periodText as questPeriodText };
