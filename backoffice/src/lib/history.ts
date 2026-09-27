import { MAX_ACTION_LENGTH } from './board';
import { toDateTimeLocal } from './interviews';
import { STAGES, TAILORING_STATES, stageLabel, tailoringLabel } from './stages';
import type { HistoryDraft, HistoryEntry, HistoryEntryRequest, HistoryKind } from './types';

/**
 * The History section's vocabulary, and the one write it allows: correcting or dropping a line.
 *
 * A history line *is* the audit trail, so this module is deliberately narrow and explicit about
 * it. The four kinds and the `active`/`archived` pair are the DB CHECKs; the states a line may
 * carry follow from its kind (a `move` carries column ids, a `tailoring` line the worker's
 * sub-states), so a rewrite can never produce a line the card has no label for. Nothing here
 * touches the card: an edit changes what the trail *says*, not where the vacancy stands, and it
 * never writes `board_actions` - fixing a line is not a new action name (invariant 29).
 */

/** The four kinds the DB CHECK allows (`resume_history.kind`). */
export const HISTORY_KINDS: HistoryKind[] = ['move', 'tailoring', 'archive', 'restore'];

/** What each kind is, in the edit dialog's own words. */
export const KIND_LABEL: Record<HistoryKind, string> = {
  move: 'Move — the card changed column',
  tailoring: 'Tailoring — the worker reported a sub-state',
  archive: 'Archive — the vacancy was refused',
  restore: 'Restore — a refusal was undone',
};

/** The two-state vocabulary `archive`/`restore` lines use (never column names). */
export const ARCHIVE_STATES = ['active', 'archived'];

export function isHistoryKind(value: unknown): value is HistoryKind {
  return typeof value === 'string' && (HISTORY_KINDS as string[]).includes(value);
}

/**
 * The states one kind may carry: column ids for a move, the worker's sub-states for a tailoring
 * line, `active`/`archived` for the refusal pair. The route and the dialog both read this.
 */
export function stateOptions(kind: HistoryKind): string[] {
  if (kind === 'move') return STAGES.map((stage) => stage.id);
  if (kind === 'tailoring') return TAILORING_STATES.map((state) => state.id);
  return [...ARCHIVE_STATES];
}

/** Human label for one state, per kind: `Applied`, `Tailored`, `active`. */
export function stateLabel(kind: HistoryKind, state: string): string {
  if (kind === 'move') return stageLabel(state);
  if (kind === 'tailoring') return tailoringLabel(state);
  return state;
}

/**
 * The transition a line falls back to: when the dialog switches kind, or when the stored states
 * belong to another vocabulary. Each pair is the one that made the kind worth recording.
 */
export function defaultTransition(kind: HistoryKind): { from: string; to: string } {
  switch (kind) {
    case 'move':
      return { from: 'scraped', to: 'prepare' };
    case 'tailoring':
      return { from: 'in_progress', to: 'tailored' };
    case 'archive':
      return { from: 'active', to: 'archived' };
    case 'restore':
      return { from: 'archived', to: 'active' };
  }
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function asObject(body: unknown): ParseResult<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  return { ok: true, value: body as Record<string, unknown> };
}

/**
 * Validate a `PATCH /api/board/history/<id>` body: the whole line.
 *
 * Every field is checked against the same constraint the database has, so a rejected edit is a
 * readable message rather than a `23514` - and the two states are checked *against the kind*,
 * which is the check the DB cannot make (`resume_history` has no cross-column constraint: a
 * hand-written row could say `kind='archive', from_state='applied'` and the card would render
 * nonsense). `at` accepts a `datetime-local` value or an ISO timestamp and is stored as ISO.
 */
export function parseHistoryRequest(body: unknown): ParseResult<HistoryEntryRequest> {
  const object = asObject(body);
  if (!object.ok) return object;
  const raw = object.value;

  const atRaw = typeof raw.at === 'string' ? raw.at.trim() : '';
  const at = atRaw ? new Date(atRaw) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return { ok: false, error: 'at must be a date and time' };
  }

  if (raw.actor !== 'Candidate' && raw.actor !== 'Company') {
    return { ok: false, error: 'actor must be "Candidate" or "Company"' };
  }

  const action = typeof raw.action === 'string' ? raw.action.trim() : '';
  if (!action) return { ok: false, error: 'a reason (action) is required' };
  if (action.length > MAX_ACTION_LENGTH) {
    return { ok: false, error: `action must be at most ${MAX_ACTION_LENGTH} characters` };
  }

  if (!isHistoryKind(raw.kind)) {
    return { ok: false, error: `kind must be one of: ${HISTORY_KINDS.join(', ')}` };
  }
  const kind = raw.kind;

  const allowed = stateOptions(kind);
  const from = typeof raw.from === 'string' ? raw.from.trim() : '';
  const to = typeof raw.to === 'string' ? raw.to.trim() : '';
  if (!allowed.includes(from) || !allowed.includes(to)) {
    return {
      ok: false,
      error: `from and to must be one of: ${allowed.join(', ')} for a ${kind} line`,
    };
  }

  return { ok: true, value: { at: at.toISOString(), actor: raw.actor, action, kind, from, to } };
}

/** The edit form's draft from one stored line (`at` becomes a `datetime-local` value). */
export function draftFromHistory(entry: HistoryEntry): HistoryDraft {
  return {
    at: toDateTimeLocal(entry.at),
    actor: entry.actor,
    action: entry.action,
    kind: entry.kind,
    from: entry.from,
    to: entry.to,
  };
}

/**
 * The draft as the API wants it, validated by the very parser the route uses - so a mistake is
 * shown in the dialog instead of coming back as a rejected round trip.
 */
export function draftToRequest(draft: HistoryDraft): ParseResult<HistoryEntryRequest> {
  return parseHistoryRequest(draft);
}
