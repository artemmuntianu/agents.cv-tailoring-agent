import { STAGES, describeHistory, isStageId } from './stages';
import type {
  ActionRequest,
  Actor,
  ArchiveRequest,
  BoardCard,
  HistoryEntry,
  MoveRequest,
  StageId,
} from './types';

/** Longest reason the database accepts (`resume_history.action` check). */
export const MAX_ACTION_LENGTH = 500;

/** The Actor dropdown, spelled exactly like the DB CHECK. */
export const ACTORS: Actor[] = ['Candidate', 'Company'];

/**
 * The action recorded when a card is restored. Restore is deliberately one click (the
 * UI has nothing to ask), but the change still gets a history row - that is the
 * board's "no silent change" rule, not a place for free text.
 */
export const RESTORE_ACTION = 'Restored to the active pipeline';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJobId(raw: Record<string, unknown>): ParseResult<string> {
  const jobId = typeof raw.jobId === 'string' ? raw.jobId.trim() : '';
  if (!jobId) return { ok: false, error: 'jobId is required' };
  return { ok: true, value: jobId };
}

/** The bodies that carry nothing but a job id (restore, remove). */
function parseJobIdBody(body: unknown): ParseResult<{ jobId: string }> {
  const object = asObject(body);
  if (!object.ok) return object;
  const jobId = parseJobId(object.value);
  return jobId.ok ? { ok: true, value: { jobId: jobId.value } } : jobId;
}

function parseActor(raw: unknown): ParseResult<Actor> {
  if (raw !== 'Candidate' && raw !== 'Company') {
    return { ok: false, error: 'actor must be "Candidate" or "Company"' };
  }
  return { ok: true, value: raw };
}

/** The reason both the move and the archive dialog collect (1..500 chars). */
function parseAction(raw: unknown): ParseResult<string> {
  const action = typeof raw === 'string' ? raw.trim() : '';
  if (!action) return { ok: false, error: 'a reason (action) is required' };
  if (action.length > MAX_ACTION_LENGTH) {
    return { ok: false, error: `action must be at most ${MAX_ACTION_LENGTH} characters` };
  }
  return { ok: true, value: action };
}

function asObject(body: unknown): ParseResult<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  return { ok: true, value: body as Record<string, unknown> };
}

/**
 * Validate a `POST /api/board/move` body. Pure, so the dialog contract is unit
 * tested and the DB checks (`actor in ('Candidate','Company')`, non-empty action)
 * are never the first thing to reject a bad request.
 */
export function parseMoveRequest(body: unknown): ParseResult<MoveRequest> {
  const object = asObject(body);
  if (!object.ok) return object;
  const raw = object.value;

  const jobId = parseJobId(raw);
  if (!jobId.ok) return jobId;

  if (!isStageId(raw.to)) {
    // 'archived' is not a stage: refusing a vacancy keeps it in its column.
    return { ok: false, error: `to must be one of: ${STAGES.map((stage) => stage.id).join(', ')}` };
  }

  const actor = parseActor(raw.actor);
  if (!actor.ok) return actor;

  const action = parseAction(raw.action);
  if (!action.ok) return action;

  return { ok: true, value: { jobId: jobId.value, to: raw.to, actor: actor.value, action: action.value } };
}

/**
 * Validate a `POST /api/board/action` body - the card's `➕ Add action` button.
 *
 * Deliberately the Archive dialog's shape (actor + reason, **no column**): the route records
 * the action and leaves the card where it is, so there is no `to` to validate and nothing to
 * queue. The MoveVacancy *dialog* is reused in the UI, not the move route - in Prepare a
 * `to === stage` move is a tailoring retry, which an action must never be.
 */
export function parseActionRequest(body: unknown): ParseResult<ActionRequest> {
  const object = asObject(body);
  if (!object.ok) return object;
  const raw = object.value;

  const jobId = parseJobId(raw);
  if (!jobId.ok) return jobId;

  const actor = parseActor(raw.actor);
  if (!actor.ok) return actor;

  const action = parseAction(raw.action);
  if (!action.ok) return action;

  return { ok: true, value: { jobId: jobId.value, actor: actor.value, action: action.value } };
}

/** Validate a `POST /api/board/archive` body (the refusal dialog). */
export function parseArchiveRequest(body: unknown): ParseResult<ArchiveRequest> {
  const object = asObject(body);
  if (!object.ok) return object;
  const raw = object.value;

  const jobId = parseJobId(raw);
  if (!jobId.ok) return jobId;

  const actor = parseActor(raw.actor);
  if (!actor.ok) return actor;

  const action = parseAction(raw.action);
  if (!action.ok) return action;

  return { ok: true, value: { jobId: jobId.value, actor: actor.value, action: action.value } };
}

/** Validate a `POST /api/board/restore` body: a job id and nothing else. */
export function parseRestoreRequest(body: unknown): ParseResult<{ jobId: string }> {
  return parseJobIdBody(body);
}

/**
 * Validate a `POST /api/board/remove` body. Removal is the only irreversible action on the
 * board, so its route additionally checks that the card is archived and that no worker owns
 * the vacancy any more (see `REMOVABLE_STATUSES`).
 */
export function parseRemoveRequest(body: unknown): ParseResult<{ jobId: string }> {
  return parseJobIdBody(body);
}

/**
 * Statuses after which a card may be removed.
 *
 * A vacancy a worker still owns is excluded: the task writes its artifacts when it finishes,
 * so purging the row mid-flight would leave the files behind with nothing pointing at them
 * (and the worker's next `update` would silently touch no rows). `submitted` is in that
 * in-flight set on purpose - a message may still be queued.
 */
export const REMOVABLE_STATUSES = [
  'completed',
  'skipped',
  'failed',
  'rate_limited',
  'dead_lettered',
];

export function isRemovableStatus(status: string): boolean {
  return REMOVABLE_STATUSES.includes((status || '').toLowerCase());
}

/**
 * Which way a column reads. `desc` (newest first) is the default everywhere - a board opens on
 * what just changed - and each column header can flip only its own list.
 */
export type SortDirection = 'desc' | 'asc';

/**
 * Order one column's cards by their **last change** (`updatedAt`): the same date the filters
 * window uses and the same one the inactivity sweep counts, so "newest" means one thing on this
 * board. Never `createdAt` - a card scraped a month ago but moved today is this week's work.
 */
export function sortCards(cards: BoardCard[], direction: SortDirection = 'desc'): BoardCard[] {
  const sign = direction === 'desc' ? -1 : 1;
  return [...cards].sort((a, b) => sign * a.updatedAt.localeCompare(b.updatedAt));
}

/**
 * Cards per column, in board order, newest change first - the default every column opens with.
 * A flipped column goes through `sortCards` itself, so the direction lives in one place.
 */
export function groupByStage(cards: BoardCard[]): { stage: StageId; cards: BoardCard[] }[] {
  return STAGES.map((stage) => ({
    stage: stage.id,
    cards: sortCards(
      cards.filter((card) => card.stage === stage.id),
      'desc',
    ),
  }));
}

/** Active cards per column (what the board counts when archived are hidden). */
export function countByStage(cards: BoardCard[]): Record<StageId, number> {
  const counts = {} as Record<StageId, number>;
  for (const stage of STAGES) {
    counts[stage.id] = cards.filter((card) => card.stage === stage.id && !card.archived).length;
  }
  return counts;
}

/** `[ active | ⛔️ archived ]` per column header. */
export function countColumns(
  cards: BoardCard[],
): { stage: StageId; active: number; archived: number; total: number }[] {
  return STAGES.map((stage) => {
    const inColumn = cards.filter((card) => card.stage === stage.id);
    const archived = inColumn.filter((card) => card.archived).length;
    return { stage: stage.id, active: inColumn.length - archived, archived, total: inColumn.length };
  });
}

export function countArchived(cards: BoardCard[]): number {
  return cards.filter((card) => card.archived).length;
}

/** One history line for the card modal, e.g. `archived: active → refused`. */
export function historyLine(entry: HistoryEntry): string {
  return describeHistory(entry.kind, entry.from, entry.to);
}


/**
 * What entering the `prepare` column asks for - the one place the board decides to spend
 * Gemini.
 *
 * The pipeline is **operator-triggered**: scraping (the browser extension, the scheduled
 * scout) only creates cards in Scraped, and this turns the drag into a queue message
 * (`POST /api/board/move`):
 *
 *   `'queue'` - the card was not in Prepare and nothing is running for it: publish once;
 *   `'retry'` - it is already in Prepare with a parked status, so the drag *is* the retry
 *               (no stage change and no history noise);
 *   `'none'`  - nothing to do: an active row is queued or already tailored (the worker would
 *               ack the message as a duplicate), or the target is another column.
 *
 * The status sets mirror `utils/db.py`: `RUNNING_STATUSES` + `DONE_STATUSES` are what
 * `ACTIVE_STATUSES` means on the worker side, plus `skipped` (a completed outcome the worker
 * wrote without producing a new document). Keep them in sync deliberately.
 */
export type TailoringRequest = 'queue' | 'retry' | 'none';

const RUNNING_STATUSES = ['queued', 'processing', 'rendering', 'validating', 'uploading'];
const DONE_STATUSES = ['completed', 'skipped'];
const PARKED_STATUSES = ['failed', 'rate_limited', 'dead_lettered'];

export function tailoringRequest(stage: string, status: string, to: string): TailoringRequest {
  if (to !== 'prepare') return 'none';

  const current = (status || '').toLowerCase();
  if (stage === 'prepare') {
    return PARKED_STATUSES.includes(current) ? 'retry' : 'none';
  }
  return RUNNING_STATUSES.includes(current) || DONE_STATUSES.includes(current) ? 'none' : 'queue';
}
