/**
 * 학생 식별. 계정·로그인 없이:
 *  - 기기(브라우저)마다 httpOnly 쿠키 토큰 → DB 에는 HMAC 해시만 저장
 *  - 같은 기기 + 같은 시험 + 같은 학교 + 같은 이름 → 기존 학생 기록으로 이어감 (학교가 다른 동명이인은 별개)
 *  - 다른 기기 → 복구 코드(60비트, 원문 미저장)로만 연결. 같은 이름만으로는 남의 기록을 열지 않음
 */
import crypto from 'node:crypto';
import type { EnterResponse, MeInfo, RecoverResponse, StudentSummary } from '../shared/api';
import type { Queryable } from './db';
import { AppError, hashDeviceToken, hashRecoveryCode, hmac, isUniqueViolation, newRecoveryCode, nowOf, type Ctx } from './context';
import { getExamBySlug, type ExamRow } from './exams';
import { cleanDisplay, nameKey } from './normalize';
import { questProgress } from './quest';

export interface StudentRow {
  id: string;
  exam_id: number;
  display_name: string;
  name_key: string;
  school: string;
  school_key: string;
  account_id: string | null;
  username: string | null;
}

/**
 * 학교가 비어 있는 학생(이전 코드가 만든 행)은 시험 학교로 읽는다.
 * STUDENT_COLS 는 반드시 `JOIN exams e ON e.id = s.exam_id LEFT JOIN accounts a ON a.id = s.account_id` 와 함께 쓴다 (STUDENT_JOIN).
 */
const SCHOOL_KEY_SQL = `COALESCE(s.school_key, lower(regexp_replace(e.school, '\\s+', '', 'g')))`;
const STUDENT_COLS = `s.id, s.exam_id, s.display_name, s.name_key, COALESCE(s.school, e.school) AS school, ${SCHOOL_KEY_SQL} AS school_key, s.account_id, a.username`;
const STUDENT_JOIN = 'JOIN exams e ON e.id = s.exam_id LEFT JOIN accounts a ON a.id = s.account_id';

export function accountRequired(): AppError {
  return new AppError('ACCOUNT_REQUIRED', 409, '아이디로 로그인해 주세요.');
}

export interface SessionAccount {
  id: string;
  username: string;
  school: string;
  school_key: string;
  display_name: string;
  name_key: string;
}

/** 유효한 로그인 세션의 계정 (없으면 null) */
export async function sessionAccount(q: Queryable, token: string | null | undefined): Promise<SessionAccount | null> {
  if (!token) return null;
  const r = await q.query<SessionAccount>(
    `SELECT a.id, a.username, a.school, a.school_key, a.display_name, a.name_key
       FROM sessions se JOIN accounts a ON a.id = se.account_id
      WHERE se.token_hash = $1 AND se.revoked_at IS NULL AND se.expires_at > now()`,
    [hashDeviceToken(token)],
  );
  return r.rows[0] ?? null;
}

/** 계정의 이 시험 학생 기록 (없으면 가입 정보로 생성, 동시 요청에도 1개) */
export async function ensureExamStudent(q: Queryable, examId: number, acc: SessionAccount): Promise<StudentRow> {
  const find = () =>
    q.query<StudentRow>(`SELECT ${STUDENT_COLS} FROM students s ${STUDENT_JOIN} WHERE s.exam_id = $1 AND s.account_id = $2`, [examId, acc.id]);
  const found = await find();
  if (found.rows[0]) return found.rows[0];
  await q.query(
    `INSERT INTO students (id, exam_id, display_name, name_key, school, school_key, recovery_code_hash, account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (exam_id, account_id) WHERE account_id IS NOT NULL DO NOTHING`,
    [crypto.randomUUID(), examId, acc.display_name, acc.name_key, acc.school, acc.school_key, hmac(`account-student:${crypto.randomUUID()}`), acc.id],
  );
  return (await find()).rows[0];
}

/**
 * 학생 학교. 생략(undefined/null, 구 클라이언트)이면 시험(링크)의 학교를 쓴다.
 * 명시한 빈 값·60자 초과·부적절한 문자는 거부. 시험의 설정 학교는 바뀌지 않는다.
 */
export function validateSchool(raw: unknown, examSchool: string): string {
  if (raw === undefined || raw === null) return cleanDisplay(examSchool);
  const school = cleanDisplay(String(raw));
  if (!school) throw new AppError('BAD_REQUEST', 400, '학교를 입력해 주세요.');
  if ([...school].length > 60) throw new AppError('BAD_REQUEST', 400, '학교 이름은 60자 이내로 입력해 주세요.');
  if (/[\u0000-\u001f<>{}\\]/.test(school)) throw new AppError('BAD_REQUEST', 400, '학교 이름에 쓸 수 없는 문자가 있어요.');
  return school;
}

/** 학교 비교 키 (공백 무시, 소문자) — migration 004 백필과 같은 규칙 */
export const schoolKey = nameKey;

export function validateName(raw: unknown): string {
  const name = cleanDisplay(String(raw ?? ''));
  if (!name) throw new AppError('BAD_REQUEST', 400, '이름을 입력해 주세요.');
  if ([...name].length > 20) throw new AppError('BAD_REQUEST', 400, '이름은 20자 이내로 입력해 주세요.');
  if (/[\u0000-\u001f<>]/.test(name)) throw new AppError('BAD_REQUEST', 400, '이름에 쓸 수 없는 문자가 있어요.');
  return name;
}

/**
 * 이 브라우저에서 이 시험의 현재 학생.
 * 1) 로그인 세션이 있으면 그 계정의 학생(없으면 생성) 2) 아니면 계정 없는 기존 학생의 기기 연결(가장 최근)
 */
export async function currentStudent(q: Queryable, deviceToken: string | null | undefined, examId: number): Promise<StudentRow | null> {
  if (!deviceToken) return null;
  const acc = await sessionAccount(q, deviceToken);
  if (acc) return ensureExamStudent(q, examId, acc);
  const r = await q.query<StudentRow>(
    `SELECT ${STUDENT_COLS}
       FROM device_students d JOIN students s ON s.id = d.student_id ${STUDENT_JOIN}
      WHERE d.device_hash = $1 AND d.exam_id = $2 AND s.account_id IS NULL
      ORDER BY d.last_used_at DESC LIMIT 1`,
    [hashDeviceToken(deviceToken), examId],
  );
  return r.rows[0] ?? null;
}

export async function requireStudent(q: Queryable, deviceToken: string | null | undefined, exam: ExamRow): Promise<StudentRow> {
  const s = await currentStudent(q, deviceToken, exam.id);
  if (!s) throw new AppError('NO_STUDENT', 401, '먼저 이름을 입력해 주세요.');
  return s;
}

/** 이 기기에 연결된 학생인지 (회차 접근 권한 확인용) */
export async function deviceOwnsStudent(q: Queryable, deviceToken: string | null | undefined, studentId: string): Promise<boolean> {
  if (!deviceToken) return false;
  const h = hashDeviceToken(deviceToken);
  const r = await q.query(
    `SELECT 1 FROM students s
      WHERE s.id = $2 AND (
        (s.account_id IS NULL AND EXISTS (SELECT 1 FROM device_students d WHERE d.device_hash = $1 AND d.student_id = s.id))
        OR EXISTS (SELECT 1 FROM sessions se WHERE se.token_hash = $1 AND se.account_id = s.account_id AND se.revoked_at IS NULL AND se.expires_at > now())
      )`,
    [h, studentId],
  );
  return r.rowCount > 0;
}

export const summary = (s: StudentRow): StudentSummary => ({ studentId: s.id, name: s.display_name, school: s.school, username: s.username ?? null });

export async function meInfo(ctx: Ctx, q: Queryable, exam: ExamRow, s: StudentRow): Promise<MeInfo> {
  const ip = await q.query<{ id: string; mode: 'regular'; answered_count: number; total_questions: number; unit_from_label: string; unit_to_label: string; started_at: Date }>(
    `SELECT id, mode, answered_count, total_questions, unit_from_label, unit_to_label, started_at
       FROM attempts WHERE student_id = $1 AND mode = 'regular' AND status = 'in_progress' LIMIT 1`,
    [s.id],
  );
  const wn = await q.query<{ n: number }>(
    `SELECT count(DISTINCT aq.word_key)::int AS n
       FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id
      WHERE a.student_id = $1 AND a.mode = 'regular' AND a.status IN ('completed','quit') AND aq.result IN ('wrong','timeout')`,
    [s.id],
  );
  const a = ip.rows[0];
  return {
    student: summary(s),
    quest: await questProgress(q, exam, s.id, nowOf(ctx)),
    inProgress: a
      ? { attemptId: a.id, mode: a.mode, answered: a.answered_count, total: a.total_questions, unitFromLabel: a.unit_from_label, unitToLabel: a.unit_to_label, startedAt: a.started_at.toISOString() }
      : null,
    wrongNoteCount: wn.rows[0].n,
  };
}

async function touchLink(q: Queryable, deviceHash: string, studentId: string, examId: number, now: Date) {
  await q.query(
    `INSERT INTO device_students (device_hash, student_id, exam_id, linked_at, last_used_at) VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (device_hash, student_id) DO UPDATE SET last_used_at = EXCLUDED.last_used_at`,
    [deviceHash, studentId, examId, now],
  );
}

export async function enter(ctx: Ctx, slug: string, deviceToken: string, rawName: unknown, rawSchool?: unknown): Promise<EnterResponse> {
  const name = validateName(rawName);
  const nk = nameKey(name);
  const now = nowOf(ctx);
  const deviceHash = hashDeviceToken(deviceToken);
  return ctx.db.tx(async (q) => {
    const exam = await getExamBySlug(q, slug);
    const school = validateSchool(rawSchool, exam.school);
    const sk = schoolKey(school);
    // 로그인 중이면 이름 입장(기기 연결)을 쓰지 않는다
    if (await sessionAccount(q, deviceToken)) throw new AppError('ACCOUNT_REQUIRED', 409, '이미 로그인되어 있어요. 다른 학생으로 들어가려면 로그아웃해 주세요.');
    // 같은 기기·시험·학교·이름의 동시 입장(두 탭, 연타)이 서로 다른 학생을 만들지 않도록 직렬화
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`enter:${deviceHash}:${exam.id}:${sk}:${nk}`]);
    const found = await q.query<StudentRow>(
      `SELECT ${STUDENT_COLS}
         FROM device_students d JOIN students s ON s.id = d.student_id ${STUDENT_JOIN}
        WHERE d.device_hash = $1 AND d.exam_id = $2 AND s.name_key = $3 AND ${SCHOOL_KEY_SQL} = $4
        ORDER BY d.last_used_at DESC LIMIT 1`,
      [deviceHash, exam.id, nk, sk],
    );
    if (found.rows[0]?.account_id) throw accountRequired();
    if (found.rows[0]) {
      await touchLink(q, deviceHash, found.rows[0].id, exam.id, now);
      return { student: summary(found.rows[0]), created: false, recoveryCode: null, me: await meInfo(ctx, q, exam, found.rows[0]) };
    }
    // 새 학생 (동명이인·다른 기기의 같은 이름과도 기록을 섞지 않음)
    for (let i = 0; i < 5; i++) {
      const code = newRecoveryCode();
      const s: StudentRow = { id: crypto.randomUUID(), exam_id: exam.id, display_name: name, name_key: nk, school, school_key: sk, account_id: null, username: null };
      try {
        await q.query('SAVEPOINT new_student');
        await q.query(
          'INSERT INTO students (id, exam_id, display_name, name_key, school, school_key, recovery_code_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [s.id, exam.id, name, nk, school, sk, hashRecoveryCode(code), now],
        );
        await q.query('RELEASE SAVEPOINT new_student');
      } catch (e) {
        await q.query('ROLLBACK TO SAVEPOINT new_student');
        if (isUniqueViolation(e)) continue; // 복구 코드 해시 충돌(극히 드묾) → 재시도
        throw e;
      }
      await touchLink(q, deviceHash, s.id, exam.id, now);
      return { student: summary(s), created: true, recoveryCode: code, me: await meInfo(ctx, q, exam, s) };
    }
    throw new AppError('INTERNAL', 500, '잠시 후 다시 시도해 주세요.');
  });
}

const RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const RECOVERY_MAX_FAILS = 10; // 기기당
const RECOVERY_MAX_FAILS_PER_IP = 60; // 학교 와이파이처럼 여러 학생이 한 IP 를 쓰는 경우를 고려해 넉넉히

export async function recover(ctx: Ctx, slug: string, deviceToken: string, code: unknown, ip = 'unknown'): Promise<RecoverResponse> {
  const now = nowOf(ctx);
  const deviceHash = hashDeviceToken(deviceToken);
  const ipHash = hmac(`ip:${ip}`);
  const exam = await getExamBySlug(ctx.db, slug);
  if (await sessionAccount(ctx.db, deviceToken)) throw new AppError('ACCOUNT_REQUIRED', 409, '이미 로그인되어 있어요. 다른 학생으로 들어가려면 로그아웃해 주세요.');
  const since = new Date(now.getTime() - RECOVERY_WINDOW_MS);
  const fails = await ctx.db.query<{ dev: number; ip: number }>(
    `SELECT count(*) FILTER (WHERE device_hash = $1)::int AS dev, count(*) FILTER (WHERE ip_hash = $2)::int AS ip
       FROM recovery_failures WHERE failed_at > $3 AND (device_hash = $1 OR ip_hash = $2)`,
    [deviceHash, ipHash, since],
  );
  if (fails.rows[0].dev >= RECOVERY_MAX_FAILS || fails.rows[0].ip >= RECOVERY_MAX_FAILS_PER_IP) {
    throw new AppError('RATE_LIMITED', 429, '복구 코드를 너무 여러 번 틀렸어요. 10분 뒤에 다시 시도해 주세요.');
  }
  const r = await ctx.db.query<StudentRow>(
    `SELECT ${STUDENT_COLS} FROM students s ${STUDENT_JOIN} WHERE s.recovery_code_hash = $1 AND s.exam_id = $2`,
    [hashRecoveryCode(String(code ?? '')), exam.id],
  );
  const s = r.rows[0];
  if (s?.account_id) throw accountRequired(); // 계정 학생은 복구 코드로 우회 불가
  if (!s) {
    await ctx.db.query('INSERT INTO recovery_failures (device_hash, ip_hash, failed_at) VALUES ($1, $2, $3)', [deviceHash, ipHash, now]);
    throw new AppError('RECOVERY_FAILED', 400, '복구 코드가 맞지 않아요. 이 시험에서 받은 코드인지 확인해 주세요.');
  }
  return ctx.db.tx(async (q) => {
    await touchLink(q, deviceHash, s.id, exam.id, now);
    return { student: summary(s), me: await meInfo(ctx, q, exam, s) };
  });
}

export async function reissueRecoveryCode(ctx: Ctx, slug: string, deviceToken: string | null): Promise<{ recoveryCode: string }> {
  const exam = await getExamBySlug(ctx.db, slug);
  const s = await requireStudent(ctx.db, deviceToken, exam);
  if (s.account_id) throw accountRequired();
  for (let i = 0; i < 5; i++) {
    const code = newRecoveryCode();
    try {
      await ctx.db.query('UPDATE students SET recovery_code_hash = $2 WHERE id = $1', [s.id, hashRecoveryCode(code)]);
      return { recoveryCode: code };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new AppError('INTERNAL', 500, '잠시 후 다시 시도해 주세요.');
}
