/**
 * 로컬 개발용 PostgreSQL 호환 서버 (PGlite + 소켓). 설치 없이 실행된다.
 *   npm run db:local            → .data/pglite 에 저장, 127.0.0.1:54329
 * 이 창을 켜 둔 채로 다른 터미널에서 db:migrate / import:words / admin / dev 를 실행한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { argValue } from './_env';

async function main() {
  const args = process.argv.slice(2);
  const dir = path.resolve(argValue(args, 'dir') ?? '.data/pglite');
  const port = Number(argValue(args, 'port') ?? 54329);
  fs.mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 16 });
  await server.start();
  console.log(`PGlite 서버 실행 중 → DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${port}/postgres (데이터: ${dir})`);
  console.log('종료: Ctrl+C');
  const stop = async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('로컬 DB 시작 실패:', e?.message ?? e);
  process.exit(1);
});
