import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, getState, markMissionSeen, nextQuestion, quit, result, startAttempt, startPractice } from '../src/server/attempts';
import { AppError } from '../src/server/context';
import { examPublic, getExamBySlug, preview, updateExam } from '../src/server/exams';
import { enter, recover } from '../src/server/identity';
import { importWordbook, loadConfig } from '../src/server/importer';
import { OptionBuilder, seededRng, type WordRec } from '../src/server/options';
import { records, wrongNotes } from '../src/server/records';
import { startWrongTest } from '../src/server/wrong-test';
import { login, logout, resetPassword, signup } from '../src/server/accounts';
import { correctIndex, device, enterAndPlay, newExam, playAttempt, reqId, setupEnv, type TestEnv } from './helpers';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env?.db.close();
});

async function expectAppError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
  throw new Error(`expected AppError ${code}`);
}

describe('단어장 임포트', () => {
  it('실제 교사용 파일 800행을 20개 Unit으로 반영하고, 재임포트해도 행이 늘지 않는다', async () => {
    const before = await env.db.query<{ n: number }>('SELECT count(*)::int AS n FROM words');
    expect(before.rows[0].n).toBe(800);
    const units = await env.db.query<{ n: number }>('SELECT count(*)::int AS n FROM units WHERE ordinal > 0');
    expect(units.rows[0].n).toBe(20);
    const again = await importWordbook(env.db, loadConfig('vmap-basic-b1'));
    expect(again.totals.inserted).toBe(0);
    expect(again.totals.unchanged).toBe(800);
    expect(again.totals.read).toBe(800);
    expect(again.totals.crossUnitRepeats).toBe(23);
    expect(again.crossCheck.mismatches).toBe(0);
    const after = await env.db.query<{ n: number }>('SELECT count(*)::int AS n FROM words');
    expect(after.rows[0].n).toBe(800);
  });
});

describe('보기 생성 (정답은 정확히 하나)', () => {
  it('모든 단어·양방향에서 보기 4개가 서로 다르고 정답 1개, 오답은 모두 충돌 검사를 통과한다', async () => {
    const r = await env.db.query<any>(
      `SELECT w.id, u.ordinal, u.label, w.item_no, w.english, w.english_norm, w.pos, w.meaning, w.senses, w.kind, w.confusables, w.conflicts
         FROM words w JOIN units u ON u.id = w.unit_id WHERE w.status = 'active'`,
    );
    const pool: WordRec[] = r.rows.map((w) => ({ id: w.id, unitOrdinal: w.ordinal, unitLabel: w.label, itemNo: w.item_no, english: w.english, englishKey: w.english_norm, pos: w.pos, meaning: w.meaning, senses: w.senses, kind: w.kind, confusables: w.confusables, conflicts: w.conflicts }));
    const b = new OptionBuilder(pool);
    const rng = seededRng(7);
    const byId = new Map(pool.map((w) => [w.id, w]));
    let built = 0;
    for (const w of pool) {
      for (const d of ['en2ko', 'ko2en'] as const) {
        const res = b.build(w, d, rng);
        if (!res.ok) continue;
        built++;
        const q = res.q;
        expect(q.options).toHaveLength(4);
        expect(new Set(q.options).size).toBe(4);
        expect(q.optionWordIds.filter((id) => id === w.id)).toHaveLength(1);
        expect(q.options[q.correctIndex]).toBe(d === 'en2ko' ? w.meaning : w.english);
        for (const id of q.optionWordIds) if (id !== w.id) expect(b.rejectReason(w, byId.get(id)!, d)).toBeNull();
      }
    }
    expect(built).toBeGreaterThan(1500);
  });

  it('같은 뜻의 다른 단어(cruel/brutal, book/reserve, consist of/be made up of)는 서로의 보기로 나오지 않는다', async () => {
    const r = await env.db.query<any>(
      `SELECT w.id, u.ordinal, u.label, w.item_no, w.english, w.english_norm, w.pos, w.meaning, w.senses, w.kind, w.confusables, w.conflicts
         FROM words w JOIN units u ON u.id = w.unit_id WHERE w.status = 'active'`,
    );
    const pool: WordRec[] = r.rows.map((w) => ({ id: w.id, unitOrdinal: w.ordinal, unitLabel: w.label, itemNo: w.item_no, english: w.english, englishKey: w.english_norm, pos: w.pos, meaning: w.meaning, senses: w.senses, kind: w.kind, confusables: w.confusables, conflicts: w.conflicts }));
    const b = new OptionBuilder(pool);
    const find = (e: string) => pool.find((w) => w.english === e)!;
    const pairs: Array<[string, string]> = [
      ['cruel', 'brutal'], ['book', 'reserve'], ['consist of', 'be made up of'], ['admired', 'respected'], ['Not at all.', "Don't mention it!"], ['furthermore', 'in addition'],
      // 교사 검토용 CSV 에서 발견된 복수 정답 사례 (뜻 비교 규칙 + 동의 그룹 설정으로 차단)
      ["I'm certain that", "I'm confident that"], ['Can I ~?', 'Is it okay if I ~?'], ['medicine', 'pill'], ['toxic', 'poisonous'], ['intend to', 'I plan to'], ["You'd better", "We'd better"],
    ];
    for (const [a, c] of pairs) {
      for (const d of ['en2ko', 'ko2en'] as const) {
        expect(b.rejectReason(find(a), find(c), d)).not.toBeNull();
        expect(b.rejectReason(find(c), find(a), d)).not.toBeNull();
      }
    }
    // 같은 영어의 다른 뜻 (match: 맞수/경기/일치하다) — 영→한에서 서로 보기 불가
    const matches = pool.filter((w) => w.english === 'match');
    expect(matches.length).toBe(3);
    expect(b.rejectReason(matches[0], matches[1], 'en2ko')).not.toBeNull();
    // 축약형 차이 (I'm sorry to hear that. / I am sorry to hear that)
    expect(b.rejectReason(find("I'm sorry to hear that."), find('I am sorry to hear that'), 'ko2en')).not.toBeNull();
  });
});

describe('시험 링크·범위', () => {
  it('시험 정보에 학교·학년·교재·시험명·허용 Unit이 연결된다', async () => {
    const e = await newExam(env, { unitFrom: 3, unitTo: 6, school: '인천외고', textbook: '어휘끝', title: '기말 범위' });
    const pub = await examPublic(env.ctx, env.db, await getExamBySlug(env.db, e.slug));
    expect(pub.displayTitle).toBe('인천외고 1학년 어휘끝 (기말 범위)');
    expect(pub.units.map((u) => u.ordinal)).toEqual([3, 4, 5, 6]);
    expect(pub.units[0].label).toBe('Ch2 Day 1');
    expect(pub.timeLimitSec).toBe(10);
    expect(pub.passPercent).toBe(90);
    expect(pub.quest.status).toBe('active');
    expect(pub.quest.endDate).toBe('2026-12-06');
    expect(pub.quest.dDay).toBe(9); // 11/27 → 12/6
  });

  it('시작이 끝보다 뒤이거나 허용 범위 밖이면 시작 전에 막는다', async () => {
    const e = await newExam(env, { unitFrom: 3, unitTo: 6 });
    await expectAppError(preview(env.ctx, e.slug, 5, 4), 'INVALID_RANGE');
    await expectAppError(preview(env.ctx, e.slug, 1, 4), 'INVALID_RANGE');
    await expectAppError(preview(env.ctx, e.slug, 3, 7), 'INVALID_RANGE');
    const p = await preview(env.ctx, e.slug, 3, 3);
    expect(p.wordCount).toBe(40);
    expect(p.questionCount).toBe(20);
    expect(p.canStart).toBe(true);
  });

  it('유효 문항이 목표보다 적으면 실제 문항 수를, 0개면 시작 불가를 알려 준다', async () => {
    const e = await newExam(env, { questionCount: 60 });
    const p = await preview(env.ctx, e.slug, 1, 1);
    expect(p.questionCount).toBe(40);
    expect(p.message).toContain('40문항');
    // Unit 20 단어를 모두 확인 필요로 바꿔 0개 상황 재현
    await env.db.query(`UPDATE words SET status = 'needs_review' WHERE unit_id = (SELECT id FROM units WHERE ordinal = 20)`);
    try {
      const p0 = await preview(env.ctx, e.slug, 20, 20);
      expect(p0.canStart).toBe(false);
      const dev = device();
      await enter(env.ctx, e.slug, dev, '영문항');
      await expectAppError(startAttempt(env.ctx, e.slug, dev, { unitFrom: 20, unitTo: 20, clientRequestId: reqId() }), 'NO_VALID_QUESTIONS');
    } finally {
      await env.db.query(`UPDATE words SET status = 'active' WHERE unit_id = (SELECT id FROM units WHERE ordinal = 20)`);
    }
  });
});

describe('출제·진행', () => {
  it('한 회차에 같은 단어를 반복하지 않고 한→영/영→한을 섞으며, 정답 위치를 미리 보내지 않는다', async () => {
    const e = await newExam(env, { questionCount: 60 });
    const dev = device();
    await enter(env.ctx, e.slug, dev, '출제확인');
    // Unit 1~20 전체 (다른 Unit 반복 단어 23개 포함)
    const s = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 20, clientRequestId: reqId() });
    expect(s.totalQuestions).toBe(60);
    const r = await env.db.query<{ word_key: string; direction: string }>('SELECT word_key, direction FROM attempt_questions WHERE attempt_id = $1', [s.attemptId]);
    expect(new Set(r.rows.map((x) => x.word_key)).size).toBe(60);
    const ko = r.rows.filter((x) => x.direction === 'ko2en').length;
    expect(ko).toBeGreaterThanOrEqual(25);
    expect(ko).toBeLessThanOrEqual(35);
    const st = await nextQuestion(env.ctx, s.attemptId, dev);
    expect(st.current).not.toBeNull();
    expect(JSON.stringify(st)).not.toMatch(/correct_?index/i);
    expect(st.current!.options).toHaveLength(4);
    await quit(env.ctx, s.attemptId, dev);
  });

  it('새로고침·연타해도 제시된 문항의 마감 시각은 바뀌지 않는다 (타이머 재시작 없음)', async () => {
    const e = await newExam(env);
    const dev = device();
    await enter(env.ctx, e.slug, dev, '새로고침');
    const s = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() });
    const a = await nextQuestion(env.ctx, s.attemptId, dev);
    env.advance(4000);
    const b = await nextQuestion(env.ctx, s.attemptId, dev);
    const c = await getState(env.ctx, s.attemptId, dev);
    expect(b.current!.seq).toBe(a.current!.seq);
    expect(b.current!.deadlineAt).toBe(a.current!.deadlineAt);
    expect(c.current!.deadlineAt).toBe(a.current!.deadlineAt);
    expect(c.current!.remainingMs).toBe(6000);
    await quit(env.ctx, s.attemptId, dev);
  });

  it('10초 제한: 9.999초는 인정, 10초 정각부터는 선택과 관계없이 시간 초과(오답)이며 정답을 공개한다', async () => {
    const e = await newExam(env);
    const dev = device();
    await enter(env.ctx, e.slug, dev, '타이머');
    const s = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() });
    let st = await nextQuestion(env.ctx, s.attemptId, dev);
    let ci = await correctIndex(env, s.attemptId, 1);
    env.advance(9999);
    let r = await answer(env.ctx, s.attemptId, dev, { seq: 1, choice: ci });
    expect(r.reveal.result).toBe('correct');

    st = await nextQuestion(env.ctx, s.attemptId, dev);
    ci = await correctIndex(env, s.attemptId, 2);
    env.advance(10000);
    r = await answer(env.ctx, s.attemptId, dev, { seq: 2, choice: ci });
    expect(r.reveal.result).toBe('timeout');
    expect(r.reveal.correctIndex).toBe(ci);
    expect(r.reveal.chosenIndex).toBeNull();

    // 화면을 닫고 마감이 지난 뒤 다시 열면 서버가 시간 초과로 확정하고 다음 문항으로
    st = await nextQuestion(env.ctx, s.attemptId, dev);
    expect(st.current!.seq).toBe(3);
    env.advance(60_000);
    st = await getState(env.ctx, s.attemptId, dev);
    expect(st.current).toBeNull();
    expect(st.last!.seq).toBe(3);
    expect(st.last!.result).toBe('timeout');
    expect(st.needsNext).toBe(true);
    expect(st.answered).toBe(3);
    await quit(env.ctx, s.attemptId, dev);
  });

  it('중복 탭·재시도: 같은 문항에 여러 번 답해도 첫 답안만 확정된다 (동시 요청 포함)', async () => {
    const e = await newExam(env);
    const dev = device();
    await enter(env.ctx, e.slug, dev, '연타');
    const s = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() });
    await nextQuestion(env.ctx, s.attemptId, dev);
    const ci = await correctIndex(env, s.attemptId, 1);
    env.advance(1000);
    const wrongChoice = ((ci + 1) % 4) as 0 | 1 | 2 | 3;
    const results = await Promise.all([
      answer(env.ctx, s.attemptId, dev, { seq: 1, choice: wrongChoice }),
      answer(env.ctx, s.attemptId, dev, { seq: 1, choice: ci }),
      answer(env.ctx, s.attemptId, dev, { seq: 1, choice: ci }),
    ]);
    expect(results.filter((x) => !x.duplicate)).toHaveLength(1);
    const first = results.find((x) => !x.duplicate)!;
    for (const x of results) expect(x.reveal.result).toBe(first.reveal.result);
    const st = await getState(env.ctx, s.attemptId, dev);
    expect(st.answered).toBe(1);
    // 아직 제시되지 않은 문항에 답하면 거부
    await expectAppError(answer(env.ctx, s.attemptId, dev, { seq: 5, choice: 0 }), 'QUESTION_MISMATCH');
    await quit(env.ctx, s.attemptId, dev);
  });

  it('시작 요청을 연타해도 회차는 하나, 진행 중 회차가 있으면 새로 시작하지 않는다', async () => {
    const e = await newExam(env);
    const dev = device();
    await enter(env.ctx, e.slug, dev, '시작연타');
    const id = reqId();
    const [a, b] = await Promise.all([
      startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: id }),
      startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: id }),
    ]);
    expect(a.attemptId).toBe(b.attemptId);
    const err = await expectAppError(startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() }), 'ATTEMPT_IN_PROGRESS');
    expect(err.details?.attemptId).toBe(a.attemptId);
    await quit(env.ctx, a.attemptId, dev);
  });
});

describe('채점·PASS 90% 경계', () => {
  const cases: Array<[number, number, boolean]> = [
    [20, 18, true],
    [20, 17, false],
    [10, 9, true],
    [10, 8, false],
    [7, 6, false], // 85.7%
    [11, 10, true], // 90.9%
  ];
  for (const [total, correct, pass] of cases) {
    it(`${total}문항 중 ${correct}개 → ${pass ? 'PASS' : 'FAIL'}`, async () => {
      const e = await newExam(env, { questionCount: total, questStart: null, questEnd: null });
      const dev = device();
      const { attemptId, state } = await enterAndPlay(env, e.slug, dev, `경계${total}-${correct}`, correct);
      expect(state.status).toBe('completed');
      const res = await result(env.ctx, attemptId, dev);
      expect(res.total).toBe(total);
      expect(res.correct).toBe(correct);
      expect(res.passed).toBe(pass);
      expect(res.wrongs).toHaveLength(total - correct);
      expect(res.quest.credited).toBeNull();
      expect(res.quest.reason).toBeTruthy();
    });
  }
});

describe('그만하기', () => {
  it('확인된 오답은 보존하고, 미응답은 버리며, 오답노트·My Record에 그만한 회차로 남는다', async () => {
    const e = await newExam(env);
    const dev = device();
    await enter(env.ctx, e.slug, dev, '그만');
    const s = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() });
    for (let i = 1; i <= 3; i++) {
      await nextQuestion(env.ctx, s.attemptId, dev);
      const ci = await correctIndex(env, s.attemptId, i);
      env.advance(2000);
      await answer(env.ctx, s.attemptId, dev, { seq: i, choice: (i === 2 ? (ci + 1) % 4 : ci) as 0 | 1 | 2 | 3 });
    }
    await nextQuestion(env.ctx, s.attemptId, dev); // 4번 제시 중 그만
    env.advance(3000);
    const st = await quit(env.ctx, s.attemptId, dev);
    expect(st.status).toBe('quit');
    expect(st.answered).toBe(3);
    expect((await quit(env.ctx, s.attemptId, dev)).status).toBe('quit'); // 멱등
    await expectAppError(answer(env.ctx, s.attemptId, dev, { seq: 4, choice: 0 }), 'ATTEMPT_FINISHED');
    const res = await result(env.ctx, s.attemptId, dev);
    expect(res.passed).toBeNull();
    expect(res.wrongs).toHaveLength(1);
    const wn = await wrongNotes(env.ctx, e.slug, dev);
    expect(wn.total).toBe(1);
    const rec = await records(env.ctx, e.slug, dev);
    expect(rec.today).toMatchObject({ attempts: 1, pass: 0, fail: 0, quit: 1 });
    expect(rec.rounds[0]).toMatchObject({ no: 1, status: 'quit', answered: 3, total: 20 });
  });
});

describe('퀘스트', () => {
  it('기간 안 PASS만 한 칸씩, 네 번째 PASS에 Mission Complete, 다섯 번째는 적립 없음', async () => {
    const e = await newExam(env, { questionCount: 10 });
    const dev = device();
    const names = ['출렁다리', '가시덤불', '드래곤', '공주의 성'];
    for (let i = 0; i < 4; i++) {
      // FAIL 은 진행시키지 않음
      const f = await enterAndPlay(env, e.slug, dev, '퀘스트왕', 5);
      expect((await result(env.ctx, f.attemptId, dev)).quest.credited).toBeNull();
      const p = await enterAndPlay(env, e.slug, dev, '퀘스트왕', 10);
      const res = await result(env.ctx, p.attemptId, dev);
      expect(res.passed).toBe(true);
      expect(res.quest.credited).toEqual({ step: i + 1, name: names[i] });
      expect(res.quest.celebrate).toEqual({ step: i + 1, name: names[i] });
      expect(res.quest.progress.completedSteps).toBe(i + 1);
      // 연출 확인 후 재조회하면 다시 연출하지 않음, 적립도 그대로
      await markMissionSeen(env.ctx, p.attemptId, dev);
      const again = await result(env.ctx, p.attemptId, dev);
      expect(again.quest.celebrate).toBeNull();
      expect(again.quest.progress.completedSteps).toBe(i + 1);
    }
    const last = await result(env.ctx, (await records(env.ctx, e.slug, dev)).rounds[0].attemptId, dev);
    expect(last.quest.progress.missionComplete).toBe(true);
    const fifth = await enterAndPlay(env, e.slug, dev, '퀘스트왕', 10);
    const r5 = await result(env.ctx, fifth.attemptId, dev);
    expect(r5.passed).toBe(true);
    expect(r5.quest.credited).toBeNull();
    expect(r5.quest.reason).toContain('이미');
    expect(r5.quest.progress.completedSteps).toBe(4);
  });

  it('기간 경계: 시작 전·마감 다음날 0시(KST) 이후 완료는 적립 안 함, 마감일 23:59:59는 적립', async () => {
    const e = await newExam(env, { questionCount: 1, questStart: '2026-11-26', questEnd: '2026-12-06' });
    const dev = device();
    // 시작 전: 2026-11-25 23:59 KST
    env.setNow('2026-11-25T14:59:00.000Z');
    let p = await enterAndPlay(env, e.slug, dev, '경계', 1);
    let res = await result(env.ctx, p.attemptId, dev);
    expect(res.passed).toBe(true);
    expect(res.quest.credited).toBeNull();
    expect(res.quest.reason).toContain('시작 전');
    // 마감일 23:59:58 KST 시작 → 완료 23:59:59.5 KST (기간 안)
    env.setNow('2026-12-06T14:59:58.000Z');
    p = await enterAndPlay(env, e.slug, dev, '경계', 1);
    res = await result(env.ctx, p.attemptId, dev);
    expect(res.quest.credited?.step).toBe(1);
    // 마감 다음날 00:00:00 KST 정각 완료 → 제외
    env.setNow('2026-12-06T14:59:58.500Z');
    await enter(env.ctx, e.slug, dev, '경계');
    const s = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() });
    await nextQuestion(env.ctx, s.attemptId, dev);
    env.setNow('2026-12-06T15:00:00.000Z');
    // 마감(10초)은 아직 안 지났지만 퀘스트 기간은 끝남
    const ci = await correctIndex(env, s.attemptId, 1);
    await answer(env.ctx, s.attemptId, dev, { seq: 1, choice: ci as 0 });
    res = await result(env.ctx, s.attemptId, dev);
    expect(res.passed).toBe(true);
    expect(res.quest.credited).toBeNull();
    expect(res.quest.reason).toContain('끝난 뒤');
    env.setNow('2026-11-27T01:00:00.000Z');
  });

  it('마지막 문항이 열린 채 창을 닫으면 완료 시각은 그 문항 마감 시각 — 기간이 지난 뒤 재접속해도 기간 안 완료로 판정', async () => {
    const e = await newExam(env, { questionCount: 2, questStart: '2026-11-26', questEnd: '2026-12-06' });
    const dev = device();
    env.setNow('2026-12-06T14:59:00.000Z'); // 마감일 23:59 KST
    await enter(env.ctx, e.slug, dev, '소급');
    const s = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() });
    await nextQuestion(env.ctx, s.attemptId, dev);
    // 1번 정답, 2번은 제시만 된 채 이탈 → 1/2 = 50% FAIL 이 되는 상황을 피하려고 1문항 정답 후 2번은 시간 초과
    const c1 = await correctIndex(env, s.attemptId, 1);
    env.advance(1000);
    await answer(env.ctx, s.attemptId, dev, { seq: 1, choice: c1 as 0 });
    await nextQuestion(env.ctx, s.attemptId, dev);
    env.setNow('2026-12-10T00:00:00.000Z'); // 기간 종료 며칠 뒤 재접속
    const st = await getState(env.ctx, s.attemptId, dev);
    expect(st.status).toBe('completed');
    const res = await result(env.ctx, s.attemptId, dev);
    expect(new Date(res.finishedAt).getTime()).toBe(new Date('2026-12-06T14:59:11.000Z').getTime()); // 2번 마감 시각
    expect(res.passed).toBe(false); // 1/2
    expect(res.quest.reason).toContain('FAIL');
    env.setNow('2026-11-27T01:00:00.000Z');
  });
});

describe('오답 복습', () => {
  it("'틀린 것만 다시'는 방금 회차 오답만, 연습은 PASS/FAIL·퀘스트·오답노트·My Record에 반영되지 않는다", async () => {
    const e = await newExam(env, { questionCount: 10 });
    const dev = device();
    const { attemptId } = await enterAndPlay(env, e.slug, dev, '복습', 7);
    const src = await result(env.ctx, attemptId, dev);
    const wrongWords = new Set(src.wrongs.map((w) => w.english));
    expect(wrongWords.size).toBe(3);
    const before = { wn: await wrongNotes(env.ctx, e.slug, dev), rec: await records(env.ctx, e.slug, dev) };
    const pr = await startPractice(env.ctx, attemptId, dev, { clientRequestId: reqId() });
    expect(pr.totalQuestions).toBe(3);
    const ps = await playAttempt(env, pr.attemptId, dev, 0); // 연습에서 또 다 틀림
    expect(ps.status).toBe('completed');
    const pres = await result(env.ctx, pr.attemptId, dev);
    expect(pres.mode).toBe('practice');
    expect(pres.practiceKind).toBe('retry');
    expect(src.practiceKind).toBeNull();
    expect(src.rangeLabel).toBe('Ch1 Day 1 ~ Ch1 Day 2');
    expect(pres.passed).toBeNull();
    expect(pres.quest.credited).toBeNull();
    expect(new Set(pres.wrongs.map((w) => w.english))).toEqual(wrongWords);
    const after = { wn: await wrongNotes(env.ctx, e.slug, dev), rec: await records(env.ctx, e.slug, dev) };
    expect(after.wn).toEqual({ ...before.wn, asOf: after.wn.asOf });
    expect(after.rec.rounds).toHaveLength(before.rec.rounds.length);
    expect(after.rec.today).toEqual(before.rec.today);
    // 오답 없는 회차는 연습 불가
    const perfect = await enterAndPlay(env, e.slug, dev, '복습', 10);
    await expectAppError(startPractice(env.ctx, perfect.attemptId, dev, { clientRequestId: reqId() }), 'NO_WRONG_ANSWERS');
  });

  it('같은 단어의 반복 오답은 한 항목으로 묶여 횟수와 최근 시점을 보여 준다', async () => {
    const e = await newExam(env, { questionCount: 40 });
    const dev = device();
    const a = await enterAndPlay(env, e.slug, dev, '반복', 0, { from: 1, to: 1 });
    env.advance(60_000);
    const b = await enterAndPlay(env, e.slug, dev, '반복', 0, { from: 1, to: 1 });
    const wn = await wrongNotes(env.ctx, e.slug, dev);
    expect(wn.total).toBe(40);
    expect(wn.items.every((i) => i.count === 2)).toBe(true);
    const lastB = (await result(env.ctx, b.attemptId, dev)).finishedAt;
    expect(wn.items.every((i) => i.lastWrongAt <= lastB)).toBe(true);
    expect(a.attemptId).not.toBe(b.attemptId);
  });

  it('누적 오답시험: 단어별 1번, 보기는 같은 4개를 다시 섞고, 정규 기록·오답노트에 영향 없음, 멱등·이어하기', async () => {
    const e = await newExam(env, { questionCount: 10 });
    const dev = device();
    await expectAppError(
      (async () => {
        await enter(env.ctx, e.slug, dev, '누적');
        return startWrongTest(env.ctx, e.slug, dev, { clientRequestId: reqId() });
      })(),
      'NO_WRONG_ANSWERS',
    );
    await enterAndPlay(env, e.slug, dev, '누적', 6, { from: 1, to: 1 }); // 오답 4
    await enterAndPlay(env, e.slug, dev, '누적', 6, { from: 1, to: 1 }); // 오답 4 (일부 겹칠 수 있음)
    const before = { wn: await wrongNotes(env.ctx, e.slug, dev), rec: await records(env.ctx, e.slug, dev) };
    // '틀린 것만 다시' 연습을 진행 중으로 남겨 둔다
    const pr = await startPractice(env.ctx, before.rec.rounds[0].attemptId, dev, { clientRequestId: reqId() });
    await nextQuestion(env.ctx, pr.attemptId, dev);

    const key = reqId();
    const wt = await startWrongTest(env.ctx, e.slug, dev, { clientRequestId: key });
    expect(wt.totalQuestions).toBe(before.wn.total);
    expect((await startWrongTest(env.ctx, e.slug, dev, { clientRequestId: key })).attemptId).toBe(wt.attemptId); // 멱등
    expect((await startWrongTest(env.ctx, e.slug, dev, { clientRequestId: reqId() })).attemptId).toBe(wt.attemptId); // 진행 중이면 이어 가기
    expect((await getState(env.ctx, pr.attemptId, dev)).status).toBe('quit'); // 다른 연습은 정리

    const qs = await env.db.query<{ word_key: string; options: string[]; correct_index: number; english: string; meaning: string; direction: string }>(
      'SELECT word_key, options, correct_index, english, meaning, direction FROM attempt_questions WHERE attempt_id = $1',
      [wt.attemptId],
    );
    expect(new Set(qs.rows.map((r) => r.word_key)).size).toBe(qs.rows.length);
    expect(new Set(qs.rows.map((r) => r.word_key))).toEqual(new Set(before.wn.items.map((i) => i.key)));
    for (const r of qs.rows) {
      expect(r.options[r.correct_index]).toBe(r.direction === 'en2ko' ? r.meaning : r.english);
      const src = await env.db.query<{ options: string[] }>(
        `SELECT aq.options FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id
          WHERE a.mode = 'regular' AND a.exam_id = (SELECT id FROM exams WHERE slug = $1) AND aq.word_key = $2 AND aq.result IN ('wrong','timeout')
          ORDER BY aq.answered_at DESC LIMIT 1`,
        [e.slug, r.word_key],
      );
      expect([...r.options].sort()).toEqual([...src.rows[0].options].sort());
    }
    const done = await playAttempt(env, wt.attemptId, dev, 0);
    expect(done.status).toBe('completed');
    const res = await result(env.ctx, wt.attemptId, dev);
    expect(res.mode).toBe('practice');
    expect(res.practiceKind).toBe('wrong-test');
    expect(res.rangeLabel).toBe(`누적 오답 ${wt.totalQuestions}개 단어`);
    expect(res.passed).toBeNull();
    expect(res.examLabel).toBe('Basic B-1 오답시험');
    const after = { wn: await wrongNotes(env.ctx, e.slug, dev), rec: await records(env.ctx, e.slug, dev) };
    expect(after.wn.items).toEqual(before.wn.items);
    expect(after.rec.rounds).toHaveLength(before.rec.rounds.length);
    expect(after.rec.today).toEqual(before.rec.today);
  });
});

describe('학생 식별', () => {
  it('같은 기기·같은 이름은 기록을 잇고, 다른 기기의 같은 이름은 기록을 보지 못하며, 복구 코드로만 연결된다', async () => {
    const e = await newExam(env, { questionCount: 5 });
    const devA = device('A');
    const first = await enter(env.ctx, e.slug, devA, '김민지');
    expect(first.created).toBe(true);
    expect(first.recoveryCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    await enterAndPlay(env, e.slug, devA, '김민지', 5);
    const again = await enter(env.ctx, e.slug, devA, ' 김민지 ');
    expect(again.created).toBe(false);
    expect(again.student.studentId).toBe(first.student.studentId);

    const devB = device('B');
    const other = await enter(env.ctx, e.slug, devB, '김민지');
    expect(other.created).toBe(true);
    expect(other.student.studentId).not.toBe(first.student.studentId);
    expect((await records(env.ctx, e.slug, devB)).rounds).toHaveLength(0);

    const devC = device('C');
    await expectAppError(recover(env.ctx, e.slug, devC, 'AAAA-BBBB-CCCC'), 'RECOVERY_FAILED');
    const rec = await recover(env.ctx, e.slug, devC, first.recoveryCode!.toLowerCase().replace(/-/g, ' '));
    expect(rec.student.studentId).toBe(first.student.studentId);
    expect((await records(env.ctx, e.slug, devC)).rounds).toHaveLength(1);

    // 복구 코드 원문은 DB 에 없다
    const dump = await env.db.query<{ t: string }>(`SELECT row_to_json(s)::text AS t FROM students s`);
    expect(dump.rows.some((r) => r.t.includes(first.recoveryCode!))).toBe(false);

    // 다른 기기의 회차는 열 수 없다
    const r = await records(env.ctx, e.slug, devA);
    await expectAppError(result(env.ctx, r.rounds[0].attemptId, devB), 'NOT_FOUND');
  });

  it('복구 코드를 10번 틀리면 잠시 막는다', async () => {
    const e = await newExam(env);
    const dev = device('R');
    for (let i = 0; i < 10; i++) await expectAppError(recover(env.ctx, e.slug, dev, `ZZZZ-ZZZZ-ZZ${String(i).padStart(2, '0')}`), 'RECOVERY_FAILED');
    await expectAppError(recover(env.ctx, e.slug, dev, 'ZZZZ-ZZZZ-ZZZZ'), 'RATE_LIMITED');
  });

  it('쿠키를 매번 지워도 같은 IP 에서 60번 틀리면 막는다 (학교 와이파이 공유를 고려한 넉넉한 한도)', async () => {
    const e = await newExam(env);
    for (let i = 0; i < 60; i++) await expectAppError(recover(env.ctx, e.slug, device('ip'), 'YYYY-YYYY-YYYY', '203.0.113.7'), 'RECOVERY_FAILED');
    await expectAppError(recover(env.ctx, e.slug, device('ip'), 'YYYY-YYYY-YYYY', '203.0.113.7'), 'RATE_LIMITED');
    await expectAppError(recover(env.ctx, e.slug, device('ip'), 'YYYY-YYYY-YYYY', '198.51.100.1'), 'RECOVERY_FAILED');
  });
});

describe('학교·이름 입장', () => {
  it('학교 저장·생략 시 시험 학교·검증, 새 성적표는 학생 학교, 시험 설정 학교는 그대로', async () => {
    const e = await newExam(env, { school: '예시고', questionCount: 1 });
    const devOld = device('old');
    const old = await enter(env.ctx, e.slug, devOld, '구버전'); // 구 클라이언트: school 생략
    expect(old.student.school).toBe('예시고');
    const dev = device('sch');
    const a = await enter(env.ctx, e.slug, dev, '학교생', ' 인천  외고 ');
    expect(a.student.school).toBe('인천 외고');
    for (const bad of ['', '   ', 'x'.repeat(61), '<b>학교</b>']) {
      await expectAppError(enter(env.ctx, e.slug, dev, '학교생', bad), 'BAD_REQUEST');
    }
    env.advance(1000); // 같은 기기의 '최근 학생'은 마지막 입장 시각으로 고르므로 시간을 흘린다
    const { attemptId } = await enterAndPlay(env, e.slug, dev, '학교생', 1, { from: 1, to: 1 });
    // enterAndPlay 는 school 을 생략하므로 같은 기기의 '예시고/학교생' 새 학생으로 들어간다 → 학교별 분리 확인용
    const r = await result(env.ctx, attemptId, dev);
    expect(r.school).toBe('예시고');
    env.advance(1000);
    const again = await enter(env.ctx, e.slug, dev, '학교생', '인천외고'); // 공백 차이는 같은 학교
    expect(again.created).toBe(false);
    expect(again.student.studentId).toBe(a.student.studentId);
    const s2 = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() });
    await playAttempt(env, s2.attemptId, dev, 1);
    const r2 = await result(env.ctx, s2.attemptId, dev);
    expect(r2.school).toBe('인천 외고');
    expect(r2.studentName).toBe('학교생');
    expect((await result(env.ctx, attemptId, dev)).school).toBe('예시고'); // 기존 성적표 유지
    const pub = await examPublic(env.ctx, env.db, await getExamBySlug(env.db, e.slug));
    expect(pub.school).toBe('예시고'); // 시험 설정 학교 불변
    expect(r2.unitFromLabel).toBe('Ch1 Day 1'); // 범위는 시험 허용 범위 안에서만
  });

  it('같은 기기·같은 이름이라도 학교가 다르면 별개 학생, 복구 코드는 학교 포함 원래 학생으로', async () => {
    const e = await newExam(env);
    const dev = device('homo');
    const a = await enter(env.ctx, e.slug, dev, '김하늘', 'A고');
    const b = await enter(env.ctx, e.slug, dev, '김하늘', 'B고');
    expect(b.created).toBe(true);
    expect(b.student.studentId).not.toBe(a.student.studentId);
    const [c1, c2] = await Promise.all([enter(env.ctx, e.slug, device('race'), '동시', 'C고'), Promise.resolve(null)]);
    expect(c1.created).toBe(true);
    const rec = await recover(env.ctx, e.slug, device('newdev'), b.recoveryCode!);
    expect(rec.student).toEqual({ studentId: b.student.studentId, name: '김하늘', school: 'B고', username: null });
    expect(c2).toBeNull();
  });

  it('migration 004: 기존 학생은 시험 학교로 백필되어 학교 없이 들어와도 같은 기록으로 이어진다', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createMemoryDb } = await import('../src/server/db');
    const { runMigrations, migrationsDir } = await import('../src/server/migrations');
    const { hashDeviceToken } = await import('../src/server/context');
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-mig-'));
    for (const f of ['001_init.sql', '002_recovery_ip.sql', '003_word_conflicts.sql']) fs.copyFileSync(path.join(migrationsDir(), f), path.join(oldDir, f));
    const db = await createMemoryDb();
    try {
      await runMigrations(db, oldDir);
      await db.query(`INSERT INTO wordbooks (id, code, title) VALUES (1, 'wb', 'WB')`);
      await db.query(`INSERT INTO exams (slug, wordbook_id, school, grade, textbook, title, unit_from, unit_to) VALUES ('old-exam', 1, '송도고', '1학년', 'T', '기말', 1, 1)`);
      const sid = '11111111-1111-4111-8111-111111111111';
      await db.query(`INSERT INTO students (id, exam_id, display_name, name_key, recovery_code_hash) VALUES ($1, 1, '기존생', '기존생', 'h-old')`, [sid]);
      const dev = device('mig');
      await db.query(`INSERT INTO device_students (device_hash, student_id, exam_id) VALUES ($1, $2, 1)`, [hashDeviceToken(dev), sid]);
      expect(await runMigrations(db)).toEqual(['004_student_school.sql', '005_student_school_nullable.sql', '006_accounts.sql']);
      const row = (await db.query<{ school: string; school_key: string }>('SELECT school, school_key FROM students WHERE id = $1', [sid])).rows[0];
      expect(row).toEqual({ school: '송도고', school_key: '송도고' });
      const ctx = { db, now: () => new Date('2026-11-27T01:00:00Z') };
      const viaOld = await enter(ctx, 'old-exam', dev, '기존생'); // 구 클라이언트
      expect(viaOld.created).toBe(false);
      expect(viaOld.student.studentId).toBe(sid);
      const viaNew = await enter(ctx, 'old-exam', dev, '기존생', '송도 고'); // 새 폼에서 시험 학교를 입력
      expect(viaNew.student.studentId).toBe(sid);
      // 마이그레이션 후에도 아직 배포 전인 이전 코드가 학교 없이 만든 학생 → 시험 학교로 읽혀 이어진다
      const sid2 = '22222222-2222-4222-8222-222222222222';
      await db.query(`INSERT INTO students (id, exam_id, display_name, name_key, recovery_code_hash) VALUES ($1, 1, '전환생', '전환생', 'h-mid')`, [sid2]);
      await db.query(`INSERT INTO device_students (device_hash, student_id, exam_id) VALUES ($1, $2, 1)`, [hashDeviceToken(dev), sid2]);
      const mid = await enter(ctx, 'old-exam', dev, '전환생');
      expect(mid.student).toEqual({ studentId: sid2, name: '전환생', school: '송도고', username: null });
    } finally {
      await db.close();
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  });
});

describe('아이디·비밀번호 계정', () => {
  const pw = 'secret-pass-1';

  it('가입 검증·중복 아이디·해시 저장, 로그인 실패는 같은 메시지, 성공 시 세션 회전', async () => {
    const e = await newExam(env);
    const dev = device('acc');
    const base = { school: '인천외고', name: '박서준', username: 'Seojun.P', password: pw };
    for (const bad of [{ username: 'ab' }, { username: '한글아이디' }, { password: 'short' }, { password: 'seojun.p' }, { school: '' }, { name: '' }]) {
      await expectAppError(signup(env.ctx, e.slug, dev, '10.0.0.1', { ...base, ...bad }), 'BAD_REQUEST');
    }
    const a = await signup(env.ctx, e.slug, dev, '10.0.0.1', base);
    expect(a.res.student).toMatchObject({ name: '박서준', school: '인천외고', username: 'seojun.p' });
    expect(a.token).not.toBe(dev);
    await expectAppError(signup(env.ctx, e.slug, device('acc'), '10.0.0.1', { ...base, username: 'SEOJUN.P' }), 'USERNAME_TAKEN');
    const row = (await env.db.query<{ t: string }>(`SELECT row_to_json(a)::text AS t FROM accounts a WHERE username_key = 'seojun.p'`)).rows[0].t;
    expect(row).not.toContain(pw);
    expect(row).toContain('scrypt$');
    const wrong = await expectAppError(login(env.ctx, e.slug, device('l'), '10.0.0.2', { username: 'seojun.p', password: 'nope-nope-1' }), 'LOGIN_FAILED');
    const unknown = await expectAppError(login(env.ctx, e.slug, device('l'), '10.0.0.2', { username: 'nobody99', password: pw }), 'LOGIN_FAILED');
    expect(wrong.message).toBe(unknown.message);
    const l1 = await login(env.ctx, e.slug, a.token, '10.0.0.2', { username: ' SeoJun.P ', password: pw });
    expect(l1.res.student.studentId).toBe(a.res.student.studentId);
    expect(await currentStudentOf(e.slug, a.token)).toBeNull(); // 회전: 이전 토큰 폐기
    expect((await currentStudentOf(e.slug, l1.token))?.id).toBe(a.res.student.studentId);
    // 로그인 중에는 이름 입장·복구 코드로 우회 불가
    await expectAppError(enter(env.ctx, e.slug, l1.token, '박서준', '인천외고'), 'ACCOUNT_REQUIRED');
    await logout(env.ctx, l1.token);
    expect(await currentStudentOf(e.slug, l1.token)).toBeNull();
  });

  it('중복 아이디 가입 실패도 시도 제한에 남고 긴 비밀번호는 일반 로그인 실패로 처리한다', async () => {
    const e = await newExam(env);
    const base = { school: '검증학교', name: '검증학생', username: 'signup-limit', password: pw };
    await signup(env.ctx, e.slug, device('owner'), '10.20.0.1', base);
    const attacker = device('duplicate');
    for (let i = 0; i < 10; i++) await expectAppError(signup(env.ctx, e.slug, attacker, '10.20.0.2', base), 'USERNAME_TAKEN');
    await expectAppError(signup(env.ctx, e.slug, attacker, '10.20.0.2', { ...base, username: 'available-limit' }), 'RATE_LIMITED');
    const long = await expectAppError(login(env.ctx, e.slug, device('long'), '10.20.0.3', { username: base.username, password: 'a'.repeat(100000) }), 'LOGIN_FAILED');
    expect(long.message).toBe('아이디 또는 비밀번호가 맞지 않아요.');
    env.advance(11 * 60 * 1000);
    const fresh = await signup(env.ctx, e.slug, attacker, '10.20.0.2', { ...base, username: 'available-limit' });
    expect(fresh.res.student.username).toBe('available-limit');
  });

  it('가입 시 이 기기의 계정 없는 기존 기록(학교·이름 일치)만 연결해 보존, 이후 복구 코드·이름 입장으로 우회 불가', async () => {
    const e = await newExam(env, { questionCount: 2 });
    const dev = device('legacy');
    const old = await enter(env.ctx, e.slug, dev, '이도윤', '송도고');
    const other = await enter(env.ctx, e.slug, dev, '이도윤', '다른고'); // 학교가 다르면 연결 안 됨
    env.advance(1000);
    await enter(env.ctx, e.slug, dev, '이도윤', '송도고');
    const s = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() });
    await playAttempt(env, s.attemptId, dev, 2);
    const su = await signup(env.ctx, e.slug, dev, '10.0.1.1', { school: '송도 고', name: '이도윤', username: 'doyoon', password: pw });
    expect(su.res.student.studentId).toBe(old.student.studentId);
    expect(su.res.me.quest.completedSteps).toBe(1); // 기존 PASS·미션 유지
    expect((await records(env.ctx, e.slug, su.token)).rounds).toHaveLength(1);
    expect((await result(env.ctx, s.attemptId, su.token)).studentName).toBe('이도윤');
    await expectAppError(result(env.ctx, s.attemptId, dev), 'NOT_FOUND'); // 옛 기기 연결은 끊김
    await expectAppError(recover(env.ctx, e.slug, device('x'), old.recoveryCode!), 'ACCOUNT_REQUIRED');
    const otherRow = await env.db.query<{ account_id: string | null }>('SELECT account_id FROM students WHERE id = $1', [other.student.studentId]);
    expect(otherRow.rows[0].account_id).toBeNull();
  });

  it('다른 시험 링크에서 로그인하면 그 시험 기록이 따로 생기고, 기록은 섞이지 않는다', async () => {
    const e1 = await newExam(env, { questionCount: 1 });
    const e2 = await newExam(env, { questionCount: 1 });
    const su = await signup(env.ctx, e1.slug, device('m'), '10.0.2.1', { school: 'A고', name: '최유나', username: 'yuna.c', password: pw });
    const l2 = await login(env.ctx, e2.slug, su.token, '10.0.2.1', { username: 'yuna.c', password: pw });
    expect(l2.res.student.studentId).not.toBe(su.res.student.studentId);
    expect(l2.res.student).toMatchObject({ school: 'A고', name: '최유나', username: 'yuna.c' });
    const again = await login(env.ctx, e2.slug, l2.token, '10.0.2.1', { username: 'yuna.c', password: pw });
    expect(again.res.student.studentId).toBe(l2.res.student.studentId);
  });

  it('로그인 실패 10번이면 그 아이디는 잠시 잠김, 운영자 초기화는 임시 비밀번호 + 기존 세션 폐기', async () => {
    const e = await newExam(env);
    const su = await signup(env.ctx, e.slug, device('rl'), '10.0.3.1', { school: 'B고', name: '정하린', username: 'harin', password: pw });
    for (let i = 0; i < 10; i++) await expectAppError(login(env.ctx, e.slug, device('rl'), `10.0.4.${i}`, { username: 'harin', password: `wrong-${i}-xx` }), 'LOGIN_FAILED');
    await expectAppError(login(env.ctx, e.slug, device('rl'), '10.0.5.1', { username: 'harin', password: pw }), 'RATE_LIMITED');
    env.advance(11 * 60 * 1000);
    const ok = await login(env.ctx, e.slug, device('rl'), '10.0.5.1', { username: 'harin', password: pw });
    const { tempPassword } = await resetPassword(env.ctx, 'HARIN');
    expect(tempPassword).toHaveLength(12);
    expect(await currentStudentOf(e.slug, ok.token)).toBeNull();
    expect(await currentStudentOf(e.slug, su.token)).toBeNull();
    await expectAppError(login(env.ctx, e.slug, device('rl'), '10.0.5.1', { username: 'harin', password: pw }), 'LOGIN_FAILED');
    const nt = await login(env.ctx, e.slug, device('rl'), '10.0.5.1', { username: 'harin', password: tempPassword });
    expect(nt.res.student.username).toBe('harin');
  });
});

describe('계정 시도 제한 (동시 요청)', () => {
  it('같은 아이디로 동시에 15번 틀려도 10번만 비밀번호 비교, 나머지는 429 · 성공한 로그인은 횟수에서 빠짐', async () => {
    const e = await newExam(env);
    const pass = 'burst-pass-1';
    await signup(env.ctx, e.slug, device('bu'), '10.30.0.1', { school: 'C고', name: '한결', username: 'burst01', password: pass });
    const settled = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) => login(env.ctx, e.slug, device('bu'), `10.30.1.${i}`, { username: 'burst01', password: `wrong-${i}-zz` })),
    );
    const codes = settled.map((s) => (s.status === 'rejected' ? (s.reason as AppError).code : 'OK'));
    expect(codes.filter((c) => c === 'LOGIN_FAILED')).toHaveLength(10);
    expect(codes.filter((c) => c === 'RATE_LIMITED')).toHaveLength(5);

    const e2 = await newExam(env);
    await signup(env.ctx, e2.slug, device('bu'), '10.30.2.1', { school: 'C고', name: '한결', username: 'burst02', password: pass });
    for (let i = 0; i < 9; i++) await expectAppError(login(env.ctx, e2.slug, device('bu'), '10.30.3.1', { username: 'burst02', password: `nope-${i}-zz` }), 'LOGIN_FAILED');
    for (let i = 0; i < 3; i++) await login(env.ctx, e2.slug, device('bu'), '10.30.3.1', { username: 'burst02', password: pass }); // 성공은 횟수 미포함
    await expectAppError(login(env.ctx, e2.slug, device('bu'), '10.30.3.1', { username: 'burst02', password: 'nope-last-zz' }), 'LOGIN_FAILED'); // 10번째 실패
    await expectAppError(login(env.ctx, e2.slug, device('bu'), '10.30.3.1', { username: 'burst02', password: pass }), 'RATE_LIMITED');
  });
});

async function currentStudentOf(slug: string, token: string) {
  const { currentStudent } = await import('../src/server/identity');
  const exam = await getExamBySlug(env.db, slug);
  return currentStudent(env.db, token, exam.id);
}

describe('My Record·성적표 재현', () => {
  it('오늘(KST) 종료된 정규 회차만 집계하고, 진행 중 회차는 제외한다', async () => {
    const e = await newExam(env, { questionCount: 2, questStart: null, questEnd: null });
    const dev = device();
    env.setNow('2026-11-27T14:58:00.000Z'); // 11/27 23:58 KST
    await enterAndPlay(env, e.slug, dev, '기록', 2); // 어제 PASS (KST 11/27)
    env.setNow('2026-11-27T15:00:30.000Z'); // 11/28 00:00:30 KST
    await enterAndPlay(env, e.slug, dev, '기록', 0); // 오늘 FAIL
    const s = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() }); // 진행 중
    await nextQuestion(env.ctx, s.attemptId, dev);
    const rec = await records(env.ctx, e.slug, dev);
    expect(rec.today).toEqual({ date: '2026-11-28', attempts: 1, pass: 0, fail: 1, quit: 0 });
    expect(rec.rounds).toHaveLength(3);
    expect(rec.rounds[0].status).toBe('in_progress');
    await quit(env.ctx, s.attemptId, dev);
    env.setNow('2026-11-27T01:00:00.000Z');
  });

  it('단어장이 바뀌어도 예전 성적표의 문항·보기·정답은 그대로 재현된다', async () => {
    const e = await newExam(env, { questionCount: 3 });
    const dev = device();
    const { attemptId } = await enterAndPlay(env, e.slug, dev, '재현', 0);
    const before = await result(env.ctx, attemptId, dev);
    const ids = await env.db.query<{ word_id: number }>('SELECT word_id FROM attempt_questions WHERE attempt_id = $1', [attemptId]);
    await env.db.query(`UPDATE words SET meaning = meaning || ' (수정됨)' WHERE id = ANY(SELECT (x)::int FROM jsonb_array_elements_text($1::jsonb) x)`, [JSON.stringify(ids.rows.map((r) => r.word_id))]);
    const after = await result(env.ctx, attemptId, dev);
    expect(after.wrongs).toEqual(before.wrongs);
    await env.db.query(`UPDATE words SET meaning = replace(meaning, ' (수정됨)', '')`);
  });

  it('시험 설정에서 문항 수를 바꾸면 다음 회차부터 적용된다', async () => {
    const e = await newExam(env, { questionCount: 20 });
    await updateExam(env.ctx, e.slug, { questionCount: 5 });
    const dev = device();
    await enter(env.ctx, e.slug, dev, '설정');
    const s = await startAttempt(env.ctx, e.slug, dev, { unitFrom: 1, unitTo: 1, clientRequestId: reqId() });
    expect(s.totalQuestions).toBe(5);
    await quit(env.ctx, s.attemptId, dev);
  });
});
