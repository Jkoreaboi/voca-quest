import { signup } from '../../../../../server/accounts';
import { clientIp, handle } from '../../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handle<{ slug: string }>(
  async ({ ctx, params, body, ensureDevice, setSession, req }) => {
    const { res, token } = await signup(ctx, params.slug, ensureDevice(), clientIp(req), body);
    setSession(token);
    return res;
  },
  { status: 201 },
);
