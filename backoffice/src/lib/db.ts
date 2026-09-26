import { Pool } from 'pg';
import type { BoardCard, MoveRequest } from './types';

/**
 * Server-only data access. The board reads the worker's `resumes` rows and owns
 * exactly two tables, created by the worker's own schema bootstrap
 * (`utils/db.py::SCHEMA_SQL` - never duplicated here):
 *
 *   resume_board   job_id -> stage (the manual kanban column)
 *   resume_history one row per confirmed manual change
 *
 * `resumes.status` is read-only for the board: it is the worker's claim and
 * idempotency state, and the `created` sub-state is derived from it instead.
 */

const BOARD_LIMIT = 200;

interface CardRow {
  job_id: string;
  external_id: string;
  title: string | null;
  company: string | null;
  source_url: string | null;
  cv_version: string;
  status: string;
  attempts: number;
  revision_count: number | null;
  duration_ms: number | null;
  error: string | null;
  pdf_url: string | null;
  docx_path: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  stage: string;
}

interface HistoryRow {
  id: number;
  job_id: string;
  at: Date | string;
  actor: string;
  action: string;
  kind: string;
  from_state: string;
  to_state: string;
}

// One pool per process, surviving Astro/Vite dev reloads.
const globals = globalThis as unknown as { __cvTailoringPool?: Pool };

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set - point it at the cluster Postgres, e.g. ' +
        'postgresql://cvt:cvt@localhost:5432/cvt after ' +
        '`kubectl port-forward svc/postgres 5432:5432`.',
    );
  }
  return url;
}

export function pool(): Pool {
  if (!globals.__cvTailoringPool) {
    globals.__cvTailoringPool = new Pool({
      connectionString: databaseUrl(),
      max: 4,
      connectionTimeoutMillis: 10_000,
      application_name: 'cv-tailoring-backoffice',
    });
  }
  return globals.__cvTailoringPool;
}

export async function closePool(): Promise<void> {
  if (globals.__cvTailoringPool) {
    await globals.__cvTailoringPool.end();
    globals.__cvTailoringPool = undefined;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function fetchBoard(): Promise<BoardCard[]> {
  const cards = await pool().query<CardRow>(
    `select r.job_id, r.external_id, r.title, r.company, r.source_url, r.cv_version,
            r.status, r.attempts, r.revision_count, r.duration_ms, r.error,
            r.pdf_url, r.docx_path, r.created_at, r.updated_at,
            coalesce(b.stage, 'created') as stage
       from resumes r
       left join resume_board b on b.job_id = r.job_id
      order by r.updated_at desc nulls last
      limit $1`,
    [BOARD_LIMIT],
  );
  if (cards.rows.length === 0) return [];

  const history = await pool().query<HistoryRow>(
    `select id, job_id, at, actor, action, kind, from_state, to_state
       from resume_history
      where job_id = any($1::text[])
      order by at asc, id asc`,
    [cards.rows.map((row) => row.job_id)],
  );

  return cards.rows.map((row) => ({
    jobId: row.job_id,
    externalId: row.external_id,
    title: row.title ?? '',
    company: row.company ?? '',
    sourceUrl: row.source_url,
    cvVersion: row.cv_version,
    status: row.status,
    attempts: row.attempts,
    revisionCount: row.revision_count,
    durationMs: row.duration_ms,
    error: row.error,
    pdfUrl: row.pdf_url,
    docxPath: row.docx_path,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    stage: row.stage as BoardCard['stage'],
    history: history.rows
      .filter((entry) => entry.job_id === row.job_id)
      .map((entry) => ({
        id: entry.id,
        at: toIso(entry.at),
        actor: entry.actor as BoardCard['history'][number]['actor'],
        action: entry.action,
        kind: entry.kind as BoardCard['history'][number]['kind'],
        from: entry.from_state,
        to: entry.to_state,
      })),
  }));
}

/**
 * Confirm a manual move: the board row and its history entry are written in one
 * transaction, so a card can never move without a recorded reason.
 * Returns the updated card, or null when the vacancy does not exist.
 */
export async function moveCard(move: MoveRequest): Promise<BoardCard | null> {
  const client = await pool().connect();
  try {
    await client.query('begin');

    const known = await client.query('select 1 as ok from resumes where job_id = $1', [move.jobId]);
    if (known.rowCount === 0) {
      await client.query('rollback');
      return null;
    }

    const current = await client.query<{ stage: string | null }>(
      'select stage from resume_board where job_id = $1',
      [move.jobId],
    );
    const from = current.rows[0]?.stage ?? 'created';

    await client.query(
      `insert into resume_board (job_id, stage, updated_at) values ($1, $2, now())
       on conflict (job_id) do update set stage = excluded.stage, updated_at = now()`,
      [move.jobId, move.to],
    );
    await client.query(
      `insert into resume_history (job_id, actor, action, kind, from_state, to_state)
       values ($1, $2, $3, 'move', $4, $5)`,
      [move.jobId, move.actor, move.action, from, move.to],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const board = await fetchBoard();
  return board.find((card) => card.jobId === move.jobId) ?? null;
}
