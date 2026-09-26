import { hashPassword, verifyPassword } from './auth';
import { pool } from './db';

/** `app_users` access. Provisioning happens outside the app (see scripts/user.mjs). */

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string;
  is_admin: boolean;
  is_active: boolean;
}

/** What a successful login yields (the token is minted by the route). */
export interface Identity {
  /** The JWT `sub` claim: `app_users.id`. */
  sub: string;
  email: string;
  name?: string;
  /** `app_users.is_admin` - gates the vocabulary admin surface. */
  admin: boolean;
}

export async function findActiveUserByEmail(email: string): Promise<UserRow | null> {
  const result = await pool().query<UserRow>(
    `select id, email, display_name, password_hash, is_admin, is_active
       from app_users
      where lower(email) = lower($1)
      limit 1`,
    [email.trim()],
  );
  const user = result.rows[0];
  return user && user.is_active ? user : null;
}

export async function touchLastLogin(userId: string): Promise<void> {
  await pool().query('update app_users set last_login_at = now() where id = $1', [userId]);
}

/**
 * Check credentials and return the session claims, or null.
 *
 * A missing account still pays for one scrypt hash, so response timing does not
 * tell an attacker whether the email exists (the UI has no signup to enumerate
 * against, but the endpoint is reachable).
 */
export async function authenticate(
  email: string,
  password: string,
): Promise<Identity | null> {
  const user = await findActiveUserByEmail(email);
  if (!user) {
    hashPassword(password || 'placeholder');
    return null;
  }
  if (!verifyPassword(password, user.password_hash)) return null;

  await touchLastLogin(user.id);
  return {
    sub: user.id,
    email: user.email,
    name: user.display_name ?? undefined,
    admin: user.is_admin,
  };
}

