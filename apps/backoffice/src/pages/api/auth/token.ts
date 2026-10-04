import type { APIRoute } from 'astro';
import { createSessionToken } from '../../../lib/auth';
import { errorMessage, json } from '../../../lib/http';
import { authenticate } from '../../../lib/users';

export const prerender = false;

/**
 * POST /api/auth/token - the same credentials, but the token is returned in the
 * body instead of a cookie, so the Chrome extension (and curl) can use
 * `Authorization: Bearer <token>`.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  const password = typeof raw.password === 'string' ? raw.password : '';
  if (!email || !password) return json({ ok: false, error: 'email and password are required' }, 400);

  try {
    const identity = await authenticate(email, password);
    if (!identity) return json({ ok: false, error: 'invalid credentials' }, 401);
    return json({ ok: true, token: createSessionToken(identity), user: identity.email });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
