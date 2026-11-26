/**
 * Route Handler 공통: 오류 → JSON, 기기 쿠키, 관리자 인증.
 */
import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import type { ApiErrorBody } from '../shared/api';
import { AppError, newDeviceToken, type Ctx } from './context';
import { getDb } from './db';

export const DEVICE_COOKIE = 'vq_device';
/** 학생 API 요청 본문 최대 크기 (가장 큰 요청인 가입도 1KB 미만) */
const MAX_BODY_BYTES = 16 * 1024;

export interface HandlerArgs<P> {
  req: NextRequest;
  params: P;
  ctx: Ctx;
  device: string | null;
  body: Record<string, unknown>;
  /** 쿠키가 없으면 새로 만들어 응답에 심는다 (enter/recover/login 시도 제한용) */
  ensureDevice: () => string;
  /** 로그인·가입 성공: 새 세션 토큰으로 쿠키 교체(회전) */
  setSession: (token: string) => void;
  /** 로그아웃: 쿠키 삭제 */
  clearSession: () => void;
}

type RouteContext<P> = { params: Promise<P> };

function errorBody(e: AppError): ApiErrorBody {
  return { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
}

/** 클라이언트 IP (프록시 뒤라면 X-Forwarded-For 첫 값). 해시로만 저장한다. */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

function setDeviceCookie(res: NextResponse, req: NextRequest, token: string) {
  res.cookies.set(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:' || process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 400,
  });
}

export function handle<P = Record<string, string>>(
  fn: (a: HandlerArgs<P>) => Promise<unknown>,
  opts: { status?: number } = {},
) {
  return async (req: NextRequest, rc: RouteContext<P>) => {
    let newDevice: string | null = null; // 새로 만든 기기 토큰 (성공·실패 응답 모두에 심음)
    let session: string | null | undefined; // undefined = 그대로, string = 교체, null = 삭제 (성공 응답에만)
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const ct = req.headers.get('content-type') ?? '';
        const len = Number(req.headers.get('content-length') ?? '0');
        if (len > 0 && !ct.includes('application/json')) {
          throw new AppError('BAD_REQUEST', 415, 'JSON 요청만 받을 수 있어요.');
        }
        if (len > MAX_BODY_BYTES) throw new AppError('BAD_REQUEST', 413, '요청이 너무 커요.');
      }
      let body: Record<string, unknown> = {};
      if (req.method !== 'GET') {
        // Content-Length 가 없거나 거짓이어도 실제 크기로 한 번 더 확인
        const text = await req.text().catch(() => '');
        if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new AppError('BAD_REQUEST', 413, '요청이 너무 커요.');
        try {
          body = text ? (JSON.parse(text) as Record<string, unknown>) ?? {} : {};
        } catch {
          body = {};
        }
      }
      const device = req.cookies.get(DEVICE_COOKIE)?.value ?? null;
      const ctx: Ctx = { db: await getDb() };
      const params = (await rc.params) as P;
      const data = await fn({
        req,
        params,
        ctx,
        device,
        body: typeof body === 'object' && body ? body : {},
        ensureDevice: () => {
          if (device && /^[A-Za-z0-9_-]{30,64}$/.test(device)) return device;
          newDevice = newDevice ?? newDeviceToken();
          return newDevice;
        },
        setSession: (token) => {
          session = token;
        },
        clearSession: () => {
          session = null;
        },
      });
      const res = NextResponse.json(data, { status: opts.status ?? 200 });
      res.headers.set('Cache-Control', 'no-store');
      if (typeof session === 'string') setDeviceCookie(res, req, session);
      else if (session === null) res.cookies.set(DEVICE_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
      else if (newDevice) setDeviceCookie(res, req, newDevice);
      return res;
    } catch (e) {
      if (e instanceof AppError) {
        const res = NextResponse.json(errorBody(e), { status: e.status, headers: { 'Cache-Control': 'no-store' } });
        // 실패 응답에도 새 기기 쿠키를 심어 다음 요청이 같은 기기로 집계되게 한다 (복구 코드 시도 제한)
        if (newDevice) setDeviceCookie(res, req, newDevice);
        return res;
      }
      console.error('[api] unexpected error', req.method, req.nextUrl.pathname, (e as Error)?.message);
      return NextResponse.json(
        { error: { code: 'INTERNAL', message: '서버에 일시적인 문제가 있어요. 잠시 후 다시 시도해 주세요. 지금까지의 기록은 보관돼요.' } } satisfies ApiErrorBody,
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  };
}

export function requireAdmin(req: NextRequest) {
  const expected = process.env.ADMIN_TOKEN ?? '';
  if (expected.length < 16) throw new AppError('UNAUTHORIZED', 401, '관리자 API가 비활성 상태입니다 (ADMIN_TOKEN 16자 이상 설정 필요).');
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new AppError('UNAUTHORIZED', 401, '관리자 토큰이 올바르지 않습니다.');
}
