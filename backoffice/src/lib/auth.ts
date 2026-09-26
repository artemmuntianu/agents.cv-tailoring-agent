import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Authentication primitives. Encoding, deliberately dependency-free:
 *
 *   password  `scrypt$N$r$p$<salt b64url>$<hash b64url>`  (node:crypto scrypt)
 *   session   HS256 JWT in an httpOnly cookie, or - for the Chrome extension and
 *             other JSON clients - the same token as `Authorization: Bearer ...`
 *
 * There is no signup anywhere: accounts are created by an administrator through
 * `backoffice/scripts/user.mjs` (the design's "manual provisioning" rule).
 */

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export const SESSION_COOKIE = 'cvt_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface SessionPayload {
  /** `app_users.id` */
  sub: string;
  email: string;
  name?: string;
  /**
   * `app_users.is_admin`, copied into the signed token so the middleware can gate the
   * vocabulary admin surface without a database read per request. Tokens minted before
   * 2026-09-26 have no such claim and are treated as **false** (`verifySessionToken`
   * normalises it), which is the safe direction: a stale cookie cannot grow privileges.
   */
  admin: boolean;
  iat: number;
  exp: number;
}

function b64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// -- passwords -------------------------------------------------------------- #

export function hashPassword(password: string): string {
  if (!password) throw new Error('password must not be empty');
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, b64url(salt), b64url(hash)].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = (stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, expected] = parts;
  try {
    const hash = scryptSync(password, fromB64url(salt), fromB64url(expected).length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return hash.length === fromB64url(expected).length && timingSafeEqual(hash, fromB64url(expected));
  } catch {
    return false;
  }
}

// -- sessions (HS256 JWT) --------------------------------------------------- #

function jwtSecret(): string {
  const secret = process.env.BACKOFFICE_JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'BACKOFFICE_JWT_SECRET is not set (or too short): set a random string of 16+ ' +
        'characters before starting the backoffice.',
    );
  }
  return secret;
}

function sign(data: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

export function createSessionToken(
  payload: Omit<SessionPayload, 'iat' | 'exp'>,
  ttlSeconds = SESSION_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const body: SessionPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const claims = b64url(Buffer.from(JSON.stringify(body)));
  return `${header}.${claims}.${sign(`${header}.${claims}`, jwtSecret())}`;
}

/** Verify signature, algorithm and expiry. Returns null for anything invalid. */
export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, claims, signature] = parts;

  let algorithm: string;
  try {
    algorithm = JSON.parse(fromB64url(header).toString('utf8')).alg;
  } catch {
    return null;
  }
  if (algorithm !== 'HS256') return null;

  let expected: string;
  try {
    expected = sign(`${header}.${claims}`, jwtSecret());
  } catch {
    return null;
  }
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(fromB64url(claims).toString('utf8')) as SessionPayload;
    if (!payload.sub || !payload.email) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    // Anything but an explicit `true` (including a token minted before the claim
    // existed) is not an administrator.
    return { ...payload, admin: payload.admin === true };
  } catch {
    return null;
  }
}

// -- cookie / header plumbing ---------------------------------------------- #

/** Token from the cookie, or from `Authorization: Bearer ...` (extension clients). */
export function tokenFrom(
  request: Request,
  cookies: { get: (name: string) => { value: string } | undefined },
): string | null {
  const bearer = request.headers.get('authorization');
  if (bearer && /^bearer\s+/i.test(bearer)) return bearer.replace(/^bearer\s+/i, '').trim();
  return cookies.get(SESSION_COOKIE)?.value ?? null;
}
