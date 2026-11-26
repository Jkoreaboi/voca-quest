import crypto from 'node:crypto';
import type { ErrorCode } from '../shared/api';
import type { Db } from './db';
import { cryptoRng, type Rng } from './options';

/** 서비스 함수 공통 컨텍스트. 테스트에서 now/rng 를 바꿔 끼운다. */
export interface Ctx {
  db: Db;
  now?: () => Date;
  rng?: Rng;
}

export const nowOf = (ctx: Ctx) => (ctx.now ? ctx.now() : new Date());
export const rngOf = (ctx: Ctx) => ctx.rng ?? cryptoRng();

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function appSecret(): string {
  const s = process.env.APP_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_SECRET(16자 이상)이 설정되지 않았습니다.');
  }
  return 'local-dev-secret-not-for-production';
}

export function hmac(value: string): string {
  return crypto.createHmac('sha256', appSecret()).update(value).digest('hex');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 복구 코드: Crockford base32 12자리(60비트) 'XXXX-XXXX-XXXX' */
export function newRecoveryCode(): string {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += CROCKFORD[bytes[i] & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** 입력 정규화: 대소문자·공백·하이픈 무시, 헷갈리는 글자(O→0, I/L→1) 보정 */
export function normalizeRecoveryCode(input: string): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

export function hashRecoveryCode(code: string): string {
  return hmac(`recovery:${normalizeRecoveryCode(code)}`);
}

export function newDeviceToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashDeviceToken(token: string): string {
  return hmac(`device:${token}`);
}

/** 공개 URL용 시험 slug (소문자 base32 10자) */
export function newSlug(): string {
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += CROCKFORD[bytes[i] & 31].toLowerCase();
  return s;
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string; message?: string };
  if (err?.code !== '23505') return false;
  if (!constraint) return true;
  return err.constraint === constraint || !!err.message?.includes(constraint);
}
