import { logout } from '../../../../../server/accounts';
import { handle } from '../../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handle<{ slug: string }>(async ({ ctx, device, clearSession }) => {
  const r = await logout(ctx, device);
  clearSession();
  return r;
});
