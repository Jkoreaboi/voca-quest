/**
 * 교사 검토용 예시 문항 내보내기. 실제 출제와 같은 코드(generateQuestions)로 Unit마다 문항을 만들어
 * 보기 품질(헷갈리는 정도, 복수 정답 여부)을 출시 전에 사람이 확인할 수 있게 한다. DB 는 읽기만 한다.
 */
import { generateQuestions, loadPool } from './attempts';
import type { Ctx } from './context';
import { displayTitle, getExamBySlug } from './exams';
import { seededRng } from './options';

export interface SampleRow {
  unit: string;
  source: string;
  direction: '한→영' | '영→한';
  prompt: string;
  options: string[];
  answer: number; // 1..4
}

export async function sampleQuestions(ctx: Ctx, slug: string, perUnit = 6, seed = 20261126) {
  const exam = await getExamBySlug(ctx.db, slug, { allowInactive: true });
  const pool = await loadPool(ctx.db, exam.wordbook_id);
  const src = await ctx.db.query<{ id: number; source_sheet: string; source_cell: string }>(
    'SELECT id, source_sheet, source_cell FROM words WHERE wordbook_id = $1',
    [exam.wordbook_id],
  );
  const where = new Map(src.rows.map((r) => [r.id, `${r.source_sheet.trim()} ${r.source_cell}`]));
  const rng = seededRng(seed);
  const rows: SampleRow[] = [];
  const skipped: Array<{ unit: string; english: string; reason: string }> = [];
  const units = Array.from(new Set(pool.filter((w) => w.unitOrdinal >= exam.unit_from && w.unitOrdinal <= exam.unit_to).map((w) => w.unitOrdinal))).sort((a, b) => a - b);
  for (const u of units) {
    const { questions, skipped: sk } = generateQuestions(pool, u, u, perUnit, rng);
    const label = pool.find((w) => w.unitOrdinal === u)!.unitLabel;
    for (const g of questions) {
      rows.push({
        unit: label,
        source: where.get(g.word.id) ?? '',
        direction: g.direction === 'ko2en' ? '한→영' : '영→한',
        prompt: g.prompt,
        options: g.options,
        answer: g.correctIndex + 1,
      });
    }
    for (const s of sk) skipped.push({ unit: label, ...s });
  }
  return { title: displayTitle(exam), seed, perUnit, rows, skipped };
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 을 붙인 CSV */
export function sampleCsv(rows: SampleRow[]): string {
  const header = ['Unit', '원본 위치', '방향', '제시어', '보기1', '보기2', '보기3', '보기4', '정답 번호', '정답', '검토 의견(복수 정답·너무 쉬움 등)'];
  const lines = [header, ...rows.map((r) => [r.unit, r.source, r.direction, r.prompt, ...r.options, r.answer, r.options[r.answer - 1], ''])];
  return '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
