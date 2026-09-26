import { defineMiddleware } from 'astro:middleware';
import { isAdminPath } from './lib/admin';
import { tokenFrom, verifySessionToken } from './lib/auth';

/**
 * Every page and API is private. There is no signup route at all: an administrator
 * provisions accounts (`backoffice/scripts/user.mjs`) and the UI only authenticates.
 *
 * `/admin` and `/api/admin/*` are **administrator** surfaces. The signed session carries
 * `app_users.is_admin` (`lib/auth.ts`), so the gate costs no database read per request;
 * a non-admin gets 403 (API) or the 403 page.
 *
 * API clients (the Chrome extension) authenticate with
 * `Authorization: Bearer <token>` from `POST /api/auth/token`; browsers use the
 * httpOnly session cookie.
 */
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/token', '/api/auth/me'];

export const onRequest = defineMiddleware((context, next) => {
  const { pathname } = context.url;

  // Public routes plus build/static assets (/_astro/..., /favicon.svg, ...).
  if (PUBLIC_PATHS.includes(pathname) || pathname.startsWith('/_') || /\.[a-z0-9]+$/i.test(pathname)) {
    return next();
  }

  const session = verifySessionToken(tokenFrom(context.request, context.cookies));
  if (!session) {
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false, error: 'authentication required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const next_url = encodeURIComponent(pathname + context.url.search);
    return context.redirect(`/login?next=${next_url}`);
  }

  context.locals.session = session;

  // The vocabulary admin surface: admin-provisioned, never self-served.
  if (isAdminPath(pathname) && !session.admin) {
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false, error: 'administrator only' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    return context.redirect('/403');
  }

  return next();
});
