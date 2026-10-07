import { artifactUrl } from '../lib/artifact-link';
import { sourceLabel, updatedLabel } from '../lib/cardMeta';
import { INTERVIEW_FACE_TONES, faceInterview } from '../lib/interviewAgenda';
import { formatInterviewAt } from '../lib/interviews';
import { refusalLabel, tailoringFromStatus, tailoringLabel, tailoringMeta } from '../lib/stages';
import type { BoardCard } from '../lib/types';

interface VacancyCardProps {
  card: BoardCard;
  dragging: boolean;
  onDragStart: (jobId: string) => void;
  onDragEnd: () => void;
  onOpen: (jobId: string) => void;
  onArchive: (jobId: string) => void;
  onRestore: (jobId: string) => void;
  /** Irreversible: the board asks for confirmation before calling this. */
  onRemove: (jobId: string) => void;
}

const MIRROR_HINT =
  'stored by the worker, but not mirrored on this machine yet - run ' +
  '.\\scripts\\storage-files.ps1 -Action download';

/**
 * One document chip. The board only serves files under its artifact root, so when the file has
 * not been mirrored yet the chip says so instead of offering a link that 404s.
 */
function ArtifactChip({
  jobId,
  path,
  available,
  label,
}: {
  jobId: string;
  path: string | null;
  available: boolean;
  label: 'PDF' | 'DOCX';
}) {
  if (!path) return null;

  if (!available) {
    return (
      <span
        title={MIRROR_HINT}
        className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 ring-1 ring-amber-200"
      >
        {label} · sync
      </span>
    );
  }

  return (
    <a
      href={artifactUrl(jobId, label === 'DOCX' ? 'docx' : 'pdf')}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600 hover:bg-slate-200"
    >
      {label}
    </a>
  );
}

/**
 * One card, in two visual states.
 *
 * *Active*: solid, the whole card is the drag handle, a click opens the modal, and
 * hovering (or tabbing into it) reveals `⛔️ Archive`. Recording an action *without* moving the
 * card - the only way to log "recruiter called back" - lives in the vacancy dialog's header.
 *
 * *Refused* (the in-place soft delete): the same position in the same column, muted -
 * half opacity at rest, readable on hover, rose accent border, struck-through title, the
 * refusal badge - and **not draggable**, so a refused card can never be moved by
 * accident. `🔄 Restore` is its only action.
 *
 * Either state carries the same reading line (`lib/cardMeta.ts`): the site the vacancy came from,
 * and how long ago it moved. Once the card has interviews it carries one more line
 * (`lib/interviewAgenda.ts`) - the single date that decides today's plan, written as a distance:
 * `📅 today, Mon 9:00 AM`, `📅 2 days ago, Fri 11:00 AM`, and past nine days the date itself
 * (`📅 next Sep 24, Wed 1:00 AM`) - beside an amber `✏️ 2 results to write` counter for calls whose
 * day has passed unwritten. The vacancy id and the CV version are deliberately **not** on the face -
 * the modal's header and facts list carry both, and the face is for triage.
 */
export default function VacancyCard({
  card,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onArchive,
  onRestore,
  onRemove,
}: VacancyCardProps) {
  const lastAction = card.history[card.history.length - 1];
  const tailoring = tailoringFromStatus(card.status);
  const archived = card.archived;
  const interviewFace = faceInterview(card);

  return (
    <article
      draggable={!archived}
      onDragStart={(event) => {
        if (archived) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData('text/plain', card.jobId);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart(card.jobId);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(card.jobId)}
      className={[
        'group relative rounded-lg border p-3 shadow-sm transition',
        archived
          ? 'cursor-pointer border-slate-200 border-l-4 border-l-rose-500 bg-slate-100/80 opacity-50 hover:opacity-85'
          : 'cursor-grab bg-white hover:border-slate-300 hover:shadow',
        dragging ? 'opacity-40' : '',
      ].join(' ')}
    >
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
        {archived ? (
          <>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRestore(card.jobId);
              }}
              aria-label={`Restore ${card.title || card.externalId}`}
              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-50"
            >
              🔄 Restore
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRemove(card.jobId);
              }}
              aria-label={`Remove ${card.title || card.externalId} for good`}
              title="Remove this vacancy and its files for good"
              className="rounded border border-rose-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-rose-700 hover:bg-rose-50"
            >
              🗑 Remove
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onArchive(card.jobId);
              }}
              aria-label={`Archive ${card.title || card.externalId}`}
              className="rounded border border-rose-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-rose-700 hover:bg-rose-50"
            >
              ⛔️ Archive
            </button>
          </>
        )}
      </div>

      <div className="flex items-start justify-between gap-2 pr-16">
        <h3
          className={[
            'text-sm font-semibold leading-snug',
            archived ? 'text-slate-400 line-through' : 'text-slate-900',
          ].join(' ')}
        >
          {card.title || `Vacancy ${card.externalId}`}
        </h3>
        {!archived && card.stage === 'prepare' && (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${
              tailoringMeta(tailoring).chip
            }`}
          >
            {tailoringLabel(tailoring)}
          </span>
        )}
      </div>

      <p className="mt-0.5 text-xs text-slate-500">{card.company || 'unknown company'}</p>

      {archived && (
        <p className="mt-1 truncate text-[11px] font-medium text-rose-700" title={refusalLabel(card)}>
          ⛔️ {refusalLabel(card)}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
        <span>{sourceLabel(card.source)}</span>
        <span>·</span>
        <span>
          {archived
            ? `refused ${updatedLabel(card.archivedAt ?? card.updatedAt)}`
            : `updated ${updatedLabel(card.updatedAt)}`}
        </span>
      </div>

      {interviewFace && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span
            title={interviewFace.at ? formatInterviewAt(interviewFace.at) : 'No date on this card'}
            className={`rounded px-1.5 py-0.5 font-medium ring-1 ${
              INTERVIEW_FACE_TONES[interviewFace.tone]
            }`}
          >
            📅 {interviewFace.label}
          </span>
          {interviewFace.resultsToWrite > 0 && (
            <span
              title="Past interviews with no result recorded - open the card's Interviews section"
              className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 ring-1 ring-amber-200"
            >
              ✏️ {interviewFace.resultsToWrite}{' '}
              {interviewFace.resultsToWrite === 1 ? 'result' : 'results'} to write
            </span>
          )}
        </div>
      )}

      {lastAction && !archived && (
        <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          <span className="font-medium text-slate-600">{lastAction.actor}</span> {lastAction.action}
        </p>
      )}

      <div className="mt-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-400">
        <span>
          {card.history.length} history {card.history.length === 1 ? 'entry' : 'entries'}
        </span>
        <span className="flex items-center gap-1">
          <ArtifactChip
            jobId={card.jobId}
            path={card.pdfUrl}
            available={card.artifactAvailability.pdf}
            label="PDF"
          />
          <ArtifactChip
            jobId={card.jobId}
            path={card.docxPath}
            available={card.artifactAvailability.docx}
            label="DOCX"
          />
        </span>
      </div>
    </article>
  );
}
