import { handle } from '../../../../../server/http';
import { enter } from '../../../../../server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handle<{ slug: string }>(({ ctx, params, body, ensureDevice }) => enter(ctx, params.slug, ensureDevice(), body.name, body.school));
