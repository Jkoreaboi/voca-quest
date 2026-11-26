import { studentUrl, updateExam, type ExamInput } from '../../../../../server/exams';
import { handle, requireAdmin } from '../../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = handle<{ slug: string }>(async ({ ctx, req, params, body }) => {
  requireAdmin(req);
  const e = await updateExam(ctx, params.slug, body as ExamInput);
  return { slug: e.slug, url: studentUrl(e.slug) };
});
