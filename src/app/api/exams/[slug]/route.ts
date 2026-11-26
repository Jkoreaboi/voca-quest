import type { ExamHomeResponse } from '../../../../shared/api';
import { examPublic, getExamBySlug } from '../../../../server/exams';
import { handle } from '../../../../server/http';
import { currentStudent, meInfo } from '../../../../server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = handle<{ slug: string }>(async ({ ctx, params, device }): Promise<ExamHomeResponse> => {
  const exam = await getExamBySlug(ctx.db, params.slug);
  const s = await currentStudent(ctx.db, device, exam.id);
  return { exam: await examPublic(ctx, ctx.db, exam), me: s ? await meInfo(ctx, ctx.db, exam, s) : null };
});
