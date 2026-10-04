import { useEffect } from 'react';
import { historyLine } from '../lib/board';
import type { HistoryEntry } from '../lib/types';

interface HistoryRemoveDialogProps {
  /** The line that would disappear. */
  entry: HistoryEntry;
  /** Which card, and how many lines it has left after this one goes. */
  subtitle: string;
  /** How many lines the card will still have - the count the section's header shows. */
  remaining: number;
  onConfirm: () => void;
  onCancel: () => void;
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

/**
 * The confirmation for dropping one line of a card's History.
 *
 * A history line is the audit trail, so removing one is a deliberate act and this dialog spells out
 * both halves of it: what goes (one line, quoted in full, from `N` entries to `N-1`) and what stays
 * (the card, its column, its archive flags, its remaining lines, its interviews). The one knock-on
 * worth saying out loud is the **Interviews** section - it is shown on the strength of the move into
 * Interviewing, so that particular line takes the section with it while the interview rows stay put.
 *
 * Like every dialog here it closes on Cancel, on Escape and on a click on the overlay.
 */
export default function HistoryRemoveDialog({
  entry,
  subtitle,
  remaining,
  onConfirm,
  onCancel,
}: HistoryRemoveDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Capture phase: the card modal behind this dialog also listens for Escape.
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onCancel]);

  const opensInterviews = entry.kind === 'move' && entry.to === 'interviewing';

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-6"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-rose-700">✕ Remove this history line?</h2>
        <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>

        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {entry.actor}
          </p>
          <p className="mt-0.5 break-words text-sm text-slate-800">{entry.action}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {historyLine(entry)}
            {' · '}
            {formatDateTime(entry.at)}
          </p>
        </div>

        <ul className="mt-3 space-y-1 text-xs text-rose-800">
          <li>• the line above, from the card's trail ({remaining} left after this)</li>
          {opensInterviews && (
            <li>
              • the Interviews section, because this is the move into Interviewing that shows it
              (the interview rows themselves stay on the card)
            </li>
          )}
        </ul>

        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          Everything else stays: the card keeps its column, its archive state and its other lines,
          the Action list is untouched, and the card's activity date is not moved - so this cannot
          buy a card another ten days from the inactivity sweep.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white"
          >
            ✕ Remove line
          </button>
        </div>
      </div>
    </div>
  );
}
