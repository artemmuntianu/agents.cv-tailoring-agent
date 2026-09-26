import { STAGES, describeHistory, isStageId } from './stages';
import type { Actor, ArchiveRequest, BoardCard, HistoryEntry, MoveRequest, StageId } from './types';

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
  const object = asObject(body);
  if (!object.ok) return object;
  const jobId = parseJobId(object.value);
  return jobId.ok ? { ok: true, value: { jobId: jobId.value } } : jobId;
}

/** Cards per column, in board order, newest change first. */
export function groupByStage(cards: BoardCard[]): { stage: StageId; cards: BoardCard[] }[] {
  return STAGES.map((stage) => ({
    stage: stage.id,
    cards: cards
      .filter((card) => card.stage === stage.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
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

