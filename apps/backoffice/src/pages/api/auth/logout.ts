import type { APIRoute } from 'astro';
import { SESSION_COOKIE } from '../../../lib/auth';
import { json } from '../../../lib/http';

export const prerender = false;

/** POST /api/auth/logout - drop the session cookie. */
export const POST: APIRoute = async ({ cookies }) => {
  cookies.delete(SESSION_COOKIE, { path: '/' });
  return json({ ok: true });
};
