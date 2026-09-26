import { STAGES, isStageId } from './stages';
import type { Actor, BoardCard, MoveRequest, StageId } from './types';

/** Longest reason the database accepts (`resume_history.action` check). */
export const MAX_ACTION_LENGTH = 500;

const ACTORS: Actor[] = ['Me', 'Them'];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validate a `POST /api/board/move` body. Pure, so the dialog contract is unit
 * tested and the DB checks (`actor in ('Me','Them')`, non-empty action) are never
 * the first thing to reject a bad request.
 */
export function parseMoveRequest(body: unknown): ParseResult<MoveRequest> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const raw = body as Record<string, unknown>;

  const jobId = typeof raw.jobId === 'string' ? raw.jobId.trim() : '';
  if (!jobId) return { ok: false, error: 'jobId is required' };

  if (!isStageId(raw.to)) {
    return { ok: false, error: `to must be one of: ${STAGES.map((stage) => stage.id).join(', ')}` };
  }

  const actor = raw.actor;
  if (actor !== 'Me' && actor !== 'Them') {
    return { ok: false, error: 'actor must be "Me" or "Them"' };
  }

  const action = typeof raw.action === 'string' ? raw.action.trim() : '';
  if (!action) return { ok: false, error: 'a reason (action) is required' };
  if (action.length > MAX_ACTION_LENGTH) {
    return { ok: false, error: `action must be at most ${MAX_ACTION_LENGTH} characters` };
  }

  return { ok: true, value: { jobId, to: raw.to, actor, action } };
}

/** Cards per column, in board order. */
export function groupByStage(cards: BoardCard[]): { stage: StageId; cards: BoardCard[] }[] {
  return STAGES.map((stage) => ({
    stage: stage.id,
    cards: cards
      .filter((card) => card.stage === stage.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));
}

export function countByStage(cards: BoardCard[]): Record<StageId, number> {
  const counts = {} as Record<StageId, number>;
  for (const stage of STAGES) {
    counts[stage.id] = cards.filter((card) => card.stage === stage.id).length;
  }
  return counts;
}
