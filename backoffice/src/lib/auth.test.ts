import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
} from './auth';

process.env.BACKOFFICE_JWT_SECRET = 'test-secret-that-is-long-enough';

describe('password hashing', () => {
  it('round-trips a password and rejects a wrong one', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('uses a fresh salt per hash and never stores the password', () => {
    const first = hashPassword('same-password');
    const second = hashPassword('same-password');
    expect(first).not.toBe(second);
    expect(first.includes('same-password')).toBe(false);
  });

  it('refuses malformed stored values instead of throwing', () => {
    for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'bcrypt$x$y$z$s$h']) {
      expect(verifyPassword('whatever', bad)).toBe(false);
    }
  });
});

describe('session tokens', () => {
  const claims = { sub: 'u-1', email: 'andrei@example.com', name: 'Andrei' };

  it('verifies a token it issued and keeps the claims', () => {
    const token = createSessionToken(claims);
    const payload = verifySessionToken(token);
    expect(payload?.sub).toBe('u-1');
    expect(payload?.email).toBe('andrei@example.com');
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });

  it('rejects a tampered payload or signature', () => {
    const token = createSessionToken(claims);
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...claims, iat: 1, exp: 9_999_999_999, email: 'attacker@example.com' }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifySessionToken(`${header}.${forged}.${signature}`)).toBeNull();
    expect(verifySessionToken(`${token}x`)).toBeNull();
    expect(verifySessionToken('not.a.token')).toBeNull();
    expect(verifySessionToken(null)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = createSessionToken(claims, -10);
    expect(verifySessionToken(expired)).toBeNull();
  });
});
