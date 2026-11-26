import { createMemoryDb, createPgDb, type Db } from '../src/server/db';
import { runMigrations } from '../src/server/migrations';
import type { Ctx } from '../src/server/context';
import { createExam, type ExamInput } from '../src/server/exams';
import { importWordbook, loadConfig } from '../src/server/importer';
import { enter } from '../src/server/identity';
import { answer, nextQuestion, startAttempt } from '../src/server/attempts';
import { seededRng } from '../src/server/options';

export interface TestEnv {
  db: Db;
  ctx: Ctx;
  clock: { now: Date };
  setNow: (iso: string) => void;
  advance: (ms: number) => void;
}

/**
 * 기본: 프로세스 내 PGlite(메모리).
 * TEST_DATABASE_URL 이 있으면 그 PostgreSQL 에 임시 스키마(vq_test_*)를 만들어 실행하고 끝나면 지운다.
 * 운영 DB 가 아닌 비어 있는 테스트용 DB 를 지정할 것.
 */
async function openTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createMemoryDb();
  const schema = `vq_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const forceTx = process.env.TEST_DB_FORCE_TX === '1';
  const admin = await createPgDb(url, forceTx);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.close();
  const db = await createPgDb(url, forceTx, { schema });
  const close = db.close;
  return {
    ...db,
    query: db.query,
    tx: db.tx,
    kind: db.kind,
    close: async () => {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await close();
    },
  };
}

export async function setupEnv(): Promise<TestEnv> {
  const db = await openTestDb();
  await runMigrations(db);
  await importWordbook(db, loadConfig('vmap-basic-b1'));
  const clock = { now: new Date('2026-11-27T01:00:00.000Z') }; // 2026-11-27 10:00 KST (퀘스트 기간 안)
  const ctx: Ctx = { db, now: () => clock.now, rng: seededRng(20261125) };
  return {
    db,
    ctx,
    clock,
    setNow: (iso) => {
      clock.now = new Date(iso);
    },
    advance: (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
}

let seq = 0;
export const device = (label = 'd') => `${label}-${String(++seq).padStart(4, '0')}-abcdefghijklmnopqrstuvwxyz0123`;
export const reqId = () => `req-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function newExam(env: TestEnv, extra: Partial<ExamInput> = {}) {
  return createExam(env.ctx, {
    wordbook: 'vmap-basic-b1',
    school: '테스트고',
    grade: '1학년',
    textbook: 'Vocabulary Map Basic B-1',
    title: '테스트 범위',
    unitFrom: 1,
    unitTo: 20,
    questionCount: 20,
    questStart: '2026-11-26',
    questEnd: '2026-12-06',
    isSample: true,
    ...extra,
  });
}

export async function correctIndex(env: TestEnv, attemptId: string, s: number): Promise<number> {
  const r = await env.db.query<{ correct_index: number }>('SELECT correct_index FROM attempt_questions WHERE attempt_id = $1 AND seq = $2', [attemptId, s]);
  return r.rows[0].correct_index;
}

/** 회차를 처음부터 끝까지 푼다. correct 개만 맞히고 나머지는 틀린다. */
export async function playAttempt(env: TestEnv, attemptId: string, dev: string, correct: number) {
  let state = await nextQuestion(env.ctx, attemptId, dev);
  let i = 0;
  while (state.status === 'in_progress') {
    if (!state.current) {
      state = await nextQuestion(env.ctx, attemptId, dev);
      continue;
    }
    const ci = await correctIndex(env, attemptId, state.current.seq);
    const choice = (i < correct ? ci : (ci + 1) % 4) as 0 | 1 | 2 | 3;
    env.advance(1500);
    const r = await answer(env.ctx, attemptId, dev, { seq: state.current.seq, choice });
    state = r.state;
    i++;
    if (state.status === 'in_progress') state = await nextQuestion(env.ctx, attemptId, dev);
  }
  return state;
}

/** 학생 입장 + 회차 시작 + correct 개 맞히기 */
export async function enterAndPlay(env: TestEnv, slug: string, dev: string, name: string, correct: number, range = { from: 1, to: 2 }) {
  await enter(env.ctx, slug, dev, name);
  const s = await startAttempt(env.ctx, slug, dev, { unitFrom: range.from, unitTo: range.to, clientRequestId: reqId() });
  const state = await playAttempt(env, s.attemptId, dev, correct);
  return { attemptId: s.attemptId, total: s.totalQuestions, state };
}
