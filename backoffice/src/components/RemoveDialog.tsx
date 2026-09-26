import { useEffect } from 'react';
import { stageLabel } from '../lib/stages';
import type { BoardCard } from '../lib/types';

interface RemoveDialogProps {
  card: BoardCard;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation for the board's only irreversible action, and it spells out what
 * disappears: the card with its history (both cascade from `resumes`), the artifacts the
 * worker stored, and the refusal record. There is no undo and no tombstone - which is the
 * point - so this dialog is the last place a mistake can be caught.
 */
export default function RemoveDialog({ card, onConfirm, onCancel }: RemoveDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-6">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-rose-700">🗑 Remove this vacancy?</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          {card.title || card.externalId} · {card.company || 'unknown company'} ·{' '}
          {stageLabel(card.stage)}
        </p>

        <ul className="mt-4 space-y-1 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-800">
          <li>
            • the card, its column and its whole history ({card.history.length}{' '}
            {card.history.length === 1 ? 'entry' : 'entries'})
          </li>
          <li>• the tailored documents the worker stored for it</li>
          <li>• the refusal record ({card.archivedReason ?? 'no reason'})</li>
        </ul>

        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          Nothing is kept as a record: re-scraping the same page creates a fresh card and pays
          for tailoring again. Files that live on the cluster volume are queued for{' '}
          <code>.\scripts\storage-files.ps1 -Action purge</code>.
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
            🗑 Remove for good
          </button>
        </div>
      </div>
    </div>
  );
}
