// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';

// Vite puts `.env` values into `import.meta.env`, but the server code reads
// `process.env` (DATABASE_URL, BACKOFFICE_JWT_SECRET, RABBITMQ_URL), so mirror the
// file into the process environment for dev/build. The built server does not run this
// config, so `npm start` passes `--env-file-if-exists=.env` to node instead.
const mode = process.env.NODE_ENV ?? 'development';
Object.assign(process.env, loadEnv(mode, process.cwd(), ''));

// Server-rendered because the board reads and writes the SAME Postgres the worker
// uses (utils/db.SCHEMA_SQL owns the schema; the board owns resume_board,
// resume_history and app_users - see backoffice/AGENTS.md and CONSTITUTION.md D11).
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
