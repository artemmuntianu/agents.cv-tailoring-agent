import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type { ActionInput } from './admin';
import type { ExistingVacancy, InsertPlan } from './ingest';
import type { Actor, ArchiveRequest, BoardAction, BoardCard, MoveRequest } from './types';

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
  archived_at: Date | string | null;
  archived_actor: string | null;
  archived_reason: string | null;
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

/**
 * One card = the worker's row + the board's own state. Kept as a constant so the board
 * list and a single-card read can never drift apart (the archive columns have to be
 * selected in both).
 */
const CARD_SELECT = `
  select r.job_id, r.external_id, r.title, r.company, r.source_url, r.cv_version,
         r.status, r.attempts, r.revision_count, r.duration_ms, r.error,
         r.pdf_url, r.docx_path, r.created_at, r.updated_at,
         coalesce(b.stage, 'created') as stage,
         b.archived_at, b.archived_actor, b.archived_reason
    from resumes r
    left join resume_board b on b.job_id = r.job_id`;

async function fetchHistory(jobIds: string[]): Promise<HistoryRow[]> {
  const history = await pool().query<HistoryRow>(
    `select id, job_id, at, actor, action, kind, from_state, to_state
       from resume_history
      where job_id = any($1::text[])
      order by at asc, id asc`,
    [jobIds],
  );
  return history.rows;
}

function toCard(row: CardRow, history: HistoryRow[]): BoardCard {
  return {
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
    archivedAt: row.archived_at === null ? null : toIso(row.archived_at),
    archivedActor: (row.archived_actor as BoardCard['archivedActor']) ?? null,
    archivedReason: row.archived_reason,
    archived: row.archived_at !== null,
    history: history
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
  };
}

export async function fetchBoard(): Promise<BoardCard[]> {
  const cards = await pool().query<CardRow>(
    `${CARD_SELECT} order by r.updated_at desc nulls last limit $1`,
    [BOARD_LIMIT],
  );
  if (cards.rows.length === 0) return [];

  const history = await fetchHistory(cards.rows.map((row) => row.job_id));
  return cards.rows.map((row) => toCard(row, history));
}

/** One card, used to answer a mutation with the row it just wrote. */
export async function fetchCard(jobId: string): Promise<BoardCard | null> {
  const rows = await pool().query<CardRow>(`${CARD_SELECT} where r.job_id = $1`, [jobId]);
  const row = rows.rows[0];
  if (!row) return null;
  return toCard(row, await fetchHistory([jobId]));
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
    // The vocabulary grows with whatever the operator typed, in the same transaction.
    await recordAction(client, move.action, 'move');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return fetchCard(move.jobId);
}

/**
 * The Action catalogue, written *inside* the caller's transaction: a change and the
 * vocabulary it used are one unit, so the combobox can never offer a value that no row
 * ever carried. `uses = 1` on insert is deliberate - the column default (0) would make
 * a brand-new action look unused.
 */
const ACTION_UPSERT =
  'insert into board_actions (action, kind, uses) values ($1, $2, 1) ' +
  'on conflict (action) do update set uses = board_actions.uses + 1, last_used_at = now()';

async function recordAction(
  client: PoolClient,
  action: string,
  kind: BoardAction['kind'],
): Promise<void> {
  await client.query(ACTION_UPSERT, [action, kind]);
}

/**
 * The whole vocabulary, for the dialogs, the Filters panel and the admin page.
 *
 * It is the catalogue **union** what history actually recorded: a value an administrator
 * removed (or one typed before `board_actions` existed) is marked `catalogued: false`, so
 * the Filters panel can still select it while the dialog comboboxes stop suggesting it -
 * deleting a word must not make past cards unfilterable.
 */
export async function fetchActionVocabulary(): Promise<BoardAction[]> {
  const rows = await pool().query<{
    value: string;
    kind: string;
    uses: number;
    last_used_at: Date | string;
    catalogued: boolean;
  }>(
    `select value, kind, uses, last_used_at, catalogued
       from (
         select a.action as value, a.kind, a.uses, a.last_used_at, true as catalogued
           from board_actions a
         union all
         select h.action as value,
                (case when bool_or(h.kind = 'archive') then 'archive' else 'move' end) as kind,
                count(*)::int as uses,
                max(h.at) as last_used_at,
                false as catalogued
           from resume_history h
          where not exists (select 1 from board_actions a where a.action = h.action)
          group by h.action
       ) vocabulary
      order by catalogued desc, uses desc, last_used_at desc, value asc`,
  );
  return rows.rows.map((row) => ({
    value: row.value,
    kind: row.kind as BoardAction['kind'],
    uses: row.uses,
    lastUsedAt: toIso(row.last_used_at),
    catalogued: row.catalogued,
  }));
}

/** Add a vocabulary entry. Returns 'exists' when the wording is already there. */
export async function insertAction(input: ActionInput): Promise<'created' | 'exists'> {
  const created = await pool().query(
    `insert into board_actions (action, kind) values ($1, $2)
     on conflict (action) do nothing
     returning action`,
    [input.value, input.kind],
  );
  return created.rowCount === 1 ? 'created' : 'exists';
}

/**
 * Replace a catalogue entry with new wording, carrying its `uses` over.
 *
 * History is *not* rewritten: a card refused last month keeps the words it was refused
 * with (the audit trail), and until those rows are gone the old value stays filterable as
 * `catalogued: false`.
 */
export async function renameAction(from: string, to: string): Promise<'renamed' | 'unknown' | 'exists'> {
  const client = await pool().connect();
  try {
    await client.query('begin');

    const current = await client.query<{ kind: string; uses: number }>(
      'select kind, uses from board_actions where action = $1 for update',
      [from],
    );
    if (current.rowCount === 0) {
      await client.query('rollback');
      return 'unknown';
    }

    const clash = await client.query('select 1 from board_actions where action = $1', [to]);
    if (clash.rowCount) {
      await client.query('rollback');
      return 'exists';
    }

    await client.query(
      'insert into board_actions (action, kind, uses, created_at, last_used_at) values ($1, $2, $3, now(), now())',
      [to, current.rows[0].kind, current.rows[0].uses],
    );
    await client.query('delete from board_actions where action = $1', [from]);
    await client.query('commit');
    return 'renamed';
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Drop an entry from the vocabulary. History rows keep their wording. */
export async function deleteAction(value: string): Promise<boolean> {
  const deleted = await pool().query('delete from board_actions where action = $1', [value]);
  return (deleted.rowCount ?? 0) > 0;
}

/** Archive/restore answer with the card they wrote, or say why they refused. */
export type MutationOutcome =
  | { ok: true; card: BoardCard }
  | { ok: false; reason: 'unknown' | 'state' };

/**
 * Refuse a vacancy - the board's **in-place soft delete**. The card keeps the column it
 * reached (`resume_board.stage` is never touched) and the archive columns are set in one
 * transaction with the history row and the Action catalogue upsert, so a card can never
 * be refused without an actor, a reason and an audit entry.
 */
export async function archiveCard(request: ArchiveRequest): Promise<MutationOutcome> {
  const client = await pool().connect();
  try {
    await client.query('begin');

    const known = await client.query('select 1 as ok from resumes where job_id = $1', [
      request.jobId,
    ]);
    if (known.rowCount === 0) {
      await client.query('rollback');
      return { ok: false, reason: 'unknown' };
    }

    const current = await client.query<{ archived_at: Date | null }>(
      'select archived_at from resume_board where job_id = $1',
      [request.jobId],
    );
    if (current.rows[0]?.archived_at) {
      await client.query('rollback');
      return { ok: false, reason: 'state' };
    }

    // No board row yet (a card still in Created): the insert seeds stage 'created',
    // exactly like the column default.
    await client.query(
      `insert into resume_board (job_id, stage, archived_at, archived_actor, archived_reason, updated_at)
       values ($1, 'created', now(), $2, $3, now())
       on conflict (job_id) do update
          set archived_at = now(),
              archived_actor = excluded.archived_actor,
              archived_reason = excluded.archived_reason,
              updated_at = now()`,
      [request.jobId, request.actor, request.action],
    );
    await client.query(
      `insert into resume_history (job_id, actor, action, kind, from_state, to_state)
       values ($1, $2, $3, 'archive', 'active', 'archived')`,
      [request.jobId, request.actor, request.action],
    );
    await recordAction(client, request.action, 'archive');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const card = await fetchCard(request.jobId);
  return card ? { ok: true, card } : { ok: false, reason: 'unknown' };
}

/**
 * Put a refused vacancy back into play: one click, no dialog, but still a history row
 * (the actor and the recorded action come from the route, so this module stays free of
 * UI vocabulary). The Action catalogue is *not* touched - restores are not something the
 * operator types.
 */
export async function restoreCard(
  jobId: string,
  entry: { actor: Actor; action: string },
): Promise<MutationOutcome> {
  const client = await pool().connect();
  try {
    await client.query('begin');

    const current = await client.query<{ archived_at: Date | null }>(
      'select archived_at from resume_board where job_id = $1',
      [jobId],
    );
    if (!current.rows[0]) {
      await client.query('rollback');
      return { ok: false, reason: 'unknown' };
    }
    if (!current.rows[0].archived_at) {
      await client.query('rollback');
      return { ok: false, reason: 'state' };
    }

    await client.query(
      `update resume_board
          set archived_at = null, archived_actor = null, archived_reason = null,
              updated_at = now()
        where job_id = $1`,
      [jobId],
    );
    await client.query(
      `insert into resume_history (job_id, actor, action, kind, from_state, to_state)
       values ($1, $2, $3, 'restore', 'archived', 'active')`,
      [jobId, entry.actor, entry.action],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const card = await fetchCard(jobId);
  return card ? { ok: true, card } : { ok: false, reason: 'unknown' };
}

// -- ingest (the batch gateway) -------------------------------------------- #

/**
 * The board's view of the vacancies in this batch: one query, keyed by
 * `external_id`, so the gateway can tell "new" from "already on the board" before it
 * publishes anything. `archived_at` is part of the answer because a refused vacancy
 * must never be queued again (see `lib/ingest.ts`).
 */
export async function findExistingVacancies(
  userId: string,
  externalIds: string[],
  cvVersion: string,
): Promise<Map<string, ExistingVacancy>> {
  if (externalIds.length === 0) return new Map();

  const rows = await pool().query<{
    job_id: string;
    external_id: string;
    status: string;
    updated_at: Date | string;
    archived_at: Date | string | null;
  }>(
    `select r.job_id, r.external_id, r.status, r.updated_at, b.archived_at
       from resumes r
       left join resume_board b on b.job_id = r.job_id
      where coalesce(r.user_id, 'local') = coalesce($1, 'local')
        and r.cv_version = $2
        and r.external_id = any($3::text[])`,
    [userId, cvVersion, externalIds],
  );

  return new Map(
    rows.rows.map((row) => [
      row.external_id,
      {
        jobId: row.job_id,
        status: row.status,
        updatedAt: toIso(row.updated_at),
        archived: row.archived_at !== null,
      },
    ]),
  );
}

/**
 * Create the rows for freshly scraped vacancies *before* their messages are
 * published, so the cards are on the board immediately (`status = submitted`, see
 * `lib/ingest.ts` for why that status is claimable rather than a duplicate).
 *
 * `on conflict do nothing` is the concurrency guard: the primary key catches a
 * repeated `job_id`, `resumes_job_key_idx` catches a second row for the same
 * vacancy. Returns only the rows this call actually created - the caller publishes
 * messages for those alone.
 */
export async function insertSubmittedRows(
  rows: InsertPlan[],
  userId: string,
  cvVersion: string,
  status: string,
): Promise<string[]> {
  if (rows.length === 0) return [];

  const created = await pool().query<{ job_id: string }>(
    `insert into resumes (job_id, user_id, external_id, title, company, source_url, cv_version, status)
     select t.job_id, t.user_id, t.external_id, t.title, t.company, t.source_url, $7, $8
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         as t(job_id, user_id, external_id, title, company, source_url)
     on conflict do nothing
     returning job_id`,
    [
      rows.map((row) => row.jobId),
      rows.map(() => userId),
      rows.map((row) => row.vacancy.external_id),
      rows.map((row) => row.vacancy.title),
      rows.map((row) => row.vacancy.company),
      rows.map((row) => row.vacancy.source_url ?? null),
      cvVersion,
      status,
    ],
  );

  return created.rows.map((row) => row.job_id);
}

/**
 * Compensation for a failed publish: drop the cards this request created. Only rows
 * still in the ingest status are removed, so a row the worker has already claimed
 * (its status moved on) is never touched.
 */
export async function deleteSubmittedRows(jobIds: string[], status: string): Promise<number> {
  if (jobIds.length === 0) return 0;
  const deleted = await pool().query(
    'delete from resumes where job_id = any($1::text[]) and status = $2',
    [jobIds, status],
  );
  return deleted.rowCount ?? 0;
}

/** The artifact paths of one vacancy, for `GET /api/artifacts/<job_id>`. */
export async function jobArtifact(
  jobId: string,
): Promise<{ status: string; pdfUrl: string | null; docxPath: string | null } | null> {
  const rows = await pool().query<{ status: string; pdf_url: string | null; docx_path: string | null }>(
    'select status, pdf_url, docx_path from resumes where job_id = $1',
    [jobId],
  );
  const row = rows.rows[0];
  return row ? { status: row.status, pdfUrl: row.pdf_url, docxPath: row.docx_path } : null;
}
