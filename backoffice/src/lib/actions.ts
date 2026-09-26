import { MAX_ACTION_LENGTH } from './board';
import type { BoardAction } from './types';

/**
 * The Action field is a `<input list>` + `<datalist>` combobox: the browser supplies
 * the dropdown affordance, the keyboard support and the free text, and this module
 * supplies the order.
 *
 * Suggestions come from the persisted vocabulary (`board_actions`, loaded with the
 * board). A dialog ranks its own kind first - refusal reasons in the Archive dialog,
 * progress notes in the Move dialog - most used on top, then the rest - so a value
 * typed in either dialog is still one keystroke away in the other. Nothing here is
 * hard-coded: whatever the operator typed last time comes back as a suggestion.
 */

export const MAX_SUGGESTIONS = 50;

export interface SuggestionOptions {
  /** The dialog asking: 'archive' (refusal reasons) or 'move' (progress notes). */
  kind: BoardAction['kind'];
  /** What has been typed so far; empty shows the whole ranked list. */
  query?: string;
  limit?: number;
  /**
   * Offer values that were retired from the catalogue (still present in history).
   * A dialog does not: it should suggest the wording the operator is keeping.
   */
  includeRetired?: boolean;
}

export function rankActions(actions: BoardAction[], options: SuggestionOptions): BoardAction[] {
  const query = (options.query ?? '').trim().toLowerCase();
  const candidates = options.includeRetired
    ? actions.slice()
    : actions.filter((action) => action.catalogued !== false);
  const matches = query
    ? candidates.filter((action) => action.value.toLowerCase().includes(query))
    : candidates;

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
        ? { ...action, uses: action.uses + 1, lastUsedAt: now.toISOString(), catalogued: true }
        : action,
    );
  }
  return [{ value, kind, uses: 1, lastUsedAt: now.toISOString(), catalogued: true }, ...actions];
}
