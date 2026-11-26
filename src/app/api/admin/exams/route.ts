import { createExam, listExams, studentUrl, type ExamInput } from '../../../../server/exams';
import { handle, requireAdmin } from '../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = handle(async ({ ctx, req }) => {
  requireAdmin(req);
  return { exams: await listExams(ctx) };
});

export const POST = handle(
  async ({ ctx, req, body }) => {
    requireAdmin(req);
    const e = await createExam(ctx, body as ExamInput);
    return { slug: e.slug, url: studentUrl(e.slug) };
  },
  { status: 201 },
);
