/**
 * Provision backoffice accounts: `node scripts/user.mjs <command>`.
 *
 * There is deliberately no signup route - the design's "manual provisioning" rule
 * puts account creation in the administrator's hands, and this script is that
 * hand. There is no shebang on purpose: vitest imports this file to cross-check
 * its hash format, and Vite's transform rejects one.
 *
 *   node scripts/user.mjs add --email me@example.com --password=secret [--name=Me] [--admin]
 *   node scripts/user.mjs list
 *   node scripts/user.mjs password --email me@example.com --password 'new-secret'
 *   node scripts/user.mjs disable --email me@example.com
 *   node scripts/user.mjs enable  --email me@example.com
 *
 * Needs DATABASE_URL (the same Postgres the worker and the board use); it is read
 * from the environment, falling back to `backoffice/.env`.
 *
 * `hashPassword` deliberately mirrors `src/lib/auth.ts`; `src/lib/user-cli.test.ts`
 * asserts that a hash from here verifies with the app's verifier.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

const B64 = (buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function hashPassword(password) {
  if (!password) throw new Error('password must not be empty');
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, B64(salt), B64(hash)].join('$');
}

export function newUserId() {
  return `u-${randomBytes(8).toString('hex')}`;
}

function loadEnv() {
  if (process.env.DATABASE_URL) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const envFile = join(here, '..', '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    process.env[trimmed.slice(0, index).trim()] ??= trimmed.slice(index + 1).trim();
  }
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      flags._.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals > 0) {
      // `--password=secret`: the only form that survives cmd.exe and npm, where
      // single quotes are literal characters and `'secret'` would become the value.
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  loadEnv();
  const dsn = deps.dsn ?? process.env.DATABASE_URL;
  if (!dsn) {
    console.error('DATABASE_URL is not set - point it at the cluster Postgres.');
    return 1;
  }

  const flags = parseArgs(argv);
  const command = flags._[0] ?? 'help';
  const pool = deps.pool ?? new pg.Pool({ connectionString: dsn, application_name: 'cvt-user-cli' });

  try {
    if (command === 'add') {
      if (!flags.email || !flags.password) {
        console.error('usage: add --email <email> --password <password> [--name <name>] [--admin]');
        return 1;
      }
      const id = newUserId();
      await pool.query(
        `insert into app_users (id, email, display_name, password_hash, is_admin)
         values ($1, $2, $3, $4, $5)`,
        [
          id,
          String(flags.email).trim(),
          flags.name ? String(flags.name) : null,
          hashPassword(String(flags.password)),
          Boolean(flags.admin),
        ],
      );
      console.log(`created ${flags.email} (id ${id}${flags.admin ? ', admin' : ''})`);
      return 0;
    }

    if (command === 'list') {
      const result = await pool.query(
        `select id, email, display_name, is_admin, is_active, last_login_at
           from app_users order by created_at`,
      );
      if (result.rows.length === 0) {
        console.log('no accounts yet - create one with: add --email <email> --password <password>');
        return 0;
      }
      for (const row of result.rows) {
        const last = row.last_login_at ? new Date(row.last_login_at).toISOString() : 'never';
        console.log(
          `${row.is_active ? 'active  ' : 'disabled'} ${String(row.email).padEnd(28)} ` +
            `${row.is_admin ? 'admin ' : 'user  '} last login: ${last}  (${row.id})`,
        );
      }
      return 0;
    }

    if (command === 'password') {
      if (!flags.email || !flags.password) {
        console.error('usage: password --email <email> --password <new password>');
        return 1;
      }
      const result = await pool.query(
        'update app_users set password_hash = $2 where lower(email) = lower($1)',
        [String(flags.email), hashPassword(String(flags.password))],
      );
      if (result.rowCount === 0) {
        console.error(`no account for ${flags.email}`);
        return 1;
      }
      console.log(`password updated for ${flags.email}`);
      return 0;
    }

    if (command === 'disable' || command === 'enable') {
      if (!flags.email) {
        console.error(`usage: ${command} --email <email>`);
        return 1;
      }
      const result = await pool.query(
        'update app_users set is_active = $2 where lower(email) = lower($1)',
        [String(flags.email), command === 'enable'],
      );
      if (result.rowCount === 0) {
        console.error(`no account for ${flags.email}`);
        return 1;
      }
      console.log(`${flags.email} ${command === 'enable' ? 'enabled' : 'disabled'}`);
      return 0;
    }

    console.log(
      [
        'usage: node scripts/user.mjs <command>',
        '',
        '  add      --email <email> --password <password> [--name <name>] [--admin]',
        '  list',
        '  password --email <email> --password <new password>',
        '  disable  --email <email>',
        '  enable   --email <email>',
        '',
        'Use the --key=value form (e.g. --password=secret) in cmd.exe or via npm run,',
        'where a quoted value keeps its quotes.',
      ].join('\n'),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (!deps.pool) await pool.end().catch(() => undefined);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  process.exit(await main());
}
