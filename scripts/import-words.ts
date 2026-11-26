/**
 * 단어장 임포트.
 *   npm run import:words -- --config vmap-basic-b1 [--dry-run]
 * 결과: 콘솔 요약 + data/import-reports/<code>-latest.{json,md}
 */
import fs from 'node:fs';
import path from 'node:path';
import { argValue, hasFlag, loadEnv } from './_env';
import { getDb } from '../src/server/db';
import { importWordbook, loadConfig, reportMarkdown } from '../src/server/importer';

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const code = argValue(args, 'config') ?? 'vmap-basic-b1';
  const dryRun = hasFlag(args, 'dry-run');
  const cfg = loadConfig(code);
  const db = dryRun ? (null as any) : await getDb();
  const report = await importWordbook(db, cfg, { dryRun });
  const dir = path.join(process.cwd(), 'data', 'import-reports');
  fs.mkdirSync(dir, { recursive: true });
  const suffix = dryRun ? 'dry-run' : 'latest';
  fs.writeFileSync(path.join(dir, `${cfg.code}-${suffix}.json`), JSON.stringify(report, null, 2), 'utf8');
  const md = reportMarkdown(report);
  fs.writeFileSync(path.join(dir, `${cfg.code}-${suffix}.md`), md, 'utf8');
  console.log(md.split('\n## 문제 행')[0]);
  const serious = report.issues.filter((i) => i.severity !== 'info');
  console.log(`\n문제 행(error/warning): ${serious.length}건 → data/import-reports/${cfg.code}-${suffix}.md`);
  if (db) await db.close();
}

main().catch((e) => {
  console.error('임포트 실패:', e?.message ?? e);
  process.exit(1);
});
