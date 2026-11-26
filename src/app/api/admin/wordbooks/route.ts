import { handle, requireAdmin } from '../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = handle(async ({ ctx, req }) => {
  requireAdmin(req);
  const wb = await ctx.db.query<{ id: number; code: string; title: string; is_sample: boolean }>('SELECT id, code, title, is_sample FROM wordbooks ORDER BY id');
  const units = await ctx.db.query<{ wordbook_id: number; ordinal: number; code: string; label: string; words: number }>(
    `SELECT u.wordbook_id, u.ordinal, u.code, u.label, count(w.id) FILTER (WHERE w.status = 'active')::int AS words
       FROM units u LEFT JOIN words w ON w.unit_id = u.id WHERE u.ordinal > 0 GROUP BY u.id ORDER BY u.wordbook_id, u.ordinal`,
  );
  const runs = await ctx.db.query<{ wordbook_id: number; ran_at: Date; source_file: string; summary: unknown }>(
    'SELECT DISTINCT ON (wordbook_id) wordbook_id, ran_at, source_file, summary FROM import_runs ORDER BY wordbook_id, ran_at DESC',
  );
  return {
    wordbooks: wb.rows.map((w) => ({
      code: w.code,
      title: w.title,
      isSample: w.is_sample,
      units: units.rows.filter((u) => u.wordbook_id === w.id).map(({ wordbook_id, ...u }) => u),
      lastImport: runs.rows.find((r) => r.wordbook_id === w.id) ?? null,
    })),
  };
});
