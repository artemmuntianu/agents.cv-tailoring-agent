import { useEffect, useRef, useState } from 'react';
import { MAX_APPLY_URL_LENGTH } from '../lib/applyUrl';
import { artifactUrl, storedPathName } from '../lib/artifact-link';
import { historyLine } from '../lib/board';
import { coverBlockedReason, coverState, coverStateLabel } from '../lib/cover';
import {
  MAX_DOCX_UPLOAD_BYTES,
  RENDER_STATE_CHIP,
  RENDER_STATE_LABEL,
  fileRejection,
  renderState,
} from '../lib/docxUpload';
import {
  MAX_DETAIL_LENGTH,
  detailsChanged,
  draftFromCard,
  draftFromDetails,
  draftToRequest,
} from '../lib/details';
import { formatInterviewAt, hasReachedInterviewing, sortInterviews } from '../lib/interviews';
import {
  STAGES,
  refusalLabel,
  tailoringFromStatus,
  tailoringLabel,
  tailoringMeta,
} from '../lib/stages';
import type {
  BoardCard,
  DetailsDraft,
  DetailsRequest,
  HistoryEntry,
  HistoryEntryRequest,
  Interview,
  InterviewRequest,
} from '../lib/types';
import ChannelSelect from './ChannelSelect';
import HistoryDialog from './HistoryDialog';
import HistoryRemoveDialog from './HistoryRemoveDialog';
import InterviewDialog from './InterviewDialog';

interface VacancyModalProps {
  card: BoardCard;
  onClose: () => void;
  /** Optional: the keyboard-accessible twin of the card's hover buttons. */
  onArchive?: (jobId: string) => void;
  onRestore?: (jobId: string) => void;
  /** Irreversible: the board confirms it in its own dialog. */
  onRemove?: (jobId: string) => void;
  /** Ask the `resumes.cover` worker for a letter; the poll brings it back. */
  onGenerateCover?: (jobId: string) => Promise<void>;
  /**
   * Upload the deliverable the operator edited by hand (`POST /api/board/docx/<job_id>`).
   * Offered only for a card that has a tailored DOCX, and the render comes back through the
   * same 5s poll as everything else.
   */
  onUploadDocx?: (jobId: string, file: File) => Promise<void>;
  /**
   * The Interviews section's three writes. Every one of them re-reads the card, and none of
   * them writes a history row: the list in the section *is* the interview history
   * (`CONSTITUTION.md` invariant 26).
   */
  onAddInterview?: (jobId: string, interview: InterviewRequest) => Promise<void>;
  /**
   * Save the card's own detail fields (recruiter, the two salaries, the channels). One write for
   * the whole set, and one that counts as operator activity - see invariant 28.
   */
  onSaveDetails?: (jobId: string, details: DetailsRequest) => Promise<void>;
  onEditInterview?: (id: number, interview: InterviewRequest) => Promise<void>;
  onRemoveInterview?: (id: number) => Promise<void>;
  /**
   * The History section's two writes. A line **is** the audit trail, so both are deliberate: an
   * edit rewrites everything one line says, a removal drops it. Neither touches the card - no
   * column change, no `resume_board.updated_at`, no `board_actions` (invariant 29).
   */
  onEditHistory?: (id: number, line: HistoryEntryRequest) => Promise<void>;
  onRemoveHistory?: (id: number) => Promise<void>;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-800">{value}</dd>
    </div>
  );
}

const DETAIL_INPUT =
  'mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal normal-case ' +
  'tracking-normal text-slate-900 placeholder:text-slate-400';

function duration(ms: number | null): string {
  return ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

/** Names of the documents the worker stored but this board cannot serve (not mirrored yet). */
function missingArtifacts(card: BoardCard): string {
  const missing: string[] = [];
  if (card.pdfUrl && !card.artifactAvailability.pdf) missing.push('PDF');
  if (card.docxPath && !card.artifactAvailability.docx) missing.push('DOCX');
  return missing.join(' + ');
}

/** The stored artifact path reduced to its file name (`/data/output/848944.pdf`). */
function resultField(storedPath: string | null): string {
  return storedPathName(storedPath) ?? 'not stored yet';
}

/** The status chip of the cover-letter section. */
const COVER_CHIP: Record<string, string> = {
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  running: 'bg-amber-50 text-amber-800 ring-amber-200',
  queued: 'bg-slate-100 text-slate-700 ring-slate-200',
  failed: 'bg-rose-50 text-rose-700 ring-rose-200',
  absent: 'bg-slate-100 text-slate-500 ring-slate-200',
};

/**
 * Everything known about one vacancy: the worker's state, the cover letter, the **interviews**
 * (for a card that reached Interviewing) and the full change history at the bottom.
 *
 * It closes on Escape, on the ✕ and on a **click on the overlay** - the panel stops the click,
 * so only the backdrop closes it.
 */
export default function VacancyModal({
  card,
  onClose,
  onArchive,
  onRestore,
  onRemove,
  onGenerateCover,
  onUploadDocx,
  onAddInterview,
  onEditInterview,
  onRemoveInterview,
  onEditHistory,
  onRemoveHistory,
  onSaveDetails,
}: VacancyModalProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Local-only state: the copy confirmation and whether a request is in flight.
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  // The interview being added (`interview: null`) or edited, plus the state of that write.
  const [interviewDraft, setInterviewDraft] = useState<{ interview: Interview | null } | null>(
    null,
  );
  const [interviewBusy, setInterviewBusy] = useState(false);
  const [interviewError, setInterviewError] = useState<string | null>(null);
  // The history line being corrected, and the one being dropped. Two dialogs, because one rewrites
  // a line and the other is the only place the trail can lose one.
  const [historyEdit, setHistoryEdit] = useState<HistoryEntry | null>(null);
  const [historyRemoval, setHistoryRemoval] = useState<HistoryEntry | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // The card's own detail fields: an always-editable block with one Save, so nothing is written
  // until the operator says so. The draft is seeded once, so the 5s poll cannot overwrite typing;
  // a save resets it from what was stored (normalised), which makes it clean again.
  const [detailsDraft, setDetailsDraft] = useState<DetailsDraft>(() => draftFromCard(card));
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsSaved, setDetailsSaved] = useState(false);
  const detailsDirty = detailsChanged(detailsDraft, card.details);

  const cover = coverState(card.coverLetter);
  const coverBlocked = coverBlockedReason(card.hasDescription);

  // The *Update docx* upload: the chosen file, the message a refused upload produced, and whether
  // the request is in flight. The outcome itself comes from the card payload (`card.docxUpdate`),
  // so the 5s poll shows the render landing without a push channel.
  const [docxFile, setDocxFile] = useState<File | null>(null);
  const [docxMessage, setDocxMessage] = useState<string | null>(null);
  const [docxBusy, setDocxBusy] = useState(false);
  const docxInput = useRef<HTMLInputElement | null>(null);
  const docxUpdate = card.docxUpdate;
  const docxState = renderState(docxUpdate);

  async function uploadDocx() {
    if (!onUploadDocx || !docxFile || docxBusy) return;
    setDocxMessage(null);
    setDocxBusy(true);
    try {
      await onUploadDocx(card.jobId, docxFile);
      setDocxFile(null);
    } catch (cause) {
      setDocxMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDocxBusy(false);
      if (docxInput.current) docxInput.current.value = '';
    }
  }

  function chooseDocx(file: File | null) {
    setDocxMessage(null);
    if (!file) {
      setDocxFile(null);
      return;
    }
    // The same rules the route enforces, checked before the upload so the operator hears about a
    // wrong file in a millisecond instead of after a megabyte of it travelled.
    const rejection = fileRejection(file.name, file.size);
    setDocxFile(rejection ? null : file);
    if (rejection) setDocxMessage(rejection);
  }

  async function copyLetter() {
    const text = card.coverLetter?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  async function askForLetter() {
    if (!onGenerateCover || asking || coverBlocked) return;
    setAsking(true);
    try {
      await onGenerateCover(card.jobId);
    } finally {
      setAsking(false);
    }
  }

  /** One interview write: the dialog stays open with the message when the API refuses. */
  async function saveInterview(request: InterviewRequest) {
    setInterviewBusy(true);
    setInterviewError(null);
    try {
      if (interviewDraft?.interview) {
        await onEditInterview?.(interviewDraft.interview.id, request);
      } else {
        await onAddInterview?.(card.jobId, request);
      }
      setInterviewDraft(null);
    } catch (cause) {
      setInterviewError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInterviewBusy(false);
    }
  }

  async function removeInterview(id: number) {
    setInterviewBusy(true);
    setInterviewError(null);
    try {
      await onRemoveInterview?.(id);
    } catch (cause) {
      setInterviewError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInterviewBusy(false);
    }
  }

  /** One history-line correction: the dialog stays open with the message when the API refuses. */
  async function saveHistoryLine(request: HistoryEntryRequest) {
    if (!historyEdit) return;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      await onEditHistory?.(historyEdit.id, request);
      setHistoryEdit(null);
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHistoryBusy(false);
    }
  }

  /** Dropping a line: confirmed first, because this is the trail losing a recorded fact. */
  async function removeHistoryLine() {
    if (!historyRemoval) return;
    const id = historyRemoval.id;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      await onRemoveHistory?.(id);
      setHistoryRemoval(null);
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHistoryBusy(false);
    }
  }

  function editDetails(patch: Partial<DetailsDraft>) {
    setDetailsSaved(false);
    setDetailsError(null);
    setDetailsDraft((current) => ({ ...current, ...patch }));
  }

  /** One write for the whole set: `''` clears a field, and the row's date moves with it. */
  async function saveDetails() {
    setDetailsBusy(true);
    setDetailsError(null);
    try {
      const request = draftToRequest(card.jobId, detailsDraft);
      await onSaveDetails?.(card.jobId, request);
      setDetailsDraft(draftFromDetails(request));
      setDetailsSaved(true);
    } catch (cause) {
      setDetailsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDetailsBusy(false);
    }
  }

  const stage = STAGES.find((item) => item.id === card.stage);
  const tailoring = tailoringFromStatus(card.status);

  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-xl bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              {card.title || `Vacancy ${card.externalId}`}
            </h2>
            <p className="text-sm text-slate-500">
              {card.company || 'unknown company'} · job_id {card.jobId}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="px-6 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ring-1 ${stage?.chip ?? ''}`}>
              {stage?.label ?? card.stage}
            </span>
            {card.stage === 'prepare' && (
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ring-1 ${
                  tailoringMeta(tailoring).chip
                }`}
              >
                {tailoringLabel(tailoring)}
              </span>
            )}
            {card.archived && (
              <span className="rounded bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
                ⛔️ {refusalLabel(card)}
              </span>
            )}
            <span className="text-xs text-slate-400">#{card.externalId}</span>
          </div>

          {card.stage === 'prepare' && (
            <p className="mt-2 text-[11px] text-slate-500">
              The tailoring sub-state follows the worker's status (<code>{card.status}</code>) - it is
              not set from here. Dropping a card into this column is what queues tailoring; a parked
              card is retried by dropping it here again.
            </p>
          )}

          <dl className="mt-4 grid grid-cols-3 gap-4">
            <Field label="Worker status" value={card.status} />
            <Field label="Attempts" value={String(card.attempts)} />
            <Field label="Revisions" value={card.revisionCount === null ? '—' : String(card.revisionCount)} />
            <Field label="Task duration" value={duration(card.durationMs)} />
            <Field label="CV version" value={card.cvVersion} />
            <Field label="Created" value={formatDateTime(card.createdAt)} />
            <Field label="Last change" value={formatDateTime(card.updatedAt)} />
            {card.archived && <Field label="Refused by" value={card.archivedActor ?? 'unknown'} />}
            {card.archived && (
              <Field
                label="Refused on"
                value={formatDateTime(card.archivedAt ?? card.updatedAt)}
              />
            )}
            <Field label="Result (PDF)" value={resultField(card.pdfUrl)} />
            <Field label="Result (DOCX)" value={resultField(card.docxPath)} />
          </dl>

          {(card.pdfUrl || card.docxPath) && (
            <p className="mt-2 text-[11px] text-slate-500">
              The worker records the artifact&rsquo;s <em>path on its volume</em>, so the links
              below go through the board, which resolves that path against{' '}
              <code>ARTIFACTS_DIR</code>.
              {missingArtifacts(card) && (
                <>
                  {' '}
                  <strong>{missingArtifacts(card)}</strong> is not on this machine yet - mirror the
                  volume with <code>.\scripts\storage-files.ps1 -Action download</code>.
                </>
              )}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-3 text-xs">
            {card.sourceUrl && (
              <a
                href={card.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                Open the vacancy posting
              </a>
            )}
            {card.details.applyUrl && (
              <a
                href={card.details.applyUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                Open the application page
              </a>
            )}
            {card.pdfUrl && card.artifactAvailability.pdf && (
              <a
                href={artifactUrl(card.jobId)}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                Tailored PDF
              </a>
            )}
            {card.docxPath && card.artifactAvailability.docx && (
              <a
                href={artifactUrl(card.jobId, 'docx')}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                Tailored DOCX
              </a>
            )}
            {missingArtifacts(card) && (
              <span className="rounded border border-amber-300 bg-amber-50 px-2 py-1 font-medium text-amber-800">
                {missingArtifacts(card)} not mirrored here
              </span>
            )}
            {!card.archived && onArchive && (
              <button
                type="button"
                onClick={() => onArchive(card.jobId)}
                className="rounded border border-rose-300 px-2 py-1 font-medium text-rose-700 hover:bg-rose-50"
              >
                ⛔️ Archive
              </button>
            )}
            {card.archived && onRestore && (
              <button
                type="button"
                onClick={() => onRestore(card.jobId)}
                className="rounded border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
              >
                🔄 Restore
              </button>
            )}
            {card.archived && onRemove && (
              <button
                type="button"
                onClick={() => onRemove(card.jobId)}
                title="Remove this vacancy and its files for good"
                className="rounded border border-rose-300 px-2 py-1 font-medium text-rose-700 hover:bg-rose-50"
              >
                🗑 Remove for good
              </button>
            )}
          </div>

          {card.error && (
            <section className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-rose-500">
                Last worker error
              </h3>
              <p className="mt-1 whitespace-pre-line text-sm text-rose-800">{card.error}</p>
            </section>
          )}
        </div>

        <section className="border-t border-slate-200 px-6 py-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Details
            </h3>
            <span className="text-[11px] text-slate-400">
              free text · saved on the card, never in History
            </span>
          </div>

          <form
            className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (detailsDirty && !detailsBusy) void saveDetails();
            }}
          >
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Recruiter
              <input
                value={detailsDraft.recruiter}
                onChange={(event) => editDetails({ recruiter: event.target.value })}
                maxLength={MAX_DETAIL_LENGTH}
                placeholder="who you talk to"
                className={DETAIL_INPUT}
              />
            </label>

            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Salary offered
              <input
                value={detailsDraft.salaryOffered}
                onChange={(event) => editDetails({ salaryOffered: event.target.value })}
                maxLength={MAX_DETAIL_LENGTH}
                placeholder="what they offer"
                className={DETAIL_INPUT}
              />
            </label>

            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Salary desired
              <input
                value={detailsDraft.salaryDesired}
                onChange={(event) => editDetails({ salaryDesired: event.target.value })}
                maxLength={MAX_DETAIL_LENGTH}
                placeholder="what you ask for"
                className={DETAIL_INPUT}
              />
            </label>

            <div className="block text-xs font-medium uppercase tracking-wide text-slate-500 sm:col-span-3">
              Application URL
              <input
                value={detailsDraft.applyUrl}
                onChange={(event) => editDetails({ applyUrl: event.target.value })}
                maxLength={MAX_APPLY_URL_LENGTH}
                placeholder="https://job-boards.eu.greenhouse.io/growe/jobs/4987494101"
                className={`${DETAIL_INPUT} font-normal normal-case`}
              />
              <span className="mt-1 block text-[11px] font-normal normal-case leading-relaxed text-slate-400">
                Where <em>Apply</em> actually lands, when that is not the posting itself. The
                browser extension finds this card from that page, so <em>Populate</em> works on the
                employer&rsquo;s own form. The query string and fragment are dropped on save.
              </span>
            </div>

            <div className="block text-xs font-medium uppercase tracking-wide text-slate-500 sm:col-span-3">
              Communication channel
              <ChannelSelect
                value={detailsDraft.communicationChannels}
                onChange={(channels) => editDetails({ communicationChannels: channels })}
                disabled={detailsBusy}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
              <button
                type="submit"
                disabled={!detailsDirty || detailsBusy}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {detailsBusy ? 'Saving…' : 'Save details'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDetailsDraft(draftFromCard(card));
                  setDetailsError(null);
                  setDetailsSaved(false);
                }}
                disabled={!detailsDirty || detailsBusy}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
              >
                Revert
              </button>
              {detailsDirty && (
                <span className="text-[11px] font-medium text-amber-700">unsaved changes</span>
              )}
              {detailsSaved && !detailsDirty && (
                <span className="text-[11px] font-medium text-emerald-700">saved</span>
              )}
            </div>
          </form>

          {detailsError && (
            <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {detailsError}
            </p>
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            The recruiter's name, what the employer offers and what you ask for are free text.
            Communication channels are the six the board knows. The application URL is the page the
            extension's <em>Populate</em> looks this card up by - it must be http(s), and saving any
            of this counts as activity, so the auto-archiver leaves the card alone.
          </p>
        </section>

        {/* Cover letter: application material, so it is offered for *any* card - any column,
            archived or not. The row it reads is written by the cover worker, and asking for one
            goes to its own queue (`resumes.cover`), never to the tailoring workers. */}
        {/* *Update docx* - the workflow the operator asked for: download the tailored DOCX,
            verify it, fix what the model could not, upload it back, and the PDF follows. Offered
            only when the card has a deliverable (`docxPath`), which is the same condition the
            route enforces. The bytes are stored in Postgres and rendered by `resumes.rerender`;
            the outcome arrives through the card payload. */}
        {card.docxPath && onUploadDocx && (
          <section className="border-t border-slate-200 px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Update docx
                </h3>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${RENDER_STATE_CHIP[docxState]}`}
                >
                  {RENDER_STATE_LABEL[docxState]}
                </span>
                {docxUpdate?.filename && (
                  <span className="text-[11px] text-slate-400">{docxUpdate.filename}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={docxInput}
                  type="file"
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={(event) => chooseDocx(event.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  onClick={() => docxInput.current?.click()}
                  className="rounded border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
                >
                  Update docx
                </button>
                {docxFile && (
                  <button
                    type="button"
                    onClick={() => void uploadDocx()}
                    disabled={docxBusy || docxState === 'running'}
                    className="rounded border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    {docxBusy ? 'Uploading…' : 'Regenerate PDF'}
                  </button>
                )}
              </div>
            </div>

            <p className="mt-2 text-xs text-slate-500">
              Download the DOCX above, fix whatever the model could not, and upload it back: the
              board keeps the file and rebuilds this card&rsquo;s PDF from it, so both links keep
              pointing at the current pair.
              {docxFile && (
                <>
                  {' '}
                  Chosen: <strong>{docxFile.name}</strong> ({Math.max(1, Math.round(docxFile.size / 1024))}{' '}
                  KB).
                </>
              )}
            </p>
            {docxMessage && <p className="mt-2 text-xs text-rose-700">{docxMessage}</p>}
            {docxState === 'failed' && docxUpdate?.error && (
              <p className="mt-2 text-xs text-rose-700">{docxUpdate.error}</p>
            )}
            {docxState === 'completed' && docxUpdate?.updatedAt && (
              <p className="mt-2 text-xs text-emerald-700">
                Re-rendered from {docxUpdate.filename ?? 'the uploaded DOCX'} on{' '}
                {formatDateTime(docxUpdate.updatedAt)}.
              </p>
            )}
          </section>
        )}

        <section className="border-t border-slate-200 px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Cover letter
              </h3>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${COVER_CHIP[cover]}`}
              >
                {coverStateLabel(cover)}
              </span>
              {cover === 'completed' && card.coverLetter?.model && (
                <span className="text-[11px] text-slate-400">{card.coverLetter.model}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {cover === 'completed' && card.coverLetter?.text && (
                <button
                  type="button"
                  onClick={() => void copyLetter()}
                  className="rounded border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
                >
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              )}
              {onGenerateCover && (
                <button
                  type="button"
                  onClick={() => void askForLetter()}
                  disabled={asking || cover === 'running' || Boolean(coverBlocked)}
                  title={coverBlocked ?? 'One Gemini call, on the resumes.cover queue'}
                  className="rounded border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                >
                  {cover === 'absent' ? 'Generate' : cover === 'failed' ? 'Try again' : 'Regenerate'}
                </button>
              )}
            </div>
          </div>

          {coverBlocked ? (
            <p className="mt-2 text-xs text-amber-800">{coverBlocked}</p>
          ) : cover === 'completed' && card.coverLetter?.text ? (
            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-800">
              {card.coverLetter.text}
            </pre>
          ) : cover === 'queued' || cover === 'running' ? (
            <p className="mt-2 text-sm text-slate-500">
              The cover-letter worker is on it - this panel refreshes every few seconds.
            </p>
          ) : cover === 'failed' ? (
            <p className="mt-2 text-sm text-rose-700">
              {card.coverLetter?.error || 'the letter could not be written'}
            </p>
          ) : (
            <p className="mt-2 text-sm text-slate-500">
              No cover letter yet. Generating one uses the stored job description and the master CV,
              so it can only repeat what the CV already says.
            </p>
          )}
        </section>

        {hasReachedInterviewing(card) && (
          <section className="border-t border-slate-200 px-6 py-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Interviews
              </h3>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-400">
                  {card.interviews.length}{' '}
                  {card.interviews.length === 1 ? 'interview' : 'interviews'}
                </span>
                <button
                  type="button"
                  onClick={() => setInterviewDraft({ interview: null })}
                  disabled={interviewBusy}
                  className="rounded border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
                >
                  ➕ Add
                </button>
              </div>
            </div>

            {card.interviews.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                No interview scheduled yet. This card reached Interviewing, so the call can be
                scheduled here - or it was scheduled without a date when the card moved in.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {sortInterviews(card.interviews).map((interview) => (
                  <li
                    key={interview.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-slate-200 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm text-slate-800">
                        <span className="font-medium">
                          {formatInterviewAt(interview.scheduledAt)}
                        </span>
                        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-700 ring-1 ring-violet-200">
                          {interview.type}
                        </span>
                      </p>
                      <p
                        className={`mt-1 whitespace-pre-wrap text-[13px] ${
                          interview.result ? 'text-slate-600' : 'text-slate-400'
                        }`}
                      >
                        {interview.result || 'no result recorded yet'}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => setInterviewDraft({ interview })}
                        disabled={interviewBusy}
                        aria-label={`Edit the ${interview.type}`}
                        className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
                      >
                        ✏️ Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeInterview(interview.id)}
                        disabled={interviewBusy}
                        aria-label={`Remove the ${interview.type}`}
                        className="rounded border border-rose-300 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 hover:bg-rose-50 disabled:text-slate-400"
                      >
                        ✕ Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {interviewError && !interviewDraft && (
              <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {interviewError}
              </p>
            )}

            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              Scheduled and recorded calls only. This list <em>is</em> the interview history -
              editing it never adds a line to the History below.
            </p>
          </section>
        )}

        <section className="border-t border-slate-200 px-6 py-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">History</h3>
            <span className="text-[11px] text-slate-400">
              {card.history.length} {card.history.length === 1 ? 'entry' : 'entries'} · newest first
            </span>
          </div>

          {card.history.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              No manual changes yet. Dragging the card to another column records the first entry.
            </p>
          ) : (
            <ol className="mt-3 space-y-3">
              {[...card.history].reverse().map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 gap-3">
                    <span
                      className={`mt-0.5 h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ${
                        item.actor === 'Candidate'
                          ? 'bg-slate-100 text-slate-600 ring-slate-200'
                          : 'bg-indigo-100 text-indigo-700 ring-indigo-200'
                      }`}
                    >
                      {item.actor}
                    </span>
                    <div className="min-w-0">
                      <p className="break-words text-sm text-slate-800">{item.action}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {historyLine(item)}
                        {' · '}
                        {formatDateTime(item.at)}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => setHistoryEdit(item)}
                      disabled={historyBusy}
                      aria-label={`Correct the history line "${item.action}"`}
                      className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
                    >
                      ✏️ Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryRemoval(item)}
                      disabled={historyBusy}
                      aria-label={`Remove the history line "${item.action}"`}
                      className="rounded border border-rose-300 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 hover:bg-rose-50 disabled:text-slate-400"
                    >
                      ✕ Remove
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}

          <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
            One entry per recorded change. ✏️ corrects what a line says - its date, actor, reason,
            kind and both states; ✕ drops the line. Neither moves the card and neither edits the
            Action list, and the correction itself is not dated.
          </p>
        </section>

        {historyError && !historyEdit && !historyRemoval && (
          <p className="mx-6 mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {historyError}
          </p>
        )}

        {historyEdit && (
          <HistoryDialog
            entry={historyEdit}
            subtitle={`${card.title || card.externalId} · ${card.company || 'unknown company'}`}
            busy={historyBusy}
            error={historyError}
            onSave={(request) => void saveHistoryLine(request)}
            onCancel={() => {
              setHistoryEdit(null);
              setHistoryError(null);
            }}
          />
        )}

        {historyRemoval && (
          <HistoryRemoveDialog
            entry={historyRemoval}
            subtitle={`${card.title || card.externalId} · ${card.company || 'unknown company'}`}
            remaining={Math.max(0, card.history.length - 1)}
            onConfirm={() => void removeHistoryLine()}
            onCancel={() => {
              setHistoryRemoval(null);
              setHistoryError(null);
            }}
          />
        )}

        {interviewDraft && (
          <InterviewDialog
            interview={interviewDraft.interview}
            title={interviewDraft.interview ? '✏️ Edit interview' : '➕ Add interview'}
            subtitle={`${card.title || card.externalId} · ${card.company || 'unknown company'}`}
            busy={interviewBusy}
            error={interviewError}
            onSave={(request) => void saveInterview(request)}
            onCancel={() => {
              setInterviewDraft(null);
              setInterviewError(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
