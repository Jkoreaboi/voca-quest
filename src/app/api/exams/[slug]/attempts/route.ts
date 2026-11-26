import { startAttempt } from '../../../../../server/attempts';
import { handle } from '../../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handle<{ slug: string }>(({ ctx, params, device, body }) => startAttempt(ctx, params.slug, device, body), { status: 201 });
