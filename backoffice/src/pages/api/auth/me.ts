import type { APIRoute } from 'astro';
import { tokenFrom, verifySessionToken } from '../../../lib/auth';
import { json } from '../../../lib/http';

export const prerender = false;

/** GET /api/auth/me - who is signed in (null when nobody is). Never 401s. */
export const GET: APIRoute = async ({ request, cookies }) => {
  const session = verifySessionToken(tokenFrom(request, cookies));
  if (!session) return json({ ok: true, session: null });
  return json({
    ok: true,
    session: {
      email: session.email,
      name: session.name ?? null,
      admin: session.admin,
      expiresAt: session.exp,
    },
  });
};
