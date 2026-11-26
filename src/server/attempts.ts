/**
 * 시험 회차: 생성(문항·보기·정답 확정) → 문항 제시(서버 마감 시각) → 답안 확정 → 완료/그만하기 → 성적표.
 * 모든 변경은 회차 행 잠금(FOR UPDATE) 트랜잭션 안에서 이뤄져 연타·중복 탭·재시도·새로고침에도
 * 문항당 답안 1회, 회차당 결과 1회만 확정된다.
 */
import crypto from 'node:crypto';
import type {
  AnswerResponse,
  AnswerResult,
  AnswerReveal,
  AttemptMode,
  AttemptState,
  AttemptStatus,
  Direction,
  PracticeKind,
  QuestionView,
  ResultView,
  StartAttemptResponse,
  WrongItem,
} from '../shared/api';
import type { Queryable } from './db';
import { AppError, isUniqueViolation, nowOf, rngOf, type Ctx } from './context';
import { displayTitle, examLabel, getExamBySlug, validateRange, type ExamRow } from './exams';
import { deviceOwnsStudent, requireStudent } from './identity';
import { OptionBuilder, type Rng, type WordRec } from './options';
import { decideQuestCredit, questProgress, stepName } from './quest';

interface AttemptRow {
  id: string;
  exam_id: number;
  student_id: string;
  mode: AttemptMode;
  source_attempt_id: string | null;
  client_request_id: string;
  unit_from: number;
  unit_to: number;
  unit_from_label: string;
  unit_to_label: string;
  status: AttemptStatus;
  total_questions: number;
  answered_count: number;
  correct_count: number;
  time_limit_ms: number;
  pass_percent: number;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  passed: boolean | null;
  quest_step: number | null;
  quest_note: string | null;
  mission_seen_at: Date | null;
  snapshot: Snapshot;
}

interface Snapshot {
  school: string;
  grade: string;
  textbook: string;
  title: string;
  displayTitle: string;
  examLabel: string;
  studentName: string;
  examSlug: string;
}

interface QuestionRow {
  attempt_id: string;
  seq: number;
  word_id: number;
  word_key: string;
  direction: Direction;
  prompt: string;
  pos: string | null;
  options: string[];
  option_word_ids: number[];
  correct_index: number;
  english: string;
  meaning: string;
  unit_label: string;
  presented_at: Date | null;
  deadline_at: Date | null;
  answered_at: Date | null;
  chosen_index: number | null;
  result: AnswerResult | null;
}

const INSTRUCTION: Record<Direction, string> = {
  ko2en: '알맞은 영어 단어를 고르세요',
  en2ko: '알맞은 우리말 뜻을 고르세요',
};

function assertUuid(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('NOT_FOUND', 404, '시험 기록을 찾을 수 없어요.');
}

function assertClientRequestId(v: unknown): string {
  const s = String(v ?? '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(s)) throw new AppError('BAD_REQUEST', 400, '요청 식별자가 올바르지 않아요. 화면을 새로고침해 주세요.');
  return s;
}

// ───────── 단어 풀 ─────────

export async function loadPool(q: Queryable, wordbookId: number): Promise<Array<WordRec & { usable: boolean; canEn2ko: boolean; canKo2en: boolean }>> {
  const r = await q.query<{ id: number; ordinal: number; label: string; item_no: number; english: string; english_norm: string; pos: string | null; meaning: string; senses: string[]; kind: WordRec['kind']; confusables: string[]; conflicts: string[]; check_en2ko: string | null; check_ko2en: string | null }>(
    `SELECT w.id, u.ordinal, u.label, w.item_no, w.english, w.english_norm, w.pos, w.meaning, w.senses, w.kind, w.confusables, w.conflicts, w.check_en2ko, w.check_ko2en
       FROM words w JOIN units u ON u.id = w.unit_id
      WHERE w.wordbook_id = $1 AND w.status = 'active' AND u.ordinal > 0
      ORDER BY u.ordinal, w.item_no`,
    [wordbookId],
  );
  return r.rows.map((w) => ({
    id: w.id,
    unitOrdinal: w.ordinal,
    unitLabel: w.label,
    itemNo: w.item_no,
    english: w.english,
    englishKey: w.english_norm,
    pos: w.pos,
    meaning: w.meaning,
    senses: w.senses,
    kind: w.kind,
    confusables: w.confusables ?? [],
    conflicts: w.conflicts ?? [],
    canEn2ko: w.check_en2ko == null,
    canKo2en: w.check_ko2en == null,
    usable: w.check_en2ko == null || w.check_ko2en == null,
  }));
}

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface GeneratedQuestion {
  word: WordRec;
  direction: Direction;
  prompt: string;
  options: string[];
  optionWordIds: number[];
  correctIndex: number;
}

/** 범위 안 단어로 문항 생성. 같은 영단어는 한 회차에 한 번만. 한→영/영→한 섞기. */
export function generateQuestions(
  pool: Array<WordRec & { usable: boolean; canEn2ko: boolean; canKo2en: boolean }>,
  from: number,
  to: number,
  count: number,
  rng: Rng,
): { questions: GeneratedQuestion[]; skipped: Array<{ english: string; reason: string }> } {
  const builder = new OptionBuilder(pool);
  const inRange = pool.filter((w) => w.unitOrdinal >= from && w.unitOrdinal <= to);
  const inRangeIds = new Set(inRange.map((w) => w.id));
  const seen = new Set<string>();
  const unique = inRange.filter((w) => {
    if (!w.usable || seen.has(w.englishKey)) return false;
    seen.add(w.englishKey);
    return true;
  });
  const order = shuffle(unique, rng);
  const n = Math.min(count, order.length);
  const dirs: Direction[] = shuffle(
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 'ko2en' : 'en2ko') as Direction),
    rng,
  );
  const questions: GeneratedQuestion[] = [];
  const skipped: Array<{ english: string; reason: string }> = [];
  for (const w of order) {
    if (questions.length >= n) break;
    const want = dirs[questions.length];
    const tries: Direction[] = want === 'ko2en' ? ['ko2en', 'en2ko'] : ['en2ko', 'ko2en'];
    let done = false;
    const reasons: string[] = [];
    for (const d of tries) {
      if ((d === 'en2ko' && !w.canEn2ko) || (d === 'ko2en' && !w.canKo2en)) {
        reasons.push(`${d}: 출제 점검 제외`);
        continue;
      }
      const b = builder.build(w, d, rng, inRangeIds);
      if (b.ok) {
        questions.push({ word: w, ...b.q });
        done = true;
        break;
      }
      reasons.push(`${d}: ${b.reason}`);
    }
    if (!done) skipped.push({ english: w.english, reason: reasons.join(' / ') });
  }
  return { questions, skipped };
}

// ───────── 회차 생성 ─────────

async function insertAttempt(
  q: Queryable,
  a: Omit<AttemptRow, 'status' | 'answered_count' | 'correct_count' | 'finished_at' | 'duration_ms' | 'passed' | 'quest_step' | 'quest_note' | 'mission_seen_at'>,
  rows: Array<Omit<QuestionRow, 'attempt_id' | 'presented_at' | 'deadline_at' | 'answered_at' | 'chosen_index' | 'result'>>,
) {
  await q.query(
    `INSERT INTO attempts (id, exam_id, student_id, mode, source_attempt_id, client_request_id, unit_from, unit_to, unit_from_label, unit_to_label,
        total_questions, time_limit_ms, pass_percent, started_at, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
    [a.id, a.exam_id, a.student_id, a.mode, a.source_attempt_id, a.client_request_id, a.unit_from, a.unit_to, a.unit_from_label, a.unit_to_label, a.total_questions, a.time_limit_ms, a.pass_percent, a.started_at, JSON.stringify(a.snapshot)],
  );
  for (const r of rows) {
    await q.query(
      `INSERT INTO attempt_questions (attempt_id, seq, word_id, word_key, direction, prompt, pos, options, option_word_ids, correct_index, english, meaning, unit_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)`,
      [a.id, r.seq, r.word_id, r.word_key, r.direction, r.prompt, r.pos, JSON.stringify(r.options), JSON.stringify(r.option_word_ids), r.correct_index, r.english, r.meaning, r.unit_label],
    );
  }
}

/** 성적표 스냅샷: 학교는 학생이 입장할 때 입력한 학교, 시험명·학년은 시험 설정 */
function snapshotOf(exam: ExamRow, student: { display_name: string; school: string }): Snapshot {
  const studentName = student.display_name;
  return {
    school: student.school,
    grade: exam.grade,
    textbook: exam.textbook,
    title: exam.title,
    displayTitle: displayTitle(exam),
    examLabel: examLabel(exam),
    studentName,
    examSlug: exam.slug,
  };
}

export async function startAttempt(
  ctx: Ctx,
  slug: string,
  deviceToken: string | null,
  body: { unitFrom?: unknown; unitTo?: unknown; clientRequestId?: unknown },
): Promise<StartAttemptResponse> {
  const clientRequestId = assertClientRequestId(body.clientRequestId);
  const now = nowOf(ctx);
  const rng = rngOf(ctx);
  return ctx.db.tx(async (q) => {
    const exam = await getExamBySlug(q, slug);
    const student = await requireStudent(q, deviceToken, exam);
    await q.query('SELECT id FROM students WHERE id = $1 FOR UPDATE', [student.id]);
    const dup = await q.query<{ id: string; total_questions: number }>(
      'SELECT id, total_questions FROM attempts WHERE student_id = $1 AND client_request_id = $2',
      [student.id, clientRequestId],
    );
    if (dup.rows[0]) return { attemptId: dup.rows[0].id, totalQuestions: dup.rows[0].total_questions };
    const active = await q.query<{ id: string }>(
      `SELECT id FROM attempts WHERE student_id = $1 AND mode = 'regular' AND status = 'in_progress'`,
      [student.id],
    );
    if (active.rows[0]) {
      throw new AppError('ATTEMPT_IN_PROGRESS', 409, '아직 끝나지 않은 시험이 있어요. 이어 풀거나 그만한 뒤 새로 시작해 주세요.', { attemptId: active.rows[0].id });
    }
    const range = await validateRange(q, exam, body.unitFrom, body.unitTo);
    const pool = await loadPool(q, exam.wordbook_id);
    const { questions } = generateQuestions(pool, range.from, range.to, exam.question_count, rng);
    if (questions.length === 0) {
      throw new AppError('NO_VALID_QUESTIONS', 422, '이 범위에는 출제할 수 있는 단어가 없어요. 다른 범위를 고르거나 선생님께 알려 주세요.');
    }
    const id = crypto.randomUUID();
    await insertAttempt(
      q,
      {
        id,
        exam_id: exam.id,
        student_id: student.id,
        mode: 'regular',
        source_attempt_id: null,
        client_request_id: clientRequestId,
        unit_from: range.from,
        unit_to: range.to,
        unit_from_label: range.fromLabel,
        unit_to_label: range.toLabel,
        total_questions: questions.length,
        time_limit_ms: exam.time_limit_ms,
        pass_percent: exam.pass_percent,
        started_at: now,
        snapshot: snapshotOf(exam, student),
      },
      questions.map((g, i) => ({
        seq: i + 1,
        word_id: g.word.id,
        word_key: g.word.englishKey,
        direction: g.direction,
        prompt: g.prompt,
        pos: g.word.pos,
        options: g.options,
        option_word_ids: g.optionWordIds,
        correct_index: g.correctIndex,
        english: g.word.english,
        meaning: g.word.meaning,
        unit_label: g.word.unitLabel,
      })),
    );
    return { attemptId: id, totalQuestions: questions.length };
  }).catch((e) => {
    // 동시에 두 번 시작한 경우 (부분 유일 인덱스 충돌)
    if (isUniqueViolation(e)) {
      throw new AppError('ATTEMPT_IN_PROGRESS', 409, '이미 시작한 시험이 있어요. 잠시 후 다시 시도해 주세요.');
    }
    throw e;
  });
}

// ───────── 잠금·상태 ─────────

async function lockAttempt(q: Queryable, attemptId: string, deviceToken: string | null): Promise<AttemptRow> {
  assertUuid(attemptId);
  const r = await q.query<AttemptRow>('SELECT * FROM attempts WHERE id = $1 FOR UPDATE', [attemptId]);
  const a = r.rows[0];
  if (!a || !(await deviceOwnsStudent(q, deviceToken, a.student_id))) {
    throw new AppError('NOT_FOUND', 404, '시험 기록을 찾을 수 없어요.');
  }
  return a;
}

async function loadQuestions(q: Queryable, attemptId: string): Promise<QuestionRow[]> {
  return (await q.query<QuestionRow>('SELECT * FROM attempt_questions WHERE attempt_id = $1 ORDER BY seq', [attemptId])).rows;
}

function questionView(a: AttemptRow, qr: QuestionRow, now: Date): QuestionView {
  return {
    seq: qr.seq,
    total: a.total_questions,
    direction: qr.direction,
    instruction: INSTRUCTION[qr.direction],
    prompt: qr.prompt,
    pos: qr.pos,
    options: qr.options,
    presentedAt: qr.presented_at!.toISOString(),
    deadlineAt: qr.deadline_at!.toISOString(),
    remainingMs: Math.max(0, qr.deadline_at!.getTime() - now.getTime()),
  };
}

function reveal(qr: QuestionRow): AnswerReveal {
  return {
    seq: qr.seq,
    direction: qr.direction,
    prompt: qr.prompt,
    options: qr.options,
    result: qr.result!,
    chosenIndex: qr.chosen_index,
    correctIndex: qr.correct_index,
    english: qr.english,
    meaning: qr.meaning,
  };
}

/** 연습 종류: 원본 회차가 있으면 '이번 오답 다시 풀기', 없으면 누적 오답시험 */
function practiceKindOf(a: Pick<AttemptRow, 'mode' | 'source_attempt_id'>): PracticeKind | null {
  if (a.mode !== 'practice') return null;
  return a.source_attempt_id ? 'retry' : 'wrong-test';
}

function rangeLabelOf(a: Pick<AttemptRow, 'mode' | 'source_attempt_id' | 'unit_from_label' | 'unit_to_label' | 'total_questions'>): string {
  if (practiceKindOf(a) === 'wrong-test') return `누적 오답 ${a.total_questions}개 단어`;
  return a.unit_from_label === a.unit_to_label ? a.unit_from_label : `${a.unit_from_label} ~ ${a.unit_to_label}`;
}

function stateOf(a: AttemptRow, qs: QuestionRow[], now: Date): AttemptState {
  const answered = qs.filter((x) => x.result);
  const current = a.status === 'in_progress' ? qs.find((x) => x.presented_at && !x.result) ?? null : null;
  const last = answered.length ? answered.reduce((m, x) => (x.seq > m.seq ? x : m)) : null;
  return {
    attemptId: a.id,
    examSlug: a.snapshot.examSlug,
    mode: a.mode,
    practiceKind: practiceKindOf(a),
    status: a.status,
    total: a.total_questions,
    answered: answered.length,
    correct: answered.filter((x) => x.result === 'correct').length,
    unitFromLabel: a.unit_from_label,
    unitToLabel: a.unit_to_label,
    rangeLabel: rangeLabelOf(a),
    current: current ? questionView(a, current, now) : null,
    last: last ? reveal(last) : null,
    needsNext: a.status === 'in_progress' && !current && answered.length < a.total_questions,
    serverNow: now.toISOString(),
  };
}

/** 회차 완료 확정 (정확히 한 번). 정규 PASS 면 퀘스트 적립 판정. */
async function completeAttempt(q: Queryable, a: AttemptRow, qs: QuestionRow[], finishedAt: Date) {
  const correct = qs.filter((x) => x.result === 'correct').length;
  const total = a.total_questions;
  let passed: boolean | null = null;
  let step: number | null = null;
  let note: string | null = null;
  if (a.mode === 'regular') {
    passed = correct * 100 >= total * a.pass_percent; // 정수 비교 (표시 반올림과 무관)
    if (passed) {
      await q.query('SELECT id FROM students WHERE id = $1 FOR UPDATE', [a.student_id]);
      const exam = (await q.query<ExamRow>('SELECT * FROM exams WHERE id = $1', [a.exam_id])).rows[0];
      const d = await decideQuestCredit(q, exam, a.student_id, finishedAt);
      step = d.step;
      note = d.note;
    } else {
      note = `정답률 ${a.pass_percent}% 미만(FAIL)이라 이번 시험은 지도에 반영되지 않았어요.`;
    }
  } else {
    note = '연습은 PASS/FAIL과 퀘스트에 반영되지 않아요.';
  }
  const r = await q.query(
    `UPDATE attempts SET status = 'completed', finished_at = $2, duration_ms = $3, passed = $4, quest_step = $5, quest_note = $6,
        answered_count = $7, correct_count = $8
      WHERE id = $1 AND status = 'in_progress'`,
    [a.id, finishedAt, Math.max(0, finishedAt.getTime() - a.started_at.getTime()), passed, step, note, qs.filter((x) => x.result).length, correct],
  );
  if (r.rowCount === 1) {
    Object.assign(a, { status: 'completed', finished_at: finishedAt, passed, quest_step: step, quest_note: note });
  }
}

async function syncCounts(q: Queryable, a: AttemptRow, qs: QuestionRow[]) {
  const answered = qs.filter((x) => x.result).length;
  const correct = qs.filter((x) => x.result === 'correct').length;
  await q.query('UPDATE attempts SET answered_count = $2, correct_count = $3 WHERE id = $1', [a.id, answered, correct]);
  a.answered_count = answered;
  a.correct_count = correct;
}

/** 마감이 지난 미응답 문항을 시간 초과로 확정 (조회·다음·그만하기 시점에 호출) */
async function expireOverdue(q: Queryable, a: AttemptRow, qs: QuestionRow[], now: Date): Promise<boolean> {
  if (a.status !== 'in_progress') return false;
  let changed = false;
  for (const x of qs) {
    if (x.presented_at && !x.result && x.deadline_at && now >= x.deadline_at) {
      await q.query(
        `UPDATE attempt_questions SET result = 'timeout', answered_at = deadline_at WHERE attempt_id = $1 AND seq = $2 AND result IS NULL`,
        [a.id, x.seq],
      );
      x.result = 'timeout';
      x.answered_at = x.deadline_at;
      changed = true;
    }
  }
  if (changed) {
    await syncCounts(q, a, qs);
    if (qs.every((x) => x.result)) {
      const last = qs.reduce((m, x) => (x.answered_at! > m ? x.answered_at! : m), new Date(0));
      await completeAttempt(q, a, qs, last);
    }
  }
  return changed;
}

export async function getState(ctx: Ctx, attemptId: string, deviceToken: string | null): Promise<AttemptState> {
  const now = nowOf(ctx);
  return ctx.db.tx(async (q) => {
    const a = await lockAttempt(q, attemptId, deviceToken);
    const qs = await loadQuestions(q, a.id);
    await expireOverdue(q, a, qs, now);
    return stateOf(a, qs, now);
  });
}

export async function nextQuestion(ctx: Ctx, attemptId: string, deviceToken: string | null): Promise<AttemptState> {
  const now = nowOf(ctx);
  return ctx.db.tx(async (q) => {
    const a = await lockAttempt(q, attemptId, deviceToken);
    const qs = await loadQuestions(q, a.id);
    await expireOverdue(q, a, qs, now);
    if (a.status !== 'in_progress') return stateOf(a, qs, now);
    if (qs.some((x) => x.presented_at && !x.result)) return stateOf(a, qs, now); // 이미 제시 중 → 그대로
    const nxt = qs.find((x) => !x.presented_at);
    if (nxt) {
      const deadline = new Date(now.getTime() + a.time_limit_ms);
      await q.query(
        'UPDATE attempt_questions SET presented_at = $3, deadline_at = $4 WHERE attempt_id = $1 AND seq = $2 AND presented_at IS NULL',
        [a.id, nxt.seq, now, deadline],
      );
      nxt.presented_at = now;
      nxt.deadline_at = deadline;
    }
    return stateOf(a, qs, now);
  });
}

export async function answer(
  ctx: Ctx,
  attemptId: string,
  deviceToken: string | null,
  body: { seq?: unknown; choice?: unknown },
): Promise<AnswerResponse> {
  const now = nowOf(ctx);
  const seq = Number(body.seq);
  const choice = body.choice === null || body.choice === undefined ? null : Number(body.choice);
  if (!Number.isInteger(seq) || seq < 1) throw new AppError('BAD_REQUEST', 400, '문항 번호가 올바르지 않아요.');
  if (choice !== null && !(Number.isInteger(choice) && choice >= 0 && choice <= 3)) throw new AppError('BAD_REQUEST', 400, '보기를 다시 골라 주세요.');
  return ctx.db.tx(async (q) => {
    const a = await lockAttempt(q, attemptId, deviceToken);
    const qs = await loadQuestions(q, a.id);
    const x = qs.find((r) => r.seq === seq);
    if (!x) throw new AppError('QUESTION_MISMATCH', 409, '지금 풀고 있는 문제가 아니에요. 화면을 새로고침해 주세요.');
    if (x.result) {
      // 같은 답안의 재전송·연타: 처음 확정 결과 그대로
      return { reveal: reveal(x), state: stateOf(a, qs, now), duplicate: true };
    }
    if (a.status !== 'in_progress') throw new AppError('ATTEMPT_FINISHED', 409, '이미 끝난 시험이에요.');
    if (!x.presented_at || !x.deadline_at) throw new AppError('QUESTION_MISMATCH', 409, '아직 제시되지 않은 문제예요. 화면을 새로고침해 주세요.');
    let result: AnswerResult;
    let answeredAt = now;
    let chosen: number | null = choice;
    if (now >= x.deadline_at) {
      // 서버 기준 10초 경과 → 선택과 관계없이 시간 초과(오답)
      result = 'timeout';
      answeredAt = x.deadline_at;
      chosen = null;
    } else if (choice === null) {
      result = 'timeout'; // 화면 타이머 종료 신고
    } else {
      result = choice === x.correct_index ? 'correct' : 'wrong';
    }
    const u = await q.query(
      'UPDATE attempt_questions SET result = $3, chosen_index = $4, answered_at = $5 WHERE attempt_id = $1 AND seq = $2 AND result IS NULL',
      [a.id, seq, result, chosen, answeredAt],
    );
    if (u.rowCount !== 1) throw new AppError('INTERNAL', 500, '잠시 후 다시 시도해 주세요.');
    Object.assign(x, { result, chosen_index: chosen, answered_at: answeredAt });
    await syncCounts(q, a, qs);
    if (qs.every((r) => r.result)) await completeAttempt(q, a, qs, answeredAt);
    return { reveal: reveal(x), state: stateOf(a, qs, now), duplicate: false };
  });
}

export async function quit(ctx: Ctx, attemptId: string, deviceToken: string | null): Promise<AttemptState> {
  const now = nowOf(ctx);
  return ctx.db.tx(async (q) => {
    const a = await lockAttempt(q, attemptId, deviceToken);
    const qs = await loadQuestions(q, a.id);
    if (a.status === 'quit') return stateOf(a, qs, now);
    if (a.status === 'completed') throw new AppError('ATTEMPT_FINISHED', 409, '이미 끝난 시험이에요.');
    await expireOverdue(q, a, qs, now); // 이미 마감된 문항은 시간 초과로 확정해 보존
    if (a.status !== 'in_progress') return stateOf(a, qs, now);
    const answered = qs.filter((x) => x.result).length;
    const correct = qs.filter((x) => x.result === 'correct').length;
    const note = a.mode === 'regular' ? '그만둔 시험은 지도에 반영되지 않아요.' : '연습은 PASS/FAIL과 퀘스트에 반영되지 않아요.';
    await q.query(
      `UPDATE attempts SET status = 'quit', finished_at = $2, duration_ms = $3, passed = NULL, quest_note = $4, answered_count = $5, correct_count = $6
        WHERE id = $1 AND status = 'in_progress'`,
      [a.id, now, Math.max(0, now.getTime() - a.started_at.getTime()), note, answered, correct],
    );
    Object.assign(a, { status: 'quit', finished_at: now, passed: null, quest_note: note });
    return stateOf(a, qs, now);
  });
}

// ───────── 성적표 ─────────

export async function result(ctx: Ctx, attemptId: string, deviceToken: string | null): Promise<ResultView> {
  const now = nowOf(ctx);
  return ctx.db.tx(async (q) => {
    const a = await lockAttempt(q, attemptId, deviceToken);
    const qs = await loadQuestions(q, a.id);
    await expireOverdue(q, a, qs, now);
    if (a.status === 'in_progress') {
      throw new AppError('ATTEMPT_IN_PROGRESS', 409, '아직 진행 중인 시험이에요.', { attemptId: a.id });
    }
    const exam = (await q.query<ExamRow>('SELECT * FROM exams WHERE id = $1', [a.exam_id])).rows[0];
    const answered = qs.filter((x) => x.result).length;
    const correct = qs.filter((x) => x.result === 'correct').length;
    const wrongs: WrongItem[] = qs
      .filter((x) => x.result === 'wrong' || x.result === 'timeout')
      .map((x) => ({
        seq: x.seq,
        english: x.english,
        meaning: x.meaning,
        pos: x.pos,
        direction: x.direction,
        result: x.result as 'wrong' | 'timeout',
        chosenText: x.chosen_index != null ? x.options[x.chosen_index] : null,
        unitLabel: x.unit_label,
      }));
    const credited = a.quest_step ? { step: a.quest_step as 1 | 2 | 3 | 4, name: stepName(a.quest_step)! } : null;
    return {
      attemptId: a.id,
      examSlug: a.snapshot.examSlug,
      mode: a.mode,
      practiceKind: practiceKindOf(a),
      status: a.status,
      studentName: a.snapshot.studentName,
      school: a.snapshot.school,
      grade: a.snapshot.grade,
      examLabel: a.snapshot.examLabel,
      displayTitle: a.snapshot.displayTitle,
      unitFromLabel: a.unit_from_label,
      unitToLabel: a.unit_to_label,
      rangeLabel: rangeLabelOf(a),
      startedAt: a.started_at.toISOString(),
      finishedAt: a.finished_at!.toISOString(),
      durationMs: a.finished_at!.getTime() - a.started_at.getTime(),
      total: a.total_questions,
      answered,
      correct,
      accuracyPercent: a.total_questions ? Math.round((correct / a.total_questions) * 1000) / 10 : 0,
      passPercent: a.pass_percent,
      passed: a.mode === 'regular' && a.status === 'completed' ? a.passed : null,
      wrongs,
      quest: {
        credited,
        reason: credited ? null : a.quest_note,
        celebrate: credited && !a.mission_seen_at ? credited : null,
        progress: await questProgress(q, exam, a.student_id, now),
      },
    };
  });
}

export async function markMissionSeen(ctx: Ctx, attemptId: string, deviceToken: string | null): Promise<{ ok: true }> {
  const now = nowOf(ctx);
  await ctx.db.tx(async (q) => {
    const a = await lockAttempt(q, attemptId, deviceToken);
    if (a.quest_step && !a.mission_seen_at) {
      await q.query('UPDATE attempts SET mission_seen_at = $2 WHERE id = $1 AND mission_seen_at IS NULL', [a.id, now]);
    }
  });
  return { ok: true };
}

/** '틀린 것만 다시' — 원본 회차의 확정 오답으로 연습 회차 생성 (스냅샷 재사용, 보기 순서만 다시 섞음) */
export async function startPractice(
  ctx: Ctx,
  attemptId: string,
  deviceToken: string | null,
  body: { clientRequestId?: unknown },
): Promise<StartAttemptResponse> {
  const clientRequestId = assertClientRequestId(body.clientRequestId);
  const now = nowOf(ctx);
  const rng = rngOf(ctx);
  return ctx.db.tx(async (q) => {
    const src = await lockAttempt(q, attemptId, deviceToken);
    const dup = await q.query<{ id: string; total_questions: number }>(
      'SELECT id, total_questions FROM attempts WHERE student_id = $1 AND client_request_id = $2',
      [src.student_id, clientRequestId],
    );
    if (dup.rows[0]) return { attemptId: dup.rows[0].id, totalQuestions: dup.rows[0].total_questions };
    if (src.status === 'in_progress') throw new AppError('ATTEMPT_IN_PROGRESS', 409, '시험을 마친 뒤에 다시 풀 수 있어요.', { attemptId: src.id });
    const qs = await loadQuestions(q, src.id);
    const wrong = qs.filter((x) => x.result === 'wrong' || x.result === 'timeout');
    if (!wrong.length) throw new AppError('NO_WRONG_ANSWERS', 422, '이번 시험에서 틀린 단어가 없어요. 잘했어요!');
    // 진행 중인 이전 연습은 정리 (연습은 기록·집계에 영향 없음)
    await q.query(
      `UPDATE attempts SET status = 'quit', finished_at = $2, quest_note = '새 연습을 시작해 종료됨' WHERE student_id = $1 AND mode = 'practice' AND status = 'in_progress'`,
      [src.student_id, now],
    );
    const id = crypto.randomUUID();
    const rows = shuffle(wrong, rng).map((x, i) => {
      const order = shuffle([0, 1, 2, 3], rng);
      return {
        seq: i + 1,
        word_id: x.word_id,
        word_key: x.word_key,
        direction: x.direction,
        prompt: x.prompt,
        pos: x.pos,
        options: order.map((k) => x.options[k]),
        option_word_ids: order.map((k) => x.option_word_ids[k]),
        correct_index: order.indexOf(x.correct_index),
        english: x.english,
        meaning: x.meaning,
        unit_label: x.unit_label,
      };
    });
    await insertAttempt(
      q,
      {
        id,
        exam_id: src.exam_id,
        student_id: src.student_id,
        mode: 'practice',
        source_attempt_id: src.id,
        client_request_id: clientRequestId,
        unit_from: src.unit_from,
        unit_to: src.unit_to,
        unit_from_label: src.unit_from_label,
        unit_to_label: src.unit_to_label,
        total_questions: rows.length,
        time_limit_ms: src.time_limit_ms,
        pass_percent: src.pass_percent,
        started_at: now,
        snapshot: src.snapshot,
      },
      rows,
    );
    return { attemptId: id, totalQuestions: rows.length };
  });
}

/** 슬러그 + 회차 접근을 함께 확인하고 싶을 때 */
export async function attemptExamSlug(ctx: Ctx, attemptId: string): Promise<string | null> {
  assertUuid(attemptId);
  const r = await ctx.db.query<{ slug: string }>('SELECT e.slug FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE a.id = $1', [attemptId]);
  return r.rows[0]?.slug ?? null;
}

export { getExamBySlug };
