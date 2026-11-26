import { clientIp, handle } from '../../../../../server/http';
import { recover } from '../../../../../server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handle<{ slug: string }>(({ ctx, params, body, ensureDevice, req }) =>
  recover(ctx, params.slug, ensureDevice(), body.code, clientIp(req)),
);
