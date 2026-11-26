import { result } from '../../../../../server/attempts';
import { handle } from '../../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = handle<{ id: string }>(({ ctx, params, device }) => result(ctx, params.id, device));
