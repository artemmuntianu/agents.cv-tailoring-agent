/** Domain types for the backoffice board (POC). */

/**
 * Who performed a change - the dialog's Actor dropdown.
 *
 * The **stored** vocabulary is `'Candidate' | 'Company'` (`resume_history.actor` and
 * `resume_board.archived_actor` CHECKs, `utils/db.py::SCHEMA_SQL`). Rows written before
 * 2026-09-26 say `'Me' | 'Them'`; they were renamed in place by the guarded migration
 * block, so nothing here ever has to know the old words.
 */
export type Actor = 'Candidate' | 'Company';

/** Kanban columns, in board order. */
export type StageId = 'created' | 'applied' | 'negotiating' | 'interviewing' | 'offer';

/** Sub-states that only make sense inside the `created` column. */
export type TailoringStateId = 'in_progress' | 'failed' | 'tailored';

/**
 * Why a card changed - every change is one entry in the card's history.
 *
 * `move` and `archive`/`restore` carry a **stage id** (the latter use the flags
 * `active`/`archived`); `tailoring` mirrors the worker's own status transitions.
 */
export type HistoryKind = 'move' | 'tailoring' | 'archive' | 'restore';

export interface HistoryEntry {
  /** `resume_history.id` (bigserial). */
  id: number;
  /** ISO timestamp of the change. */
  at: string;
  actor: Actor;
  /** The free text the operator typed into the dialog (or a recorded constant). */
  action: string;
  kind: HistoryKind;
  /** Stage id for `move`/`tailoring`, `active`|`archived` for archive/restore. */
  from: string;
  to: string;
}

/**
 * One card = one row of the worker's `resumes` table joined with the board's
 * `resume_board` (stage + the archive columns) and its `resume_history` rows.
 * The board never copies the vacancy: it reads the worker's row and only owns the
 * column, the archive flag and the history.
 */
export interface BoardCard {
  jobId: string;
  externalId: string;
  title: string;
  company: string;
  sourceUrl: string | null;
  cvVersion: string;
  /** Raw worker status (`resumes.status`) - the `created` sub-state derives from it. */
  status: string;
  attempts: number;
  revisionCount: number | null;
  durationMs: number | null;
  error: string | null;
  pdfUrl: string | null;
  docxPath: string | null;
  createdAt: string;
  updatedAt: string;
  /** Manual kanban column (`resume_board.stage`) - unchanged by archiving. */
  stage: StageId;
  /**
   * In-place soft delete. `archivedAt` is null while the vacancy is in play; the
   * three fields are always set together (the DB enforces it). `archived` is the
   * derived flag the UI and the filters use - **archived is never a stage**.
   */
  archivedAt: string | null;
  archivedActor: Actor | null;
  archivedReason: string | null;
  archived: boolean;
  /** Newest last; rendered newest first in the card modal. */
  history: HistoryEntry[];
}

/** One row of the Action vocabulary (`board_actions`) the dialogs suggest. */
export interface BoardAction {
  value: string;
  /** Where a dialog shows it first: refusal reasons vs. progress notes. */
  kind: 'archive' | 'move';
  uses: number;
  lastUsedAt: string;
  /**
   * False for a value that only *history* knows: it was removed from `board_actions`
   * (or typed before the catalogue existed), so it is filterable but no longer
   * suggested. Undefined means catalogued.
   */
  catalogued?: boolean;
}

/** What the drop dialog sends; the API validates it before touching the DB. */
export interface MoveRequest {
  jobId: string;
  to: StageId;
  actor: Actor;
  action: string;
}

/** What the Archive dialog sends - the same actor + reason contract as a move. */
export interface ArchiveRequest {
  jobId: string;
  actor: Actor;
  action: string;
}


