/** Domain types for the backoffice board (POC). */

/** Who performed a manual move. The requirement is a two-option dropdown. */
export type Actor = 'Me' | 'Them';

/** Kanban columns, in board order. */
export type StageId = 'created' | 'applied' | 'negotiating' | 'interviewing' | 'offer';

/** Sub-states that only make sense inside the `created` column. */
export type TailoringStateId = 'in_progress' | 'failed' | 'tailored';

/** Why a card changed - every change is one entry in the card's history. */
export type HistoryKind = 'move' | 'tailoring';

export interface HistoryEntry {
  /** `resume_history.id` (bigserial). */
  id: number;
  /** ISO timestamp of the change. */
  at: string;
  actor: Actor;
  /** The free text the operator typed into the dialog. */
  action: string;
  kind: HistoryKind;
  /** Stage id for `move`, tailoring state id for `tailoring`. */
  from: string;
  to: string;
}

/**
 * One card = one row of the worker's `resumes` table joined with the board's
 * `resume_board.stage` (absent -> 'created') and its `resume_history` rows.
 * The board never copies the vacancy: it reads the worker's row and only owns the
 * column and the history.
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
  /** Manual kanban column (`resume_board.stage`). */
  stage: StageId;
  /** Newest last; rendered newest first in the card modal. */
  history: HistoryEntry[];
}

/** What the drop dialog sends; the API validates it before touching the DB. */
export interface MoveRequest {
  jobId: string;
  to: StageId;
  actor: Actor;
  action: string;
}

