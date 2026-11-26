import { handle } from '../../../../../server/http';
import { startWrongTest } from '../../../../../server/wrong-test';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handle<{ slug: string }>(({ ctx, params, device, body }) => startWrongTest(ctx, params.slug, device, body), { status: 201 });
