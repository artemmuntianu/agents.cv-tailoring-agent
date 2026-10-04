import type { APIRoute } from 'astro';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSessionToken } from '../../../lib/auth';
import { errorMessage, json } from '../../../lib/http';
import { authenticate } from '../../../lib/users';

export const prerender = false;

/**
 * POST /api/auth/login - browser login: verifies the credentials an administrator
 * provisioned and sets the httpOnly session cookie.
 */
export const POST: APIRoute = async ({ request, cookies }) => {
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

    cookies.set(SESSION_COOKIE, createSessionToken(identity), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_SECONDS,
    });
    return json({ ok: true, user: { email: identity.email, name: identity.name ?? null } });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
