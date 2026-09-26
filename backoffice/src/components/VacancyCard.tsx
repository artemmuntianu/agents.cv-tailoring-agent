import { tailoringFromStatus, tailoringLabel, tailoringMeta } from '../lib/stages';
import type { BoardCard } from '../lib/types';

interface VacancyCardProps {
  card: BoardCard;
  dragging: boolean;
  onDragStart: (jobId: string) => void;
  onDragEnd: () => void;
  onOpen: (jobId: string) => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

/** One draggable card. The whole card is the drag handle; a click opens the modal. */
export default function VacancyCard({
  card,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: VacancyCardProps) {
  const lastAction = card.history[card.history.length - 1];
  const tailoring = tailoringFromStatus(card.status);

  return (
    <article
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', card.jobId);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart(card.jobId);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(card.jobId)}
      className={[
        'cursor-grab rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition',
        'hover:border-slate-300 hover:shadow',
        dragging ? 'opacity-40' : 'opacity-100',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-snug text-slate-900">
          {card.title || `Vacancy ${card.externalId}`}
        </h3>
        {card.stage === 'created' && (
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

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
        <span>#{card.externalId}</span>
        <span>·</span>
        <span>{card.cvVersion}</span>
        <span>·</span>
        <span>updated {formatDate(card.updatedAt)}</span>
      </div>

      {lastAction && (
        <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          <span className="font-medium text-slate-600">{lastAction.actor}</span> {lastAction.action}
        </p>
      )}

      <div className="mt-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-400">
        <span>
          {card.history.length} history {card.history.length === 1 ? 'entry' : 'entries'}
        </span>
        {card.pdfUrl && (
          <a
            href={card.pdfUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600 hover:bg-slate-200"
          >
            PDF
          </a>
        )}
      </div>
    </article>
  );
}
