import { quit } from '../../../../../server/attempts';
import { handle } from '../../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handle<{ id: string }>(({ ctx, params, device }) => quit(ctx, params.id, device));
