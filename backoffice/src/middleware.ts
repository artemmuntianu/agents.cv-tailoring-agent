import { defineMiddleware } from 'astro:middleware';
import { tokenFrom, verifySessionToken } from './lib/auth';

/**
 * Every page and API is private. There is no signup route at all: an administrator
 * provisions accounts (`backoffice/scripts/user.mjs`) and the UI only authenticates.
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
  if (session) {
    context.locals.session = session;
    return next();
  }

  if (pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ ok: false, error: 'authentication required' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const next_url = encodeURIComponent(pathname + context.url.search);
  return context.redirect(`/login?next=${next_url}`);
});
