import { handle } from '../../../../../server/http';
import { wrongNotes } from '../../../../../server/records';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = handle<{ slug: string }>(({ ctx, params, device }) => wrongNotes(ctx, params.slug, device));
