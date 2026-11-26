import { checkExam } from '../../../../../../server/exams';
import { handle, requireAdmin } from '../../../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = handle<{ slug: string }>(async ({ ctx, req, params }) => {
  requireAdmin(req);
  return checkExam(ctx, params.slug);
});
