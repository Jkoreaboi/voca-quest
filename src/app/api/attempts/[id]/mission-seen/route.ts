import { markMissionSeen } from '../../../../../server/attempts';
import { handle } from '../../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handle<{ id: string }>(({ ctx, params, device }) => markMissionSeen(ctx, params.id, device));
