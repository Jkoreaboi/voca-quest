import { handle } from '../../../../../server/http';
import { reissueRecoveryCode } from '../../../../../server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handle<{ slug: string }>(({ ctx, params, device }) => reissueRecoveryCode(ctx, params.slug, device));
