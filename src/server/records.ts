/**
 * 누적 오답노트와 My Record. 둘 다 현재 시험·현재 학생 기준, 정규 회차만 집계한다.
 */
import type { RecordRound, RecordsResponse, WrongNoteItem, WrongNotesResponse } from '../shared/api';
import { addDays, kstDateString, kstStartOfDay } from '../shared/time';
import { nowOf, type Ctx } from './context';
import { getExamBySlug } from './exams';
import { requireStudent } from './identity';
import { questProgress, stepName } from './quest';

export async function wrongNotes(ctx: Ctx, slug: string, deviceToken: string | null): Promise<WrongNotesResponse> {
  const now = nowOf(ctx);
  const exam = await getExamBySlug(ctx.db, slug);
  const s = await requireStudent(ctx.db, deviceToken, exam);
  const r = await ctx.db.query<{ word_key: string; english: string; meaning: string; pos: string | null; result: 'wrong' | 'timeout'; answered_at: Date; unit_label: string }>(
    `SELECT aq.word_key, aq.english, aq.meaning, aq.pos, aq.result, aq.answered_at, aq.unit_label
       FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id
      WHERE a.student_id = $1 AND a.mode = 'regular' AND a.status IN ('completed', 'quit')
        AND aq.result IN ('wrong', 'timeout')
      ORDER BY aq.answered_at`,
    [s.id],
  );
  const groups = new Map<string, WrongNoteItem>();
  for (const row of r.rows) {
    let g = groups.get(row.word_key);
    if (!g) {
      g = { key: row.word_key, english: row.english, meanings: [], pos: row.pos, count: 0, timeoutCount: 0, lastWrongAt: row.answered_at.toISOString(), unitLabels: [] };
      groups.set(row.word_key, g);
    }
    g.count++;
    if (row.result === 'timeout') g.timeoutCount++;
    if (!g.meanings.includes(row.meaning)) g.meanings.push(row.meaning);
    if (!g.unitLabels.includes(row.unit_label)) g.unitLabels.push(row.unit_label);
    if (row.answered_at.toISOString() > g.lastWrongAt) g.lastWrongAt = row.answered_at.toISOString();
    g.english = row.english; // 최근 표기
  }
  const items = Array.from(groups.values()).sort((a, b) => (a.lastWrongAt < b.lastWrongAt ? 1 : a.lastWrongAt > b.lastWrongAt ? -1 : b.count - a.count));
  return { studentName: s.display_name, asOf: now.toISOString(), total: items.length, items };
}

export async function records(ctx: Ctx, slug: string, deviceToken: string | null): Promise<RecordsResponse> {
  const now = nowOf(ctx);
  const exam = await getExamBySlug(ctx.db, slug);
  const s = await requireStudent(ctx.db, deviceToken, exam);
  const r = await ctx.db.query<{ id: string; status: 'in_progress' | 'completed' | 'quit'; started_at: Date; finished_at: Date | null; unit_from_label: string; unit_to_label: string; total_questions: number; answered_count: number; correct_count: number; duration_ms: number | null; passed: boolean | null; quest_step: number | null; quest_note: string | null }>(
    `SELECT id, status, started_at, finished_at, unit_from_label, unit_to_label, total_questions, answered_count, correct_count, duration_ms, passed, quest_step, quest_note
       FROM attempts WHERE student_id = $1 AND mode = 'regular' ORDER BY started_at, id`,
    [s.id],
  );
  const today = kstDateString(now);
  const dayStart = kstStartOfDay(today);
  const dayEnd = kstStartOfDay(addDays(today, 1));
  let pass = 0;
  let fail = 0;
  let quitN = 0;
  for (const a of r.rows) {
    if (a.status === 'in_progress' || !a.finished_at) continue;
    if (a.finished_at < dayStart || a.finished_at >= dayEnd) continue;
    if (a.status === 'quit') quitN++;
    else if (a.passed) pass++;
    else fail++;
  }
  const rounds: RecordRound[] = r.rows.map((a, i) => ({
    no: i + 1,
    attemptId: a.id,
    status: a.status,
    startedAt: a.started_at.toISOString(),
    finishedAt: a.finished_at ? a.finished_at.toISOString() : null,
    unitFromLabel: a.unit_from_label,
    unitToLabel: a.unit_to_label,
    total: a.total_questions,
    answered: a.answered_count,
    correct: a.correct_count,
    durationMs: a.duration_ms,
    passed: a.status === 'completed' ? a.passed : null,
    mission: a.quest_step ? { step: a.quest_step as 1 | 2 | 3 | 4, name: stepName(a.quest_step)! } : null,
    questNote: a.quest_step ? null : a.quest_note,
  }));
  rounds.reverse();
  return {
    studentName: s.display_name,
    today: { date: today, attempts: pass + fail + quitN, pass, fail, quit: quitN },
    quest: await questProgress(ctx.db, exam, s.id, now),
    rounds,
  };
}
