/**
 * 아이디·비밀번호 계정 (모든 시험 공통).
 * - 비밀번호: scrypt(N=16384,r=8,p=1) + 16바이트 salt. 원문은 저장·로그하지 않는다.
 * - 세션: 로그인·가입 성공마다 새 토큰(쿠키 vq_device)으로 회전 → 이 브라우저의 이전 학생 연결은 남지 않음. 로그아웃은 폐기.
 * - 시도 제한: 로그인 실패(아이디 10·기기 20·IP 60회/10분), 가입(기기 10·IP 100회/10분). 로그인 실패 메시지는 항상 같다.
 * - 가입 시 이 기기의 '계정 없는 기존 학생' 중 학교·이름이 같은 기록(시험별 1개)만 계정에 연결해 기록을 보존한다.
 */
import crypto from 'node:crypto';
import type { AuthResponse, LogoutResponse } from '../shared/api';
import type { Queryable } from './db';
import { AppError, hashDeviceToken, hmac, newDeviceToken, nowOf, type Ctx } from './context';
import { getExamBySlug } from './exams';
import { ensureExamStudent, meInfo, schoolKey, sessionAccount, summary, validateName, validateSchool, type SessionAccount } from './identity';
import { nameKey } from './normalize';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 180;
const WINDOW_MS = 10 * 60 * 1000;
const LIMITS = { login_user: 10, login_device: 20, login_ip: 60, signup_device: 10, signup_ip: 100 } as const;
type Scope = keyof typeof LIMITS;

const LOGIN_FAILED = () => new AppError('LOGIN_FAILED', 401, '아이디 또는 비밀번호가 맞지 않아요.');

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password.normalize('NFC'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password.normalize('NFC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

let dummyHash: Promise<string> | null = null;
/** 없는 아이디에도 같은 시간이 걸리도록 비교할 가짜 해시 */
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')));

export function usernameKey(raw: unknown): string {
  return String(raw ?? '').normalize('NFKC').trim().toLowerCase();
}

export function validateUsername(raw: unknown): string {
  const u = usernameKey(raw);
  if (!/^[a-z0-9._-]{4,20}$/.test(u)) {
    throw new AppError('BAD_REQUEST', 400, '아이디는 영문 소문자·숫자·마침표(.)·밑줄(_)·하이픈(-)으로 4~20자 입력해 주세요.');
  }
  return u;
}

export function validatePassword(raw: unknown, username: string): string {
  const p = typeof raw === 'string' ? raw : '';
  const len = [...p].length;
  if (len < 8 || len > 64) throw new AppError('BAD_REQUEST', 400, '비밀번호는 8~64자로 입력해 주세요.');
  if (!p.trim()) throw new AppError('BAD_REQUEST', 400, '비밀번호는 공백만으로 만들 수 없어요.');
  if (p.toLowerCase() === username) throw new AppError('BAD_REQUEST', 400, '비밀번호는 아이디와 다르게 정해 주세요.');
  return p;
}

// ───────── 시도 제한 ─────────

async function countEvents(q: Queryable, scope: Scope, key: string, now: Date): Promise<number> {
  const r = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM auth_events WHERE scope = $1 AND key_hash = $2 AND at > $3', [
    scope, hmac(`${scope}:${key}`), new Date(now.getTime() - WINDOW_MS),
  ]);
  return r.rows[0].n;
}

async function recordEvents(q: Queryable, events: Array<[Scope, string]>, now: Date) {
  for (const [scope, key] of events) {
    await q.query('INSERT INTO auth_events (scope, key_hash, at) VALUES ($1, $2, $3)', [scope, hmac(`${scope}:${key}`), now]);
  }
}

async function assertUnderLimit(q: Queryable, checks: Array<[Scope, string]>, now: Date) {
  for (const [scope, key] of checks) {
    if ((await countEvents(q, scope, key, now)) >= LIMITS[scope]) {
      throw new AppError('RATE_LIMITED', 429, '시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요.');
    }
  }
}

// ───────── 세션 ─────────

async function newSession(q: Queryable, accountId: string, oldToken: string | null, now: Date): Promise<string> {
  if (oldToken) await q.query('UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [hashDeviceToken(oldToken), now]);
  const token = newDeviceToken();
  await q.query('INSERT INTO sessions (token_hash, account_id, created_at, last_used_at, expires_at) VALUES ($1, $2, $3, $3, $4)', [
    hashDeviceToken(token), accountId, now, new Date(now.getTime() + SESSION_DAYS * 86400000),
  ]);
  return token;
}

async function authResponse(ctx: Ctx, q: Queryable, slug: string, acc: SessionAccount): Promise<AuthResponse> {
  const exam = await getExamBySlug(q, slug);
  const s = await ensureExamStudent(q, exam.id, acc);
  return { student: summary(s), me: await meInfo(ctx, q, exam, s) };
}

// ───────── 가입·로그인·로그아웃 ─────────

export async function signup(
  ctx: Ctx,
  slug: string,
  device: string,
  ip: string,
  body: { school?: unknown; name?: unknown; username?: unknown; password?: unknown },
): Promise<{ res: AuthResponse; token: string }> {
  const now = nowOf(ctx);
  const username = validateUsername(body.username);
  const password = validatePassword(body.password, username);
  const name = validateName(body.name);
  const exam = await getExamBySlug(ctx.db, slug);
  const school = validateSchool(body.school ?? '', exam.school);
  // Commit the reservation before hashing/account creation so failed signup also consumes its limit.
  await ctx.db.tx(async (q) => {
    for (const key of [`signup-device:${device}`, `signup-ip:${ip}`].sort()) {
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    }
    await assertUnderLimit(q, [['signup_device', device], ['signup_ip', ip]], now);
    await recordEvents(q, [['signup_device', device], ['signup_ip', ip]], now);
  });
  const hash = await hashPassword(password);
  return ctx.db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`signup:${username}`]);
    if ((await q.query('SELECT 1 FROM accounts WHERE username_key = $1', [username])).rowCount > 0) {
      throw new AppError('USERNAME_TAKEN', 409, '이미 사용 중인 아이디예요. 다른 아이디를 입력해 주세요.');
    }
    const acc: SessionAccount = { id: crypto.randomUUID(), username, school, school_key: schoolKey(school), display_name: name, name_key: nameKey(name) };
    await q.query(
      `INSERT INTO accounts (id, username, username_key, password_hash, school, school_key, display_name, name_key, created_at, password_changed_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [acc.id, username, hash, school, acc.school_key, name, acc.name_key, now],
    );
    // 이 기기의 계정 없는 기존 학생 중 학교·이름이 같은 기록(시험별 최근 1개)을 계정에 연결 → 기록 보존
    const legacy = await q.query<{ id: string }>(
      `SELECT DISTINCT ON (s.exam_id) s.id
         FROM device_students d JOIN students s ON s.id = d.student_id JOIN exams e ON e.id = s.exam_id
        WHERE d.device_hash = $1 AND s.account_id IS NULL AND s.name_key = $2
          AND COALESCE(s.school_key, lower(regexp_replace(e.school, '\\s+', '', 'g'))) = $3
        ORDER BY s.exam_id, d.last_used_at DESC`,
      [hashDeviceToken(device), acc.name_key, acc.school_key],
    );
    for (const row of legacy.rows) {
      await q.query('UPDATE students SET account_id = $2, school = COALESCE(school, $3), school_key = COALESCE(school_key, $4) WHERE id = $1 AND account_id IS NULL', [
        row.id, acc.id, school, acc.school_key,
      ]);
      await q.query('DELETE FROM device_students WHERE student_id = $1', [row.id]); // 이후 로그인으로만 접근
    }
    const token = await newSession(q, acc.id, device, now);
    return { res: await authResponse(ctx, q, slug, acc), token };
  });
}

export async function login(
  ctx: Ctx,
  slug: string,
  device: string,
  ip: string,
  body: { username?: unknown; password?: unknown },
): Promise<{ res: AuthResponse; token: string }> {
  const now = nowOf(ctx);
  const username = usernameKey(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  await getExamBySlug(ctx.db, slug);
  const scopes: Array<[Scope, string]> = [['login_user', username], ['login_device', device], ['login_ip', ip]];
  // 동시 요청으로 제한을 넘지 못하도록: 잠금 안에서 확인 + 시도 기록을 먼저 커밋(해시 비교 전). 성공하면 이 시도 기록만 지운다.
  await ctx.db.tx(async (q) => {
    for (const [scope, key] of [...scopes].sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1))) {
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${scope}:${hmac(`${scope}:${key}`)}`]);
    }
    await assertUnderLimit(q, scopes, now);
    await recordEvents(q, scopes, now);
  });
  const r = await ctx.db.query<SessionAccount & { password_hash: string }>(
    'SELECT id, username, school, school_key, display_name, name_key, password_hash FROM accounts WHERE username_key = $1',
    [username],
  );
  const acc = r.rows[0];
  const validLength = password.length <= 128 && [...password].length >= 8 && [...password].length <= 64;
  const ok = await verifyPassword(validLength ? password : '', acc ? acc.password_hash : await getDummyHash());
  if (!acc || !ok || !validLength) throw LOGIN_FAILED(); // 시도 기록은 이미 남아 있음
  return ctx.db.tx(async (q) => {
    // 성공한 시도는 제한 횟수에서 뺀다 (방금 남긴 기록 1건씩)
    for (const [scope, key] of scopes) {
      await q.query(
        'DELETE FROM auth_events WHERE ctid IN (SELECT ctid FROM auth_events WHERE scope = $1 AND key_hash = $2 AND at = $3 LIMIT 1)',
        [scope, hmac(`${scope}:${key}`), now],
      );
    }
    const token = await newSession(q, acc.id, device, now);
    return { res: await authResponse(ctx, q, slug, acc), token };
  });
}

export async function logout(ctx: Ctx, device: string | null): Promise<LogoutResponse> {
  if (device) await ctx.db.query('UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [hashDeviceToken(device), nowOf(ctx)]);
  return { ok: true };
}

// ───────── 운영자 (CLI 전용) ─────────

const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 비밀번호 초기화: 임시 비밀번호(12자)를 만들어 돌려주고 기존 세션을 모두 폐기. 출력은 운영자 화면에서만 */
export async function resetPassword(ctx: Ctx, rawUsername: string): Promise<{ username: string; tempPassword: string }> {
  const username = usernameKey(rawUsername);
  const acc = (await ctx.db.query<{ id: string }>('SELECT id FROM accounts WHERE username_key = $1', [username])).rows[0];
  if (!acc) throw new AppError('NOT_FOUND', 404, `아이디 ${username} 계정이 없습니다.`);
  const bytes = crypto.randomBytes(12);
  const tempPassword = Array.from(bytes, (b) => TEMP_ALPHABET[b % TEMP_ALPHABET.length]).join('');
  const hash = await hashPassword(tempPassword);
  const now = nowOf(ctx);
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE accounts SET password_hash = $2, password_changed_at = $3 WHERE id = $1', [acc.id, hash, now]);
    await q.query('UPDATE sessions SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL', [acc.id, now]);
  });
  return { username, tempPassword };
}

/** 운영자: 학교·이름으로 아이디 찾기 (학생이 아이디를 잊은 경우) */
export async function findAccounts(ctx: Ctx, opts: { name?: string; school?: string }) {
  const r = await ctx.db.query<{ username: string; school: string; display_name: string; created_at: Date }>(
    `SELECT username, school, display_name, created_at FROM accounts
      WHERE ($1::text IS NULL OR name_key = $1) AND ($2::text IS NULL OR school_key = $2) ORDER BY created_at`,
    [opts.name ? nameKey(opts.name) : null, opts.school ? schoolKey(opts.school) : null],
  );
  return r.rows;
}

export { sessionAccount };
