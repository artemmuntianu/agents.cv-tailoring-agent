import { normalizeAction } from './actions';
import type { BoardAction } from './types';

/**
 * The vocabulary admin surface: what an administrator may change, and what is fixed in
 * code. This module is the pure half - no database, no Astro - so the rules are unit
 * tested and the routes only translate an outcome into a status code.
 *
 * Three of the four vocabularies are deliberately read-only:
 *
 *   Actors    `Candidate` | `Company`  - a DB CHECK (`resume_history.actor`)
 *   Stages    the five columns         - the board's shape (`stages.ts`, `isStageId`)
 *   Sub-states Tailoring In Progress…  - *derived* from the worker's `resumes.status`
 *
 * Only **Actions** are data: `board_actions` is what the comboboxes suggest and the
 * Filters panel lists, so it is the one list an administrator edits here.
 */

/** The only paths that require `app_users.is_admin` (enforced in `middleware.ts`). */
export const ADMIN_PREFIXES = ['/admin', '/api/admin'];

export function isAdminPath(pathname: string): boolean {
  return ADMIN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export type VocabularyKind = 'archive' | 'move';

export const VOCABULARY_KINDS: { id: VocabularyKind; label: string; hint: string }[] = [
  { id: 'archive', label: '⛔️ Refusal reason', hint: 'offered in the Archive dialog' },
  { id: 'move', label: '→ Progress note', hint: 'offered in the Move dialog' },
];

export function isVocabularyKind(value: unknown): value is VocabularyKind {
  return value === 'archive' || value === 'move';
}

export interface ActionInput {
  value: string;
  kind: VocabularyKind;
}

export interface RenameInput {
  from: string;
  to: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function asObject(body: unknown): ParseResult<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  return { ok: true, value: body as Record<string, unknown> };
}

/** One catalogue key: collapsed whitespace, trimmed, within the DB's length limit. */
function parseValue(raw: unknown, field: string): ParseResult<string> {
  const value = normalizeAction(typeof raw === 'string' ? raw : '');
  if (!value) return { ok: false, error: `${field} is required` };
  return { ok: true, value };
}

/** `POST /api/admin/actions` - add an entry to the vocabulary. */
export function parseActionInput(body: unknown): ParseResult<ActionInput> {
  const object = asObject(body);
  if (!object.ok) return object;

  const value = parseValue(object.value.value, 'value');
  if (!value.ok) return value;

  const kind = object.value.kind;
  if (!isVocabularyKind(kind)) {
    return { ok: false, error: 'kind must be "archive" or "move"' };
  }
  return { ok: true, value: { value: value.value, kind } };
}

/**
 * `PATCH /api/admin/actions` - reword an entry.
 *
 * The catalogue row is replaced, never the past: history entries keep the words they
 * were recorded with (they are the audit trail), and until they are gone the old value
 * still appears in the Filters panel marked as retired.
 */
export function parseRenameInput(body: unknown): ParseResult<RenameInput> {
  const object = asObject(body);
  if (!object.ok) return object;

  const from = parseValue(object.value.from, 'from');
  if (!from.ok) return from;

  const to = parseValue(object.value.to, 'to');
  if (!to.ok) return to;

  if (from.value.toLowerCase() === to.value.toLowerCase()) {
    return { ok: false, error: 'the new wording is the same as the current one' };
  }
  return { ok: true, value: { from: from.value, to: to.value } };
}

/** `DELETE /api/admin/actions?value=...` */
export function parseActionValue(raw: string | null | undefined): ParseResult<string> {
  return parseValue(raw, 'value');
}

/** Stable table order: catalogued first, then most used, then alphabetically. */
export function sortVocabulary(actions: BoardAction[]): BoardAction[] {
  return actions.slice().sort((a, b) => {
    const catalogued = Number(b.catalogued !== false) - Number(a.catalogued !== false);
    if (catalogued !== 0) return catalogued;
    if (b.uses !== a.uses) return b.uses - a.uses;
    const recent = (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
    if (recent !== 0) return recent;
    return a.value.localeCompare(b.value);
  });
}

/** Counts for the page header. */
export function summarizeVocabulary(actions: BoardAction[]): {
  total: number;
  refusals: number;
  progress: number;
  retired: number;
} {
  const live = actions.filter((action) => action.catalogued !== false);
  return {
    total: live.length,
    refusals: live.filter((action) => action.kind === 'archive').length,
    progress: live.filter((action) => action.kind === 'move').length,
    retired: actions.length - live.length,
  };
}
