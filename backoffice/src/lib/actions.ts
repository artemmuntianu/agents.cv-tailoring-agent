import { MAX_ACTION_LENGTH } from './board';
import type { BoardAction, StageId } from './types';

/**
 * The Action field is a `<input list>` + `<datalist>` combobox: the browser supplies
 * the dropdown affordance, the keyboard support and the free text, and this module
 * supplies the order.
 *
 * Suggestions are the catalogue (`board_actions`, loaded with the board) and nothing else:
 * a dialog ranks its own kind first - refusal reasons in the Archive dialog, progress
 * notes in the Move dialog - most used on top, then the rest, so a value typed in either
 * dialog is still one keystroke away in the other. Nothing here is hard-coded: whatever the
 * operator typed last time comes back as a suggestion, and typing a *new* wording stores
 * it (one upsert in the same transaction as the change).
 */

export const MAX_SUGGESTIONS = 50;

export interface SuggestionOptions {
  /** The dialog asking: 'archive' (refusal reasons) or 'move' (progress notes). */
  kind: BoardAction['kind'];
  /** What has been typed so far; empty shows the whole ranked list. */
  query?: string;
  limit?: number;
}

export function rankActions(actions: BoardAction[], options: SuggestionOptions): BoardAction[] {
  const query = (options.query ?? '').trim().toLowerCase();
  const matches = query
    ? actions.filter((action) => action.value.toLowerCase().includes(query))
    : actions.slice();

  matches.sort((a, b) => {
    const sameKind = Number(b.kind === options.kind) - Number(a.kind === options.kind);
    if (sameKind !== 0) return sameKind;
    if (b.uses !== a.uses) return b.uses - a.uses;
    const recent = (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
    if (recent !== 0) return recent;
    return a.value.localeCompare(b.value);
  });

  return matches.slice(0, options.limit ?? MAX_SUGGESTIONS);
}

/**
 * What actually gets stored when the dialog is confirmed: collapsed whitespace, no
 * surrounding spaces, never longer than `resume_history.action` accepts.
 */
export function normalizeAction(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ACTION_LENGTH);
}

/**
 * Add a just-submitted value to the local list (optimistically), so the dropdown
 * offers it immediately even before the next read of `board_actions`.
 */
export function withNewAction(
  actions: BoardAction[],
  rawValue: string,
  kind: BoardAction['kind'],
  now: Date = new Date(),
): BoardAction[] {
  const value = normalizeAction(rawValue);
  if (!value) return actions;

  const existing = actions.find((action) => action.value === value);
  if (existing) {
    return actions.map((action) =>
      action.value === value
        ? { ...action, uses: action.uses + 1, lastUsedAt: now.toISOString() }
        : action,
    );
  }
  return [{ value, kind, uses: 1, lastUsedAt: now.toISOString() }, ...actions];
}

/**
 * The Action wording each dialog starts with, so a routine move is confirmed with one
 * keystroke instead of a retyped phrase.
 *
 * A **default, not a suggestion list**: the field stays free text, and whatever gets confirmed
 * is what the vocabulary learns (the route upserts `board_actions` in the same transaction as
 * the change). Both maps read the way the operator's own trail already reads - `To <column>`
 * for a move, `Not Applicable` for refusing a card nobody has acted on - which is why those
 * strings are already in the catalogue.
 */
const MOVE_DEFAULT: Record<StageId, string> = {
  scraped: 'To Scraped',
  prepare: 'To Prepare',
  applied: 'To Applied',
  negotiating: 'To Negotiating',
  interviewing: 'To Interviewing',
  offer: 'To Offer',
};

/**
 * Only a card still in **Scraped** is `Not Applicable`: no application was ever made, so there
 * is nothing to have been refused. Every other column starts blank - the reason is a judgement
 * call (no response, salary mismatch, ...) that only the operator can make.
 */
const ARCHIVE_DEFAULT: Partial<Record<StageId, string>> = { scraped: 'Not Applicable' };

/** What the Move dialog offers for a card entering `to`. */
export function defaultMoveAction(to: StageId): string {
  return MOVE_DEFAULT[to] ?? '';
}

/** What the Archive dialog offers for a card leaving `from` ('' = nothing prefilled). */
export function defaultArchiveAction(from: StageId): string {
  return ARCHIVE_DEFAULT[from] ?? '';
}
