import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type { ActionInput } from './admin';
import { artifactAvailability } from './artifacts';
import type { ExistingVacancy, InsertPlan } from './ingest';
import { isCommunicationChannel } from './details';
import type {
  ActionRequest,
  Actor,
  ArchiveRequest,
  BoardAction,
  BoardCard,
  Interview,
  InterviewRequest,
  InterviewType,
  DetailsRequest,
  HistoryEntryRequest,
  MoveRequest,
  ProcessRun,
} from './types';

/**
 * Server-only data access. The board reads the worker's `resumes` rows and owns
 * exactly two tables, created by the worker's own schema bootstrap
 * (`utils/db.py::SCHEMA_SQL` - never duplicated here):
 *
 *   resume_board   job_id -> stage (the manual kanban column)
 *   resume_history one row per confirmed manual change
 *
 * `resumes.status` is read-only for the board: it is the worker's claim and
 * idempotency state, and the `prepare` sub-state is derived from it instead.
 */

/*
 * How many cards a board load may carry.
 *
 * Filtering is client-side, so this is the whole board as far as the UI knows: a card beyond
 * the cap is not "further down", it is **absent** - which is exactly how three interview cards
 * went missing after the 2026-09-26 spreadsheet import pushed the board to 236 rows. That
 * import also stamped every card with its own dates: with all of them sharing one `updated_at`,
 * the tie made the cut-off arbitrary.
 */
const BOARD_LIMIT = 1000;

interface CardRow {
  job_id: string;
  external_id: string;
  source: string;
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
  has_description: boolean;
  stage: string;
  archived_at: Date | string | null;
  archived_actor: string | null;
  archived_reason: string | null;
  recruiter: string | null;
  salary_offered: string | null;
  salary_desired: string | null;
  communication_channels: string[] | null;
  cover_status: string | null;
  cover_text: string | null;
  cover_error: string | null;
  cover_model: string | null;
  cover_updated_at: Date | string | null;
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

interface InterviewRow {
  id: number;
  job_id: string;
  scheduled_at: Date | string;
  type: string;
  result: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toInterview(row: InterviewRow): Interview {
  return {
    id: row.id,
    jobId: row.job_id,
    scheduledAt: toIso(row.scheduled_at),
    type: row.type as InterviewType,
    result: row.result,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
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
  select r.job_id, r.external_id, r.source, r.title, r.company, r.source_url, r.cv_version,
         r.status, r.attempts, r.revision_count, r.duration_ms, r.error,
         r.pdf_url, r.docx_path, r.created_at, r.updated_at,
         (r.description_raw is not null) as has_description,
         coalesce(b.stage, 'scraped') as stage,
         b.archived_at, b.archived_actor, b.archived_reason,
         b.recruiter, b.salary_offered, b.salary_desired, b.communication_channels,
         c.status as cover_status, c.text as cover_text, c.error as cover_error,
         c.model as cover_model, c.updated_at as cover_updated_at
    from resumes r
    left join resume_board b on b.job_id = r.job_id
    left join resume_cover_letter c on c.job_id = r.job_id`;

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

/**
 * The interviews of these cards (`resume_interview`), oldest first.
 *
 * Read with the history, and for the same reason: the card payload has to be complete, because
 * the board caches nothing - and these rows are deliberately *not* in `resume_history`
 * (`CONSTITUTION.md` invariant 26).
 */
async function fetchInterviews(jobIds: string[]): Promise<InterviewRow[]> {
  const interviews = await pool().query<InterviewRow>(
    `select id, job_id, scheduled_at, type, result, created_at, updated_at
       from resume_interview
      where job_id = any($1::text[])
      order by scheduled_at asc, id asc`,
    [jobIds],
  );
  return interviews.rows;
}

function toCard(
  row: CardRow,
  history: HistoryRow[],
  interviews: InterviewRow[] = [],
): BoardCard {
  return {
    jobId: row.job_id,
    externalId: row.external_id,
    source: row.source,
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
    // The card's own detail fields. Channels arrive as a `text[]`; anything the vocabulary
    // does not know is dropped here as well as refused on the way in, so a hand-edited row can
    // never make the form render an unknown option.
    details: {
      recruiter: row.recruiter,
      salaryOffered: row.salary_offered,
      salaryDesired: row.salary_desired,
      communicationChannels: (row.communication_channels ?? []).filter(isCommunicationChannel),
    },
    // The worker stored these paths; whether *this* board can serve them depends on its
    // artifact root (a mirror, in dev) - so the UI never offers a link that would 404.
    artifactAvailability: artifactAvailability(row.pdf_url, row.docx_path),
    hasDescription: row.has_description === true,
    coverLetter:
      row.cover_status === null
        ? null
        : {
            status: row.cover_status,
            text: row.cover_text,
            error: row.cover_error,
            model: row.cover_model,
            updatedAt: row.cover_updated_at === null ? null : toIso(row.cover_updated_at),
          },
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
    interviews: interviews
      .filter((entry) => entry.job_id === row.job_id)
      .map(toInterview),
  };
}

export async function fetchBoard(): Promise<BoardCard[]> {
  const cards = await pool().query<CardRow>(
    `${CARD_SELECT} order by r.updated_at desc nulls last limit $1`,
    [BOARD_LIMIT],
  );
  if (cards.rows.length === 0) return [];

  const jobIds = cards.rows.map((row) => row.job_id);
  const [history, interviews] = await Promise.all([
    fetchHistory(jobIds),
    fetchInterviews(jobIds),
  ]);
  return cards.rows.map((row) => toCard(row, history, interviews));
}

/** One card, used to answer a mutation with the row it just wrote. */
export async function fetchCard(jobId: string): Promise<BoardCard | null> {
  const rows = await pool().query<CardRow>(`${CARD_SELECT} where r.job_id = $1`, [jobId]);
  const row = rows.rows[0];
  if (!row) return null;
  const [history, interviews] = await Promise.all([
    fetchHistory([jobId]),
    fetchInterviews([jobId]),
  ]);
  return toCard(row, history, interviews);
}

/**
 * Confirm a manual move: the board row and its history entry are written in one
 * transaction, so a card can never move without a recorded reason.
 * Returns the updated card, or null when the vacancy does not exist.
 */
export async function moveCard(
  move: MoveRequest,
  interview?: InterviewRequest | null,
): Promise<BoardCard | null> {
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
    const from = current.rows[0]?.stage ?? 'scraped';

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
    // Entering Interviewing can carry the first interview the dialog collected - in the *same*
    // transaction, so a card can never claim the column without it (or the other way round).
    // An empty draft inserts nothing: the section's `➕ Add` is where an unscheduled one lives.
    if (interview && move.to === 'interviewing') {
      await insertInterviewRow(client, move.jobId, interview);
    }
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
 * Record an action **without** moving the card - the card's `➕ Add action` button.
 *
 * The column is read and written back untouched (a card without a board row is seeded as
 * `scraped`, exactly like the column default), while `updated_at` moves: that is what makes an
 * action count as activity for the date window *and* for the inactivity sweep, so recording
 * "recruiter called back" is how a card escapes the ten-day rule.
 *
 * The history row is a `move` whose `from_state = to_state`: the DB's kind CHECK has no
 * separate kind for "something happened, nothing moved", and inventing one would change the
 * audit vocabulary for a button.
 */
export async function appendAction(request: ActionRequest): Promise<BoardCard | null> {
  const client = await pool().connect();
  try {
    await client.query('begin');

    const known = await client.query('select 1 as ok from resumes where job_id = $1', [
      request.jobId,
    ]);
    if (known.rowCount === 0) {
      await client.query('rollback');
      return null;
    }

    const current = await client.query<{ stage: string | null }>(
      'select stage from resume_board where job_id = $1',
      [request.jobId],
    );
    const stage = current.rows[0]?.stage ?? 'scraped';

    await client.query(
      `insert into resume_board (job_id, stage, updated_at) values ($1, $2, now())
       on conflict (job_id) do update set updated_at = now()`,
      [request.jobId, stage],
    );
    await client.query(
      `insert into resume_history (job_id, actor, action, kind, from_state, to_state)
       values ($1, $2, $3, 'move', $4, $4)`,
      [request.jobId, request.actor, request.action, stage],
    );
    await recordAction(client, request.action, 'move');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return fetchCard(request.jobId);
}

/**
 * Save the card's own details - the recruiter, the two salaries and the channels.
 *
 * The four fields are replaced as a set (the form sends all of them, so there is no diff to
 * merge) and `updated_at` moves with them: typing a recruiter **is** operator activity, so the
 * card surfaces in the date window and the inactivity sweep leaves it alone for another ten
 * days. No `resume_history` row - like the interviews, these are card attributes rather than a
 * funnel transition, and a History full of "salary typed" lines would bury the moves.
 *
 * A card without a board row is seeded as `scraped`, exactly like the column default.
 */
export async function updateDetails(request: DetailsRequest): Promise<BoardCard | null> {
  const client = await pool().connect();
  try {
    await client.query('begin');

    const known = await client.query('select 1 as ok from resumes where job_id = $1', [
      request.jobId,
    ]);
    if (known.rowCount === 0) {
      await client.query('rollback');
      return null;
    }

    await client.query(
      `insert into resume_board
          (job_id, stage, recruiter, salary_offered, salary_desired, communication_channels,
           updated_at)
       values ($1, 'scraped', $2, $3, $4, $5, now())
       on conflict (job_id) do update
          set recruiter = excluded.recruiter,
              salary_offered = excluded.salary_offered,
              salary_desired = excluded.salary_desired,
              communication_channels = excluded.communication_channels,
              updated_at = now()`,
      [
        request.jobId,
        request.recruiter,
        request.salaryOffered,
        request.salaryDesired,
        request.communicationChannels,
      ],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return fetchCard(request.jobId);
}

/**
 * The one insert both the move-into-Interviewing path and `POST …/interviews` use, so the two
 * can never disagree about which columns an interview has.
 */
const INTERVIEW_INSERT =
  'insert into resume_interview (job_id, scheduled_at, type, result)' +
  ' values ($1, $2, $3, $4) returning id';

async function insertInterviewRow(
  client: PoolClient,
  jobId: string,
  interview: InterviewRequest,
): Promise<number> {
  const inserted = await client.query<{ id: number }>(INTERVIEW_INSERT, [
    jobId,
    interview.scheduledAt,
    interview.type,
    interview.result,
  ]);
  return inserted.rows[0].id;
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

// -- removal (the board's only irreversible action) ---------------------------- #

/** What a removal has to know before it deletes anything. */
export interface CardForRemoval {
  status: string;
  archived: boolean;
  pdfUrl: string | null;
  docxPath: string | null;
}

export async function cardForRemoval(jobId: string): Promise<CardForRemoval | null> {
  const rows = await pool().query<{
    status: string;
    archived_at: Date | string | null;
    pdf_url: string | null;
    docx_path: string | null;
  }>(
    `select r.status, b.archived_at, r.pdf_url, r.docx_path
       from resumes r
       left join resume_board b on b.job_id = r.job_id
      where r.job_id = $1`,
    [jobId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    status: row.status,
    archived: row.archived_at !== null,
    pdfUrl: row.pdf_url,
    docxPath: row.docx_path,
  };
}

/**
 * Remove the card for good: the `resumes` row, its board state and its **entire** history
 * (`resume_board` and `resume_history` cascade from it). No tombstone is written - that is
 * what removal means here (invariant 22) - so the vacancy becomes unknown to the system
 * again and re-scraping its page starts from scratch.
 *
 * The caller must have read the artifact paths first: this deletes the only record of them.
 */
export async function purgeCard(jobId: string): Promise<boolean> {
  const deleted = await pool().query('delete from resumes where job_id = $1', [jobId]);
  return (deleted.rowCount ?? 0) > 0;
}

/**
 * Record the artifact paths this board could not delete, so the cluster volume can be swept
 * later (`scripts/storage-files.ps1 -Action purge`). Idempotent per path: re-queueing only
 * moves the row's job id and timestamp.
 */
export async function queueArtifactPurge(jobId: string, storedPaths: string[]): Promise<number> {
  if (storedPaths.length === 0) return 0;
  const queued = await pool().query(
    `insert into artifact_purge (stored_path, job_id)
     select * from unnest($1::text[], $2::text[])
     on conflict (stored_path) do update set job_id = excluded.job_id, queued_at = now()`,
    [storedPaths, storedPaths.map(() => jobId)],
  );
  return queued.rowCount ?? 0;
}

/** What is still waiting for the volume sweep (the admin page and the script both read it). */
export async function pendingArtifactPurge(): Promise<
  { storedPath: string; jobId: string; queuedAt: string }[]
> {
  const rows = await pool().query<{ stored_path: string; job_id: string; queued_at: Date | string }>(
    'select stored_path, job_id, queued_at from artifact_purge order by queued_at asc',
  );
  return rows.rows.map((row) => ({
    storedPath: row.stored_path,
    jobId: row.job_id,
    queuedAt: toIso(row.queued_at),
  }));
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

    // No board row yet (a card still in Scraped): the insert seeds stage 'scraped',
    // exactly like the column default.
    await client.query(
      `insert into resume_board (job_id, stage, archived_at, archived_actor, archived_reason, updated_at)
       values ($1, 'scraped', now(), $2, $3, now())
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
 * The vacancies in this batch, keyed by `external_id`.
 *
 * `scope` decides whose rows count:
 *
 * Both scopes are per **site**: `source` is half of the vacancy's identity (djinni's
 * 848944 and DOU's 848944 are different vacancies), so a lookup always asks about one.
 *
 *   `'user'`  (default) - the rows this account owns, the way the worker's business key
 *               (`coalesce(user_id,'local') : source : external_id : cv_version`) sees them.
 *   `'board'` - **any** row for that vacancy + CV version, which is what the operator can
 *               actually see: the board renders every row regardless of `user_id`, so a
 *               lookup scoped to one account would offer to scrape a card that is already
 *               there (and a second row for it would then appear as a duplicate card).
 *               Cards created by the CLI/smoke test carry `user_id = NULL`, which is exactly
 *               the case that exposed this (2026-09-26).
 *
 * `archived_at` is part of the answer because a refused vacancy must never be queued again
 * (see `lib/ingest.ts`). When several rows match a board-scoped lookup, the most recently
 * touched one wins.
 */
export async function findExistingVacancies(
  userId: string | null,
  externalIds: string[],
  cvVersion: string,
  options: { scope?: 'user' | 'board'; source?: string } = {},
): Promise<Map<string, ExistingVacancy>> {
  if (externalIds.length === 0) return new Map();
  const boardScope = (options.scope ?? 'user') === 'board';
  const source = options.source ?? 'djinni';

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
      where r.cv_version = $2
        and r.external_id = any($3::text[])
        and r.source = $5
        and ($4::boolean or coalesce(r.user_id, 'local') = coalesce($1, 'local'))
      order by r.updated_at desc`,
    [userId, cvVersion, externalIds, boardScope, source],
  );

  const found = new Map<string, ExistingVacancy>();
  for (const row of rows.rows) {
    if (found.has(row.external_id)) continue; // ordered newest first
    found.set(row.external_id, {
      jobId: row.job_id,
      status: row.status,
      updatedAt: toIso(row.updated_at),
      archived: row.archived_at !== null,
    });
  }
  return found;
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
  source: string,
): Promise<string[]> {
  if (rows.length === 0) return [];

  const created = await pool().query<{ job_id: string }>(
    `insert into resumes (job_id, user_id, external_id, source, title, company, source_url,
                          description_raw, cv_version, status)
     select t.job_id, t.user_id, t.external_id, $10, t.title, t.company, t.source_url,
            t.description_raw, $8, $9
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[])
         as t(job_id, user_id, external_id, title, company, source_url, description_raw)
     on conflict do nothing
     returning job_id`,
    [
      rows.map((row) => row.jobId),
      rows.map(() => userId),
      rows.map((row) => row.vacancy.external_id),
      rows.map((row) => row.vacancy.title),
      rows.map((row) => row.vacancy.company),
      rows.map((row) => row.vacancy.source_url ?? null),
      rows.map((row) => row.vacancy.description_raw),
      cvVersion,
      status,
      source,
    ],
  );

  return created.rows.map((row) => row.job_id);
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

/** Everything one card needs to become a `ResumeTaskMessage` - and its current state. */
export interface TaskMessageRow {
  jobId: string;
  userId: string | null;
  externalId: string;
  source: string;
  cvVersion: string;
  title: string;
  company: string;
  sourceUrl: string | null;
  /** `resumes.description_raw`; null for rows that predate the column (2026-09-26). */
  descriptionRaw: string | null;
  status: string;
  stage: string;
}

/**
 * Read the row that a drag into Prepare has to queue, plus the state the caller judges it by
 * (`stage`/`status` feed `lib/board.ts::tailoringRequest`).
 *
 * `user_id` is read, not assumed: the message must carry the *row's* owner or the worker's
 * claim would look up a different business key and insert a second card for the same vacancy.
 */
export async function taskMessageRow(jobId: string): Promise<TaskMessageRow | null> {
  const rows = await pool().query<{
    job_id: string;
    user_id: string | null;
    external_id: string;
    source: string;
    cv_version: string;
    title: string | null;
    company: string | null;
    source_url: string | null;
    description_raw: string | null;
    status: string;
    stage: string;
  }>(
    `select r.job_id, r.user_id, r.external_id, r.source, r.cv_version, r.title, r.company,
            r.source_url, r.description_raw, r.status,
            coalesce(b.stage, 'scraped') as stage
       from resumes r
       left join resume_board b on b.job_id = r.job_id
      where r.job_id = $1`,
    [jobId],
  );
  const row = rows.rows[0];
  if (!row) return null;

  return {
    jobId: row.job_id,
    userId: row.user_id,
    externalId: row.external_id,
    source: row.source,
    cvVersion: row.cv_version,
    title: row.title ?? '',
    company: row.company ?? '',
    sourceUrl: row.source_url,
    descriptionRaw: row.description_raw,
    status: row.status,
    stage: row.stage,
  };
}


/**
 * Record that the operator asked for a cover letter.
 *
 * Returns false when a letter is *being written right now*: two clicks must not queue two
 * generations, and the `where` on the upsert is what makes that impossible without a lock.
 * Setting the row to `queued` is also what turns a *regeneration* into a genuine request -
 * `cover.py` treats only `completed` as a duplicate.
 */
export async function markCoverRequested(jobId: string): Promise<boolean> {
  const result = await pool().query(
    `insert into resume_cover_letter (job_id, status) values ($1, 'queued')
     on conflict (job_id) do update
        set status = 'queued', error = null, updated_at = now()
      where resume_cover_letter.status <> 'running'`,
    [jobId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The publish failed, so nothing is on its way: the row must not keep claiming `queued`.
 * `failed` is honest, and the modal's *Try again* resets it.
 */
export async function failCoverRequest(jobId: string, error: string): Promise<void> {
  await pool().query(
    `insert into resume_cover_letter (job_id, status, error) values ($1, 'failed', $2)
     on conflict (job_id) do update
        set status = 'failed', error = excluded.error, updated_at = now()`,
    [jobId, error.slice(0, 500)],
  );
}

// -- interviews (the section's own record, never the history) ------------------- #

/** The answer of an interview write: the card it changed, or why it could not. */
export type InterviewWrite = { ok: true; card: BoardCard } | { ok: false; reason: 'unknown' };

/**
 * Add an interview to a card - the section's `➕ Add`, and the same insert the move into
 * Interviewing makes. The card is re-read afterwards (the database is the display).
 */
export async function insertInterview(
  jobId: string,
  interview: InterviewRequest,
): Promise<InterviewWrite> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    const known = await client.query('select 1 as ok from resumes where job_id = $1', [jobId]);
    if (known.rowCount === 0) {
      await client.query('rollback');
      return { ok: false, reason: 'unknown' };
    }
    await insertInterviewRow(client, jobId, interview);
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

/**
 * Edit one interview: its date & time, its type and the `result` the operator wrote down.
 *
 * No history row and no `resume_board` touch: the interview list *is* the interview history, so
 * correcting a date is not an audited change of the application (invariant 26).
 */
export async function updateInterview(
  id: number,
  interview: InterviewRequest,
): Promise<InterviewWrite> {
  const updated = await pool().query<{ job_id: string }>(
    `update resume_interview
        set scheduled_at = $2, type = $3, result = $4, updated_at = now()
      where id = $1
     returning job_id`,
    [id, interview.scheduledAt, interview.type, interview.result],
  );
  const jobId = updated.rows[0]?.job_id;
  if (!jobId) return { ok: false, reason: 'unknown' };
  const card = await fetchCard(jobId);
  return card ? { ok: true, card } : { ok: false, reason: 'unknown' };
}

/** Remove one interview. The card, its column and its history are untouched. */
export async function deleteInterview(id: number): Promise<InterviewWrite> {
  const deleted = await pool().query<{ job_id: string }>(
    'delete from resume_interview where id = $1 returning job_id',
    [id],
  );
  const jobId = deleted.rows[0]?.job_id;
  if (!jobId) return { ok: false, reason: 'unknown' };
  const card = await fetchCard(jobId);
  return card ? { ok: true, card } : { ok: false, reason: 'unknown' };
}

// -- history lines (the audit trail, correctable by hand) ----------------------- #

/** The answer of a history write: the card it changed, or why it could not. */
export type HistoryWrite = { ok: true; card: BoardCard } | { ok: false; reason: 'unknown' };

/**
 * Rewrite what one history line says: its date, actor, wording, kind and both states.
 *
 * The whole line in one statement, because a half-updated row is a lie: `resume_history` has no
 * `updated_at`, so this is a record *fix* rather than an audited change, and the card it belongs to
 * is re-read afterwards (the database is the display). Deliberately untouched: `resume_board` (no
 * `updated_at` bump, so a correction is not operator activity and cannot dodge the inactivity
 * sweep), `board_actions` (the wording is corrected in place, the vocabulary is not widened) and
 * every other row of the card's trail.
 */
export async function updateHistoryLine(
  id: number,
  line: HistoryEntryRequest,
): Promise<HistoryWrite> {
  const updated = await pool().query<{ job_id: string }>(
    `update resume_history
        set at = $2, actor = $3, action = $4, kind = $5, from_state = $6, to_state = $7
      where id = $1
     returning job_id`,
    [id, line.at, line.actor, line.action, line.kind, line.from, line.to],
  );
  const jobId = updated.rows[0]?.job_id;
  if (!jobId) return { ok: false, reason: 'unknown' };
  const card = await fetchCard(jobId);
  return card ? { ok: true, card } : { ok: false, reason: 'unknown' };
}

/**
 * Drop one history line - the operator's own bad record, not a card.
 *
 * Removing a line never re-derives anything: the card keeps its column, its archive flags and its
 * remaining trail. The one visible consequence outside History is the **Interviews** section, which
 * is shown on the strength of a `move` into Interviewing (`hasReachedInterviewing`): if this is
 * that line and the card has moved on, the section disappears while the interview rows stay on the
 * card - which is why the confirm dialog spells it out.
 */
export async function deleteHistoryLine(id: number): Promise<HistoryWrite> {
  const deleted = await pool().query<{ job_id: string }>(
    'delete from resume_history where id = $1 returning job_id',
    [id],
  );
  const jobId = deleted.rows[0]?.job_id;
  if (!jobId) return { ok: false, reason: 'unknown' };
  const card = await fetchCard(jobId);
  return card ? { ok: true, card } : { ok: false, reason: 'unknown' };
}

// -- the internal process ledger (the navbar's Processes window) ---------------- #

/**
 * The recent runs of the internal processes, newest first.
 *
 * The rows are the jobs' own (`utils/process_runs.py`): a run that found nothing is a row like
 * any other, and a job whose pod was killed shows up as `running` until the next run of that
 * job retires it as `aborted`.
 */
export async function fetchProcessRuns(limit = 100): Promise<ProcessRun[]> {
  const rows = await pool().query<{
    id: number;
    process: string;
    trigger: string;
    started_at: Date | string;
    finished_at: Date | string | null;
    status: string;
    summary: unknown;
    error: string | null;
  }>(
    `select id, process, trigger, started_at, finished_at, status, summary, error
       from process_runs
      order by started_at desc, id desc
      limit $1`,
    [Math.max(1, Math.min(500, Math.trunc(limit)))],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    process: row.process,
    trigger: row.trigger === 'manual' ? 'manual' : 'schedule',
    startedAt: toIso(row.started_at),
    finishedAt: row.finished_at === null ? null : toIso(row.finished_at),
    status: row.status as ProcessRun['status'],
    summary: (row.summary as Record<string, unknown> | null) ?? null,
    error: row.error,
  }));
}
