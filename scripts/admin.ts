/**
 * 교사용 관리 명령 (서버 DB 에 직접 접근 — 학생에게 노출되지 않음)
 *
 *   npm run admin -- exam:create --wordbook vmap-basic-b1 --school 인천외고 --grade 1학년 --textbook "Vocabulary Map Basic B-1" \
 *        --title "기말 범위" --units 1-20 --questions 20 --quest-start 2026-11-26 --quest-end 2026-12-06 [--sample]
 *   npm run admin -- exam:list
 *   npm run admin -- exam:update <slug> [--title ..] [--units 3-10] [--questions 30] [--quest-start ..] [--quest-end ..] [--active false]
 *   npm run admin -- exam:check <slug>           # 출제 점검 (Unit별 출제 가능 수·제외 사유)
 *   npm run admin -- exam:sample <slug> [--per-unit 6] [--seed 123]   # 교사 검토용 예시 문항 CSV (data/review/)
 *   npm run admin -- wordbook:list
 *   npm run admin -- account:find --name 김하늘 [--school 인천외고]   # 학생이 아이디를 잊은 경우
 *   npm run admin -- account:reset-password <아이디>                  # 임시 비밀번호 1회 표시, 기존 로그인 모두 끊김
 */
import fs from 'node:fs';
import path from 'node:path';
import { argValue, hasFlag, loadEnv } from './_env';
import { getDb } from '../src/server/db';
import { checkExam, createExam, listExams, studentUrl, updateExam, type ExamInput } from '../src/server/exams';
import { AppError } from '../src/server/context';
import { sampleCsv, sampleQuestions } from '../src/server/review';
import { findAccounts, resetPassword } from '../src/server/accounts';

function units(v: string | undefined): { unitFrom?: number; unitTo?: number } {
  if (!v) return {};
  const m = /^(\d+)(?:-(\d+))?$/.exec(v);
  if (!m) throw new Error(`--units 형식은 1-20 처럼: ${v}`);
  return { unitFrom: Number(m[1]), unitTo: Number(m[2] ?? m[1]) };
}

function examInput(args: string[]): ExamInput {
  const out: ExamInput = {
    wordbook: argValue(args, 'wordbook'),
    school: argValue(args, 'school'),
    grade: argValue(args, 'grade'),
    textbook: argValue(args, 'textbook'),
    title: argValue(args, 'title'),
    ...units(argValue(args, 'units')),
    questionCount: argValue(args, 'questions') ? Number(argValue(args, 'questions')) : undefined,
    questStart: argValue(args, 'quest-start'),
    questEnd: argValue(args, 'quest-end'),
    slug: argValue(args, 'slug'),
  };
  if (hasFlag(args, 'sample')) out.isSample = true;
  const active = argValue(args, 'active');
  if (active !== undefined) out.isActive = active !== 'false';
  if (argValue(args, 'clear-quest') !== undefined || hasFlag(args, 'clear-quest')) {
    out.questStart = null;
    out.questEnd = null;
  }
  return out;
}

async function main() {
  loadEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  const db = await getDb();
  const ctx = { db };
  try {
    switch (cmd) {
      case 'exam:create': {
        const e = await createExam(ctx, examInput(rest));
        console.log(`시험 생성 완료\n  slug: ${e.slug}\n  학생용 URL: ${studentUrl(e.slug)}`);
        break;
      }
      case 'exam:update': {
        const slug = rest[0];
        if (!slug || slug.startsWith('--')) throw new Error('exam:update <slug> 형식으로 입력하세요.');
        const e = await updateExam(ctx, slug, examInput(rest.slice(1)));
        console.log(`수정 완료: ${e.slug} → ${studentUrl(e.slug)}`);
        break;
      }
      case 'exam:list': {
        const list = await listExams(ctx);
        if (!list.length) console.log('등록된 시험 없음');
        for (const e of list) {
          console.log(`- ${e.displayTitle}${e.isSample ? ' [예시]' : ''}${e.isActive ? '' : ' [비활성]'}`);
          console.log(`    URL: ${e.url}`);
          console.log(`    단어장 ${e.wordbook} · Unit ${e.units} · ${e.questionCount}문항 · 퀘스트 ${e.quest.startDate ?? '미정'} ~ ${e.quest.endDate ?? '미정'} (${e.quest.status})`);
        }
        break;
      }
      case 'exam:check': {
        const r = await checkExam(ctx, rest[0]);
        console.log(`출제 점검 — ${r.displayTitle}`);
        for (const u of r.units) {
          console.log(`  ${u.label}: 단어 ${u.words} · 출제 가능 ${u.usable} (영→한만 ${u.en2koOnly}, 한→영만 ${u.ko2enOnly}) · 제외 ${u.excluded.length}`);
          for (const x of u.excluded) console.log(`      제외: ${x.english} / ${x.meaning} @ ${x.where} — ${x.reason}`);
        }
        break;
      }
      case 'exam:sample': {
        const slug = rest[0];
        if (!slug || slug.startsWith('--')) throw new Error('exam:sample <slug> [--per-unit 6] [--seed 123] 형식으로 입력하세요.');
        const perUnit = Number(argValue(rest, 'per-unit') ?? 6);
        const seed = Number(argValue(rest, 'seed') ?? 20261126);
        const r = await sampleQuestions(ctx, slug, perUnit, seed);
        const dir = path.join(process.cwd(), 'data', 'review');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${slug}-sample.csv`);
        fs.writeFileSync(file, sampleCsv(r.rows), 'utf8');
        console.log(`검토용 예시 문항 ${r.rows.length}개 (Unit당 ${perUnit}개, seed ${seed}) → ${path.relative(process.cwd(), file)}`);
        if (r.skipped.length) console.log(`출제 제외 ${r.skipped.length}건: ${r.skipped.map((s) => `${s.unit} ${s.english}(${s.reason})`).join('; ')}`);
        break;
      }
      case 'account:reset-password': {
        const u = rest[0];
        if (!u || u.startsWith('--')) throw new Error('account:reset-password <아이디> 형식으로 입력하세요.');
        const r = await resetPassword(ctx, u);
        console.log(`아이디 ${r.username} 비밀번호를 초기화했습니다. 기존 로그인은 모두 끊겼습니다.`);
        console.log(`임시 비밀번호(이 화면에만 표시): ${r.tempPassword}`);
        console.log('학생에게 직접 전달하고, 로그인 후 선생님과 함께 새 비밀번호로 바꾸도록 안내하세요.');
        break;
      }
      case 'account:find': {
        const rows = await findAccounts(ctx, { name: argValue(rest, 'name'), school: argValue(rest, 'school') });
        if (!rows.length) console.log('일치하는 계정 없음');
        for (const a of rows) console.log(`- ${a.username} · ${a.school} · ${a.display_name} · 가입 ${a.created_at.toISOString()}`);
        break;
      }
      case 'wordbook:list': {
        const r = await db.query<{ code: string; title: string; units: number; words: number }>(
          `SELECT b.code, b.title, count(DISTINCT u.id)::int AS units, count(w.id) FILTER (WHERE w.status = 'active')::int AS words
             FROM wordbooks b LEFT JOIN units u ON u.wordbook_id = b.id AND u.ordinal > 0 LEFT JOIN words w ON w.unit_id = u.id
            GROUP BY b.id ORDER BY b.id`,
        );
        for (const w of r.rows) console.log(`- ${w.code}: ${w.title} · Unit ${w.units} · 활성 단어 ${w.words}`);
        break;
      }
      default:
        console.log(`사용법은 scripts/admin.ts 상단 주석 참고. 명령: exam:create, exam:list, exam:update, exam:check, exam:sample, wordbook:list`);
    }
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof AppError ? `오류(${e.code}): ${e.message}` : `오류: ${e?.message ?? e}`);
  process.exit(1);
});
