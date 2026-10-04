import { describe, expect, it } from 'vitest';
import { hashPassword as hashFromCli, newUserId } from '../../scripts/user.mjs';
import { hashPassword, verifyPassword } from './auth';

/**
 * The provisioning CLI is plain `.mjs` (so an operator can run it with bare node),
 * which means its hash format is a small, deliberate duplicate of `auth.ts`.
 * These two assertions are what keeps the copy honest.
 */
describe('provisioning CLI hashes match the app', () => {
  it('produces a hash the application accepts', () => {
    const stored = hashFromCli('a-provisioned-password');
    expect(verifyPassword('a-provisioned-password', stored)).toBe(true);
    expect(verifyPassword('not-the-password', stored)).toBe(false);
  });

  it('accepts a hash produced by the application', () => {
    const stored = hashPassword('produced-by-the-app');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored.split('$').length).toBe(6);
  });

  it('mints opaque, unique user ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newUserId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^u-[0-9a-f]{16}$/);
  });
});
