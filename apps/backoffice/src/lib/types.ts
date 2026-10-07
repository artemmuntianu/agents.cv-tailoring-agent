/** Domain types for the backoffice board (POC). */

/**
 * Who performed a change - the dialog's Actor dropdown.
 *
 * The **stored** vocabulary is `'Candidate' | 'Company'` (`resume_history.actor` and
 * `resume_board.archived_actor` CHECKs, `apps/worker/utils/db.py::SCHEMA_SQL`). Rows written before
 * 2026-09-26 say `'Me' | 'Them'`; they were renamed in place by the guarded migration
 * block, so nothing here ever has to know the old words.
 */
export type Actor = 'Candidate' | 'Company';

/** Kanban columns, in board order. */
export type StageId =
  | 'scraped'
  | 'prepare'
  | 'applied'
  | 'negotiating'
  | 'interviewing'
  | 'offer';

/** Sub-states that only make sense inside the `prepare` column. */
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
 * What an edit of one history line sends (`PATCH /api/board/history/<id>`).
 *
 * The **whole line** is editable - the date, the actor, the wording, the kind and both states -
 * because the point of the pencil is a *mis-recorded* line, and half a correction leaves the trail
 * wrong. The two states are validated against the kind (`lib/history.ts::parseHistoryRequest`),
 * which is the one check the table cannot make itself, and the write touches nothing else: not the
 * card's column, not `resume_board.updated_at` (so correcting the log cannot reset the inactivity
 * clock) and not `board_actions` (a correction is not a new action name) - invariant 29.
 */
export interface HistoryEntryRequest {
  /** ISO timestamp of the change. */
  at: string;
  actor: Actor;
  action: string;
  kind: HistoryKind;
  from: string;
  to: string;
}

/**
 * The edit form's own shape: the same line, with `at` still a `<input type="datetime-local">`
 * value. That input silently drops a time zone, so the draft must not carry one - the request is
 * built by converting it back (`lib/history.ts::draftToRequest`).
 */
export type HistoryDraft = Omit<HistoryEntryRequest, 'at'> & { at: string };

/**
 * The cover letter of one card (`resume_cover_letter`) - written on demand by `cover.py`,
 * which owns the row; the board writes `queued` when it publishes the request and reads the
 * result through the card payload.
 */
export interface CoverLetterState {
  /** `queued` (requested) | `running` | `completed` | `failed`. */
  status: string;
  text: string | null;
  error: string | null;
  /** Which model wrote it, when one did. */
  model: string | null;
  updatedAt: string | null;
}

/**
 * The hand-edited deliverable of one card (`resume_docx_update`) - what the *Update docx* button
 * last did. The row is written by the board (the upload) and by `rerender.py` (the render), and it
 * never carries the bytes: the DOCX itself is read only by the worker that converts it.
 */
export interface DocxUpdateState {
  /** `queued` (uploaded, render expected) | `running` | `completed` | `failed`. */
  status: string;
  filename: string | null;
  sizeBytes: number | null;
  error: string | null;
  updatedAt: string | null;
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
  /**
   * Site slug the vacancy came from (`resumes.source`): `djinni`, `dou`, ...
   * Part of the worker's business key, because two sites number their vacancies
   * independently - the card shows it so a machine intake is recognisable.
   */
  source: string;
  title: string;
  company: string;
  sourceUrl: string | null;
  cvVersion: string;
  /** Raw worker status (`resumes.status`) - the `prepare` sub-state derives from it. */
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
  /**
   * Which documents this board can serve *now* (`lib/artifacts.ts`): a `pdfUrl`/`docxPath`
   * only means the worker stored one, and a dev board resolves them against its mirror.
   */
  artifactAvailability: { pdf: boolean; docx: boolean };
  /** `null` = nobody asked for a letter yet. */
  coverLetter: CoverLetterState | null;
  /** `null` = no hand-edited upload yet; the button appears once `docxPath` is set. */
  docxUpdate: DocxUpdateState | null;
  /**
   * Whether the vacancy's job description is stored (`resumes.description_raw`). A card
   * scraped before 2026-09-26 has none, and neither a tailored CV nor a cover letter can be
   * built from nothing - so the UI says so instead of offering a button that must fail.
   */
  hasDescription: boolean;
  /** Newest last; rendered newest first in the card modal. */
  history: HistoryEntry[];
  /** `resume_board`'s own columns: the recruiter, the two salaries and the channels. */
  details: VacancyDetails;
  /**
   * The card's interviews (`resume_interview`), oldest first, empty until one is scheduled.
   * Deliberately **not** part of `history`: the list in the Interviews section *is* the
   * interview history, so adding, editing or removing one never grows the audit trail
   * (`CONSTITUTION.md` invariant 26). Read with the card, like the history.
   */
  interviews: Interview[];
}

/**
 * One row of the Action vocabulary (`board_actions`): what the dialogs suggest, what the
 * Filters panel offers and what the admin page edits. A value that is not in the table is
 * not in the vocabulary - the catalogue is the whole list.
 */
export interface BoardAction {
  value: string;
  /** Where a dialog shows it first: refusal reasons vs. progress notes. */
  kind: 'archive' | 'move';
  uses: number;
  lastUsedAt: string;
}

/** What the drop dialog sends; the API validates it before touching the DB. */
export interface MoveRequest {
  jobId: string;
  to: StageId;
  actor: Actor;
  action: string;
  /**
   * A field the scrape left empty, filled in the dialog's *Missing fields* section. It only ever
   * fills a blank (`lib/missing.ts::resolveCompany`): the stored company always wins, and the
   * value is written before the move publishes, so the task and the letter carry it.
   */
  company?: string;
}

/** What the Archive dialog sends - the same actor + reason contract as a move. */
export interface ArchiveRequest {
  jobId: string;
  actor: Actor;
  action: string;
}

/**
 * What the vacancy dialog's `➕ Add action` button sends: an action is *recorded* without the card
 * changing column. The API writes a `move` history row with `from_state = to_state`, which is
 * why this is the same actor + reason contract as a move - only the stage is untouched (and
 * nothing is queued, so an Add Action on a Prepare card is never a tailoring retry).
 */
export interface ActionRequest {
  jobId: string;
  actor: Actor;
  action: string;
}

/** The four interview types the section offers (code + the `resume_interview` CHECK). */
export type InterviewType =
  | 'Initial Interview'
  | 'Technical Interview'
  | 'Management Interview'
  | 'Final Interview';

/**
 * One interview of one card (`resume_interview`). It is its own record - `result` is the free
 * text the operator writes after the call - and each write from the Interviews section also
 * leaves one `resume_history` line and moves the card's clock (invariant 26).
 */
export interface Interview {
  /** `resume_interview.id` (bigserial). */
  id: number;
  jobId: string;
  /** ISO timestamp of the call. */
  scheduledAt: string;
  type: InterviewType;
  /** `null` until the interview happened and somebody wrote it down. */
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the Move dialog collects when a card enters **Interviewing**: a first interview, which
 * is inserted in the same transaction as the move. Filled in or left empty by the operator.
 */
export interface InterviewDraft {
  /** `datetime-local` value, or `''` for "not scheduled yet". */
  scheduledAt: string;
  type: InterviewType;
}

/** What an interview add/edit sends; the API validates it before touching the database. */
export interface InterviewRequest {
  /** ISO timestamp (the `datetime-local` value is converted before it is sent). */
  scheduledAt: string;
  type: InterviewType;
  /** Trimmed free text, or `null` to clear it. */
  result: string | null;
}

/** The six places a conversation can happen (code + the `resume_board_details_shape` CHECK). */
export type CommunicationChannel =
  | 'Email'
  | 'LinkedIn'
  | 'WhatsApp'
  | 'Telegram'
  | 'Dou'
  | 'Djinni';

/**
 * The details the operator maintains on the card itself (`resume_board`): who the recruiter is,
 * what the employer offers, what the operator asks for, where the conversation happens, and the
 * page the application itself is finished on.
 *
 * Free text except the channels (a fixed vocabulary) and the application URL (http(s) only,
 * canonicalised by `lib/applyUrl.ts`). An empty value is `null`, never `''` - the DB CHECK
 * rejects an empty string, and the form is what turns a cleared input into null.
 * Deliberately **not** historicised: these are card attributes, not funnel transitions.
 */
export interface VacancyDetails {
  recruiter: string | null;
  salaryOffered: string | null;
  salaryDesired: string | null;
  /** Empty = nobody said where; the array never carries NULL elements. */
  communicationChannels: CommunicationChannel[];
  /**
   * Where Apply actually lands, when that is not the posting itself (a DOU/Djinni card that
   * opens the employer's Greenhouse page). It is what lets the extension's `Populate` recognise
   * that page as this card - see `lib/applyUrl.ts` and `GET /api/vacancies/link`.
   */
  applyUrl: string | null;
}

/** What the card's Details form holds while it is being edited (inputs are always strings). */
export interface DetailsDraft {
  recruiter: string;
  salaryOffered: string;
  salaryDesired: string;
  communicationChannels: CommunicationChannel[];
  applyUrl: string;
}

/** What the Details form sends; the API validates it before touching the database. */
export interface DetailsRequest extends VacancyDetails {
  jobId: string;
}

/** The lifecycle of one run, spelled exactly like the `process_runs.status` CHECK. */
export type ProcessRunStatus = 'running' | 'ok' | 'failed' | 'skipped' | 'aborted';

/**
 * One run of an internal process (`process_runs`) - what the Processes page lists.
 * A job writes its own row (`apps/worker/utils/process_runs.py`), so a run that changed nothing is still
 * visible, and `running` without `finishedAt` is a pod that died mid-run.
 */
export interface ProcessRun {
  id: number;
  /** The job's slug (`feed-parser`, `auto-archiver`); `lib/processes.ts` labels it. */
  process: string;
  /**
   * What started the run - the `process_runs.trigger` CHECK (`apps/worker/utils/db.py`): a CronJob slot
   * (`schedule`), a hand-run (`manual`, `--trigger manual`), or the deploy's startup hook
   * (`startup`, the intake's `post-install,post-upgrade` Job in `infra/charts/cv-tailoring-scout`).
   */
  trigger: 'schedule' | 'manual' | 'startup';
  startedAt: string;
  finishedAt: string | null;
  status: ProcessRunStatus;
  /** The counters the job reported (`{new_cards: 3, notified: 3}`), or null. */
  summary: Record<string, unknown> | null;
  error: string | null;
}


