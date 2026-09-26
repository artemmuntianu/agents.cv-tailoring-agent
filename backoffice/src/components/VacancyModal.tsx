import { useEffect } from 'react';
import {
  STAGES,
  stageLabel,
  tailoringFromStatus,
  tailoringLabel,
  tailoringMeta,
} from '../lib/stages';
import type { BoardCard } from '../lib/types';

interface VacancyModalProps {
  card: BoardCard;
  onClose: () => void;
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

function duration(ms: number | null): string {
  return ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

/** Everything known about one vacancy, with the full change history at the bottom. */
export default function VacancyModal({ card, onClose }: VacancyModalProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stage = STAGES.find((item) => item.id === card.stage);
  const tailoring = tailoringFromStatus(card.status);

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-8">
      <div className="w-full max-w-3xl rounded-xl bg-white shadow-xl">
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
            {card.stage === 'created' && (
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ring-1 ${
                  tailoringMeta(tailoring).chip
                }`}
              >
                {tailoringLabel(tailoring)}
              </span>
            )}
            <span className="text-xs text-slate-400">#{card.externalId}</span>
          </div>

          {card.stage === 'created' && (
            <p className="mt-2 text-[11px] text-slate-500">
              The tailoring sub-state follows the worker's status (<code>{card.status}</code>) - it is
              not set from here.
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
            <Field label="Result (PDF)" value={card.pdfUrl ? 'available' : 'not stored yet'} />
            <Field label="Result (DOCX)" value={card.docxPath ? 'available' : 'not stored yet'} />
          </dl>

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
            {card.pdfUrl && (
              <a
                href={card.pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                Tailored PDF
              </a>
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
                <li key={item.id} className="flex gap-3">
                  <span
                    className={`mt-0.5 h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ${
                      item.actor === 'Me'
                        ? 'bg-slate-100 text-slate-600 ring-slate-200'
                        : 'bg-indigo-100 text-indigo-700 ring-indigo-200'
                    }`}
                  >
                    {item.actor}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm text-slate-800">{item.action}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      {item.kind === 'move'
                        ? `stage: ${stageLabel(item.from)} → ${stageLabel(item.to)}`
                        : `tailoring: ${tailoringLabel(item.from)} → ${tailoringLabel(item.to)}`}
                      {' · '}
                      {formatDateTime(item.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
