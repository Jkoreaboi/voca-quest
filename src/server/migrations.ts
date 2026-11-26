/**
 * 마이그레이션 실행기 (스크립트·테스트 전용 — 앱 번들에 포함되지 않게 db.ts 와 분리).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db';

export function migrationsDir() {
  return path.join(process.cwd(), 'db', 'migrations');
}

export async function runMigrations(db: Db, dir = migrationsDir()): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await db.tx(async (q) => {
      for (const stmt of splitSql(sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations(version) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}

/** 세미콜론 단위 분할 (마이그레이션 파일은 함수/달러 인용 없이 작성) */
function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
