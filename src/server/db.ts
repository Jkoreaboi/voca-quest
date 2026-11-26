/**
 * DB 접근 계층. 앱·스크립트는 PostgreSQL 프로토콜(pg)로, 테스트는 프로세스 내 PGlite 로 같은 인터페이스를 쓴다.
 * - 운영: DATABASE_URL = 실제 PostgreSQL
 * - 로컬: DATABASE_URL = `npm run db:local` 로 띄운 PGlite 소켓 서버 (DB_FORCE_TX=1)
 * - 테스트: createMemoryDb()
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** 트랜잭션. fn 이 던지면 ROLLBACK. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'pg' | 'pglite';
}

// ───────── pg (PostgreSQL / PGlite 소켓 서버) ─────────

export async function createPgDb(url: string, forceTx: boolean, opts: { schema?: string } = {}): Promise<Db> {
  const { default: pg } = await import('pg');
  // timestamptz 는 Date, int8 은 문자열로 오므로 count 등은 SQL 에서 ::int 로 캐스팅한다.
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX || (forceTx ? 4 : 10)),
    idleTimeoutMillis: forceTx ? 2000 : 10000,
  });
  if (opts.schema) {
    // 테스트용 격리 스키마 (실제 PostgreSQL 에서 연결마다 search_path 지정)
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(opts.schema)) throw new Error('잘못된 스키마 이름');
    pool.on('connect', (client) => {
      client.query(`SET search_path TO ${opts.schema}`).catch(() => undefined);
    });
  }
  const tx = async <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q: Queryable = {
        query: async (sql, params) => {
          const r = await client.query(sql, params as any[]);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      };
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* 연결이 끊긴 경우 무시 */
      }
      throw e;
    } finally {
      client.release();
    }
  };
  return {
    kind: 'pg',
    async query(sql, params) {
      // PGlite 소켓 서버는 여러 연결을 단일 세션으로 다중화하므로, 트랜잭션 밖 확장 프로토콜 메시지가
      // 섞이지 않도록 모든 쿼리를 트랜잭션으로 감싼다 (DB_FORCE_TX=1).
      if (forceTx) return tx((q) => q.query(sql, params));
      const r = await pool.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    tx,
    close: () => pool.end(),
  };
}

// ───────── PGlite (테스트용, 프로세스 내) ─────────

export async function createMemoryDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pgl = dataDir ? new PGlite(dataDir) : new PGlite();
  await pgl.waitReady;
  const wrap = (runner: { query: (s: string, p?: any[]) => Promise<any> }): Queryable => ({
    async query(sql, params) {
      const r = await runner.query(sql, params as any[]);
      // PGlite 는 SELECT 의 affectedRows 를 0 으로 주므로 pg 와 맞추려고 행 수와 비교
      return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
    },
  });
  const base = wrap(pgl);
  return {
    kind: 'pglite',
    query: (sql, params) => base.query(sql, params),
    tx: (fn) => pgl.transaction((t) => fn(wrap(t))),
    close: () => pgl.close(),
  };
}

// ───────── 싱글턴 ─────────

const g = globalThis as unknown as { __vqDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!g.__vqDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL 이 설정되지 않았습니다. .env.example 을 참고해 .env 를 만드세요.');
    }
    g.__vqDb = createPgDb(url, process.env.DB_FORCE_TX === '1');
  }
  return g.__vqDb;
}

/** 테스트에서 싱글턴 교체 */
export function setDbForTests(db: Db | undefined) {
  g.__vqDb = db ? Promise.resolve(db) : undefined;
}

// 마이그레이션 실행기는 src/server/migrations.ts (앱 번들 제외)
