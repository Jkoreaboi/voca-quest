/**
 * 퀘스트: 기간 안에 완료한 정규 PASS 만 한 칸씩 (출렁다리 → 가시덤불 → 드래곤 → 공주의 성).
 * 판정 시각은 서버의 시험 완료 시각(finished_at). 기간은 시작 포함·종료 제외.
 */
import { QUEST_STEPS, QUEST_TOTAL_STEPS, type QuestProgress, type QuestStepNo } from '../shared/api';
import type { Queryable } from './db';
import { questPeriod, periodText, type ExamRow } from './exams';

export async function questProgress(q: Queryable, exam: ExamRow, studentId: string, now: Date): Promise<QuestProgress> {
  const r = await q.query<{ id: string; quest_step: number; finished_at: Date }>(
    'SELECT id, quest_step, finished_at FROM attempts WHERE student_id = $1 AND quest_step IS NOT NULL ORDER BY quest_step',
    [studentId],
  );
  const by = new Map(r.rows.map((x) => [x.quest_step, x]));
  const steps = QUEST_STEPS.map((s) => {
    const a = by.get(s.step);
    return { step: s.step as QuestStepNo, key: s.key, name: s.name, achievedAt: a ? a.finished_at.toISOString() : null, attemptId: a ? a.id : null };
  });
  const completedSteps = r.rows.length;
  return { completedSteps, missionComplete: completedSteps >= QUEST_TOTAL_STEPS, steps, period: questPeriod(exam, now) };
}

/**
 * 정규 PASS 회차의 적립 판정. 호출 전 학생 행을 잠가야 한다(동시 완료 시 같은 칸 중복 방지).
 * 반환: 적립된 칸 번호 또는 null + 학생에게 보여 줄 사유
 */
export async function decideQuestCredit(
  q: Queryable,
  exam: ExamRow,
  studentId: string,
  finishedAt: Date,
): Promise<{ step: QuestStepNo | null; note: string | null }> {
  const p = questPeriod(exam, finishedAt);
  if (p.status === 'not_configured') return { step: null, note: '퀘스트 기간이 아직 정해지지 않아 지도에 반영되지 않았어요. 시험 기록은 저장됐어요.' };
  const txt = periodText(p);
  if (p.status === 'upcoming') return { step: null, note: `퀘스트 기간(${txt}) 시작 전에 완료한 시험이라 지도에 반영되지 않았어요. 시험 기록은 저장됐어요.` };
  if (p.status === 'ended') return { step: null, note: `퀘스트 기간(${txt})이 끝난 뒤 완료한 시험이라 지도에 반영되지 않았어요. 시험 기록은 저장됐어요.` };
  const c = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM attempts WHERE student_id = $1 AND quest_step IS NOT NULL', [studentId]);
  const n = c.rows[0].n;
  if (n >= QUEST_TOTAL_STEPS) return { step: null, note: '이미 네 개의 미션을 모두 완료했어요 (Mission Complete).' };
  return { step: (n + 1) as QuestStepNo, note: null };
}

export function stepName(step: number | null | undefined): string | null {
  return QUEST_STEPS.find((s) => s.step === step)?.name ?? null;
}
