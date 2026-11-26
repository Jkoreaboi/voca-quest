import { handle } from '../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = handle(async ({ ctx }) => {
  const r = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM exams');
  return { ok: true, exams: r.rows[0].n };
});
