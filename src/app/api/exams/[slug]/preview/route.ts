import { preview } from '../../../../../server/exams';
import { handle } from '../../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = handle<{ slug: string }>(({ ctx, params, req }) =>
  preview(ctx, params.slug, req.nextUrl.searchParams.get('from'), req.nextUrl.searchParams.get('to')),
);
