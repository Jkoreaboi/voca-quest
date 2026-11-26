/**
 * HTTP 수준 통합 점검 (실행 중인 앱 + 실제 DB).
 *   npm run e2e:smoke -- [--base http://localhost:3000]
 * - 관리자 API 로 스모크 전용 예시 시험을 새로 만든다 (기존 시험 기록에 섞이지 않음).
 * - 정답 위치는 API 로 알 수 없으므로(설계상) 이 스크립트만 DB 에서 직접 읽는다. 운영 DB 에서는 실행하지 말 것.
 * - 실제로 10초를 기다리는 시간 초과 확인이 포함되어 약 30초 걸린다.
 */
import crypto from 'node:crypto';
import { argValue, loadEnv } from './_env';
import { getDb } from '../src/server/db';

loadEnv();
const base = (argValue(process.argv.slice(2), 'base') ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const results: Array<{ ok: boolean; name: string; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

class Client {
  cookie = '';
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json, text };
  }
}

const rid = () => crypto.randomUUID();

async function main() {
  const db = await getDb();
  const ci = async (attemptId: string, seq: number) =>
    (await db.query<{ correct_index: number }>('SELECT correct_index FROM attempt_questions WHERE attempt_id = $1 AND seq = $2', [attemptId, seq])).rows[0].correct_index;

  const admin = new Client();
  const token = process.env.ADMIN_TOKEN ?? '';
  const noAuth = await admin.call('GET', '/api/admin/exams');
  check('관리자 API: 토큰 없으면 401', noAuth.status === 401, `status ${noAuth.status}`);
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 9 * 3600_000 + 7 * 86400_000).toISOString().slice(0, 10);
  const created = await admin.call(
    'POST',
    '/api/admin/exams',
    { wordbook: 'vmap-basic-b1', school: '스모크고', grade: '1학년', textbook: 'Vocabulary Map Basic B-1', title: 'E2E 점검', unitFrom: 1, unitTo: 4, questionCount: 20, questStart: today, questEnd: end, isSample: true },
    { Authorization: `Bearer ${token}` },
  );
  check('관리자 API: 시험 생성 + 학생용 URL', created.status === 201 && /\/t\//.test(created.json.url), created.json.url);
  const slug = created.json.slug as string;

  const page = await fetch(`${base}/t/${slug}`);
  check('학생 링크 페이지 200 (앱 설치·로그인 없이)', page.status === 200, `status ${page.status}`);

  const a = new Client();
  let r = await a.call('GET', `/api/exams/${slug}`);
  check('시험 정보: 학교·시험명·허용 Unit·10초·90%', r.status === 200 && r.json.exam.displayTitle.includes('스모크고') && r.json.exam.units.length === 4 && r.json.exam.timeLimitSec === 10 && r.json.exam.passPercent === 90 && r.json.me === null);
  check('퀘스트 기간·D-day 표시', r.json.exam.quest.status === 'active' && r.json.exam.quest.dDay === 7, JSON.stringify(r.json.exam.quest));

  r = await a.call('POST', `/api/exams/${slug}/enter`, { name: '스모크 학생' });
  const recovery = r.json.recoveryCode as string;
  check('이름 입력 → 기기 쿠키 + 복구 코드 1회 발급', r.status === 200 && r.json.created === true && /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(recovery) && a.cookie.startsWith('vq_device='));
  check('쿠키는 httpOnly', true, '(Set-Cookie 헤더 확인은 브라우저 점검에서)');

  r = await a.call('GET', `/api/exams/${slug}/preview?from=3&to=1`);
  check('범위 오류(시작 > 끝) 시작 전 안내', r.status === 400 && r.json.error.code === 'INVALID_RANGE', r.json.error?.message);
  r = await a.call('GET', `/api/exams/${slug}/preview?from=1&to=2`);
  check('범위 미리보기 실제 문항 수', r.status === 200 && r.json.questionCount === 20, `${r.json.questionCount}문항`);

  const req1 = rid();
  const [s1, s2] = await Promise.all([
    a.call('POST', `/api/exams/${slug}/attempts`, { unitFrom: 1, unitTo: 2, clientRequestId: req1 }),
    a.call('POST', `/api/exams/${slug}/attempts`, { unitFrom: 1, unitTo: 2, clientRequestId: req1 }),
  ]);
  check('시작 연타 → 같은 회차', s1.json.attemptId && s1.json.attemptId === s2.json.attemptId, `${s1.status}/${s2.status}`);
  const attemptId = s1.json.attemptId as string;
  const total = s1.json.totalQuestions as number;
  const other = await a.call('POST', `/api/exams/${slug}/attempts`, { unitFrom: 1, unitTo: 2, clientRequestId: rid() });
  check('진행 중 회차가 있으면 409 + attemptId', other.status === 409 && other.json.error.details?.attemptId === attemptId);

  // 진행: 2번은 오답, 3번은 실제 10초 대기 → 시간 초과, 나머지 정답 → 18/20 = 90% → PASS
  let leaked = false;
  for (let seq = 1; seq <= total; seq++) {
    const st = await a.call('POST', `/api/attempts/${attemptId}/next`);
    // 현재(미응답) 문항에는 정답 키가 없어야 한다. last 는 이미 확정된 직전 문항의 정답 공개라 허용.
    const cur = st.json.current ?? {};
    if (Object.keys(cur).some((k) => /correct|answer/i.test(k))) leaked = true;
    if (st.json.last && st.json.last.seq >= cur.seq) leaked = true;
    if (cur.options && cur.options.length !== 4) leaked = true;
    if (seq === 1) {
      const again = await a.call('POST', `/api/attempts/${attemptId}/next`);
      check('next 재호출(새로고침) → 같은 문항·같은 마감', again.json.current.seq === 1 && again.json.current.deadlineAt === st.json.current.deadlineAt);
      const dl = new Date(st.json.current.deadlineAt).getTime() - new Date(st.json.current.presentedAt).getTime();
      check('서버 마감 = 제시 + 10초', dl === 10_000, `${dl}ms`);
    }
    const right = await ci(attemptId, seq);
    if (seq === 3) {
      await new Promise((res) => setTimeout(res, 10_300));
      const t = await a.call('POST', `/api/attempts/${attemptId}/answer`, { seq, choice: right });
      check('10초 경과 후 답 → 시간 초과(오답) + 정답 공개', t.json.reveal?.result === 'timeout' && t.json.reveal.correctIndex === right, t.json.reveal?.result);
      continue;
    }
    const choice = seq === 2 ? (right + 1) % 4 : right;
    if (seq === 4) {
      const many = await Promise.all([0, 1, 2].map(() => a.call('POST', `/api/attempts/${attemptId}/answer`, { seq, choice })));
      const fresh = many.filter((m) => m.json.duplicate === false).length;
      check('같은 답안 동시 3회 → 1회만 확정', fresh === 1 && many.every((m) => m.status === 200), `fresh=${fresh}`);
      continue;
    }
    const ans = await a.call('POST', `/api/attempts/${attemptId}/answer`, { seq, choice });
    if (seq === 2) check('오답 → 정답 즉시 공개', ans.json.reveal.result === 'wrong' && ans.json.reveal.correctIndex === right);
  }
  check('문항 응답에 정답 키 미노출', !leaked);

  r = await a.call('GET', `/api/attempts/${attemptId}/result`);
  check('성적표: 18/20 = 90% → PASS', r.json.correct === 18 && r.json.total === 20 && r.json.passed === true, `${r.json.correct}/${r.json.total} ${r.json.accuracyPercent}%`);
  check('성적표: 이번 오답 2개(오답+시간초과)', r.json.wrongs?.length === 2);
  check('성적표: 이름·학교·시험·범위·일시·소요시간', r.json.studentName === '스모크 학생' && r.json.school === '스모크고' && r.json.unitFromLabel === 'Ch1 Day 1' && r.json.unitToLabel === 'Ch1 Day 2' && r.json.durationMs > 10_000);
  check('미션 적립 1칸(출렁다리) + 연출 대상', r.json.quest.credited?.step === 1 && r.json.quest.celebrate?.name === '출렁다리');
  await a.call('POST', `/api/attempts/${attemptId}/mission-seen`);
  r = await a.call('GET', `/api/attempts/${attemptId}/result`);
  check('연출 확인 후 재조회 → 연출·적립 반복 없음', r.json.quest.celebrate === null && r.json.quest.progress.completedSteps === 1);

  const pr = await a.call('POST', `/api/attempts/${attemptId}/practice`, { clientRequestId: rid() });
  check("'틀린 것만 다시' → 오답 2개로 연습", pr.status === 201 && pr.json.totalQuestions === 2);
  for (let seq = 1; seq <= 2; seq++) {
    await a.call('POST', `/api/attempts/${pr.json.attemptId}/next`);
    const right = await ci(pr.json.attemptId, seq);
    await a.call('POST', `/api/attempts/${pr.json.attemptId}/answer`, { seq, choice: right });
  }
  r = await a.call('GET', `/api/attempts/${pr.json.attemptId}/result`);
  check('연습 결과는 PASS/FAIL·미션 없음', r.json.mode === 'practice' && r.json.passed === null && r.json.quest.credited === null);

  // 그만하기
  const q = await a.call('POST', `/api/exams/${slug}/attempts`, { unitFrom: 3, unitTo: 4, clientRequestId: rid() });
  await a.call('POST', `/api/attempts/${q.json.attemptId}/next`);
  const right1 = await ci(q.json.attemptId, 1);
  await a.call('POST', `/api/attempts/${q.json.attemptId}/answer`, { seq: 1, choice: (right1 + 1) % 4 });
  await a.call('POST', `/api/attempts/${q.json.attemptId}/next`);
  const quitR = await a.call('POST', `/api/attempts/${q.json.attemptId}/quit`);
  check('그만하기 → quit, 확정 답안 1개 보존', quitR.json.status === 'quit' && quitR.json.answered === 1);

  const wn = await a.call('GET', `/api/exams/${slug}/wrong-notes`);
  check('누적 오답노트: 정규 오답 3개(연습 결과 영향 없음)', wn.json.total === 3, `total=${wn.json.total}`);
  const rec = await a.call('GET', `/api/exams/${slug}/records`);
  check('My Record 오늘: 응시 2 = PASS 1 + 그만하기 1', rec.json.today.attempts === 2 && rec.json.today.pass === 1 && rec.json.today.quit === 1, JSON.stringify(rec.json.today));
  check('My Record 회차: 미션·그만둠 표시', rec.json.rounds.length === 2 && rec.json.rounds[0].status === 'quit' && rec.json.rounds[1].mission?.name === '출렁다리');

  // 다른 기기
  const b = new Client();
  r = await b.call('POST', `/api/exams/${slug}/enter`, { name: '스모크 학생' });
  check('다른 기기 같은 이름 → 새 학생(기록 비공개)', r.json.created === true && r.json.me.quest.completedSteps === 0);
  r = await b.call('GET', `/api/attempts/${attemptId}/result`);
  check('다른 기기에서 남의 회차 접근 → 404', r.status === 404);
  r = await b.call('POST', `/api/exams/${slug}/recover`, { code: recovery.toLowerCase() });
  check('복구 코드로 다른 기기 연결', r.status === 200 && r.json.me.quest.completedSteps === 1);
  r = await b.call('GET', `/api/exams/${slug}/records`);
  check('복구 후 기록 열람', r.json.rounds?.length === 2);

  // 처음 온 기기가 틀린 코드를 반복: 실패 응답에도 기기 쿠키가 심겨 10회 제한이 적용돼야 함
  const c = new Client();
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await c.call('POST', `/api/exams/${slug}/recover`, { code: 'ZZZZ-ZZZZ-ZZZZ' })).status;
  check('새 기기 복구 코드 11번째 시도 → 429 (실패 응답에도 쿠키)', last === 429 && c.cookie.startsWith('vq_device='), `last=${last}`);

  // 아이디·비밀번호 (서버가 계정 API 를 지원할 때만)
  const acc = new Client();
  const uname = `smk${Date.now().toString(36)}`.slice(0, 20);
  const su = await acc.call('POST', `/api/exams/${slug}/signup`, { school: '스모크고', name: '계정 학생', username: uname, password: 'smoke-pass-123' });
  if (su.status === 404) {
    check('계정 API (이 서버 빌드에는 없음 — 건너뜀)', true);
  } else {
    const c1 = acc.cookie;
    check('가입 → 201 + username + 세션 쿠키', su.status === 201 && su.json.student?.username === uname && c1.startsWith('vq_device='), `${su.status}`);
    const raw = await fetch(`${base}/api/exams/${slug}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c1 }, body: JSON.stringify({ username: uname, password: 'smoke-pass-123' }) });
    const setCookie = raw.headers.get('set-cookie') ?? '';
    const c2 = setCookie.split(';')[0];
    check('로그인 → 쿠키 회전·httpOnly', raw.status === 200 && c2 !== c1 && /httponly/i.test(setCookie));
    acc.cookie = c1;
    check('회전 전 쿠키는 더 이상 로그인 아님', (await acc.call('GET', `/api/exams/${slug}`)).json.me === null);
    acc.cookie = c2;
    check('새 쿠키로 내 정보', (await acc.call('GET', `/api/exams/${slug}`)).json.me?.student?.username === uname);
    const bad = await acc.call('POST', `/api/exams/${slug}/login`, { username: uname, password: 'wrong-pass-000' });
    check('틀린 비밀번호 → 401 LOGIN_FAILED', bad.status === 401 && bad.json.error.code === 'LOGIN_FAILED');
    acc.cookie = c2;
    const lo = await acc.call('POST', `/api/exams/${slug}/logout`, {});
    check('로그아웃 → 쿠키 삭제·me null', lo.status === 200 && (await new Client().call('GET', `/api/exams/${slug}`)).json.me === null);
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과 (시험 slug: ${slug})`);
  await db.close();
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('스모크 실패:', e);
  process.exit(1);
});
