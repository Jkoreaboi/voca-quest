/**
 * 누적 오답시험 (Codex 추가 기능, Claude 검토·보완).
 * 현재 시험·현재 학생의 정규 회차(완료+그만둠)에서 확정된 오답·시간 초과를 단어별 최신 문항 스냅샷으로 모아
 * 연습(practice) 회차를 만든다. 정규 기록·PASS/FAIL·퀘스트·누적 오답노트에는 영향이 없다.
 * - 같은 단어는 한 번만, 문항 순서와 보기 순서는 다시 섞는다(이전 정답 위치를 외워 맞히지 않도록).
 * - 진행 중인 누적 오답시험이 있으면 그것을 이어 간다. 다른 종류의 연습('틀린 것만 다시')이 진행 중이면 종료하고 새로 만든다.
 * - clientRequestId 로 멱등.
 */
import crypto from 'node:crypto';
import type { StartAttemptResponse } from '../shared/api';
import { AppError, nowOf, type Ctx } from './context';
import { getExamBySlug } from './exams';
import { requireStudent } from './identity';

interface SnapshotQuestion {
  word_id: number;
  word_key: string;
  direction: string;
  prompt: string;
  pos: string | null;
  options: string[];
  option_word_ids: number[];
  correct_index: number;
  english: string;
  meaning: string;
  unit_label: string;
}

const shuffle = <T>(a: T[]): T[] => {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

export function wrongTestLabel(textbook: string) {
  return `${textbook.replace(/^Vocabulary Map\s*/i, '').trim()} 오답시험`;
}

export async function startWrongTest(ctx: Ctx, slug: string, device: string | null, body: { clientRequestId?: unknown }): Promise<StartAttemptResponse> {
  const key = String(body.clientRequestId ?? '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new AppError('BAD_REQUEST', 400, '요청 식별자가 올바르지 않아요. 화면을 새로고침해 주세요.');
  const now = nowOf(ctx);
  return ctx.db.tx(async (q) => {
    const e = await getExamBySlug(q, slug);
    const s = await requireStudent(q, device, e);
    await q.query('SELECT id FROM students WHERE id = $1 FOR UPDATE', [s.id]);
    const dup = await q.query<{ id: string; total_questions: number }>(
      'SELECT id, total_questions FROM attempts WHERE student_id = $1 AND client_request_id = $2',
      [s.id, key],
    );
    if (dup.rows[0]) return { attemptId: dup.rows[0].id, totalQuestions: dup.rows[0].total_questions };

    const words = await q.query<SnapshotQuestion>(
      `SELECT DISTINCT ON (aq.word_key) aq.word_id, aq.word_key, aq.direction, aq.prompt, aq.pos, aq.options, aq.option_word_ids,
              aq.correct_index, aq.english, aq.meaning, aq.unit_label
         FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id
        WHERE a.student_id = $1 AND a.exam_id = $2 AND a.mode = 'regular' AND a.status IN ('completed', 'quit')
          AND aq.result IN ('wrong', 'timeout')
        ORDER BY aq.word_key, aq.answered_at DESC, aq.attempt_id DESC, aq.seq DESC`,
      [s.id, e.id],
    );
    if (!words.rows.length) throw new AppError('NO_WRONG_ANSWERS', 422, '아직 누적된 오답이 없어요. 정규 시험을 먼저 풀어 주세요.');

    // 진행 중인 연습: 누적 오답시험(source_attempt_id 없음)이면 이어 가고, 다른 연습이면 정리
    const active = await q.query<{ id: string; total_questions: number; source_attempt_id: string | null }>(
      `SELECT id, total_questions, source_attempt_id FROM attempts WHERE student_id = $1 AND mode = 'practice' AND status = 'in_progress' ORDER BY started_at DESC`,
      [s.id],
    );
    const resumable = active.rows.find((a) => a.source_attempt_id === null);
    if (resumable) return { attemptId: resumable.id, totalQuestions: resumable.total_questions };
    if (active.rows.length) {
      await q.query(
        `UPDATE attempts SET status = 'quit', finished_at = $2, quest_note = '새 연습을 시작해 종료됨' WHERE student_id = $1 AND mode = 'practice' AND status = 'in_progress'`,
        [s.id, now],
      );
    }

    const id = crypto.randomUUID();
    const label = wrongTestLabel(e.textbook);
    const snapshot = { school: s.school, grade: e.grade, textbook: e.textbook, title: label, displayTitle: `${e.school} ${e.grade} ${label}`, examLabel: label, studentName: s.display_name, examSlug: slug };
    const rows = shuffle(words.rows);
    await q.query(
      `INSERT INTO attempts (id, exam_id, student_id, mode, client_request_id, unit_from, unit_to, unit_from_label, unit_to_label, total_questions, time_limit_ms, pass_percent, started_at, snapshot)
       VALUES ($1, $2, $3, 'practice', $4, $5, $6, '누적 오답', $7, $8, $9, $10, $11, $12::jsonb)`,
      [id, e.id, s.id, key, e.unit_from, e.unit_to, `${rows.length}개 단어`, rows.length, e.time_limit_ms, e.pass_percent, now, JSON.stringify(snapshot)],
    );
    // 문항 내용만 복사 (이전 답안·마감은 넘기지 않음). 보기 순서는 다시 섞고 정답 위치를 다시 계산.
    for (const [i, w] of rows.entries()) {
      const order = shuffle([0, 1, 2, 3]);
      await q.query(
        `INSERT INTO attempt_questions (attempt_id, seq, word_id, word_key, direction, prompt, pos, options, option_word_ids, correct_index, english, meaning, unit_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)`,
        [id, i + 1, w.word_id, w.word_key, w.direction, w.prompt, w.pos, JSON.stringify(order.map((k) => w.options[k])), JSON.stringify(order.map((k) => w.option_word_ids[k])), order.indexOf(w.correct_index), w.english, w.meaning, w.unit_label],
      );
    }
    return { attemptId: id, totalQuestions: rows.length };
  });
}
