/** npm run db:migrate — db/migrations/*.sql 을 순서대로 한 번씩 적용 */
import { loadEnv } from './_env';
import { getDb } from '../src/server/db';
import { runMigrations } from '../src/server/migrations';

async function main() {
  loadEnv();
  const db = await getDb();
  const applied = await runMigrations(db);
  console.log(applied.length ? `적용: ${applied.join(', ')}` : '적용할 마이그레이션 없음 (최신 상태)');
  await db.close();
}

main().catch((e) => {
  console.error('마이그레이션 실패:', e?.message ?? e);
  process.exit(1);
});
