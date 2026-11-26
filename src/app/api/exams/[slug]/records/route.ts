import { handle } from '../../../../../server/http';
import { records } from '../../../../../server/records';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = handle<{ slug: string }>(({ ctx, params, device }) => records(ctx, params.slug, device));
