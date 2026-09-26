import { useEffect, useRef, useState } from 'react';
import type { Actor } from '../lib/types';

interface ReasonDialogProps {
  title: string;
  fromLabel: string;
  toLabel: string;
  /** Extra hint under the title (e.g. the vacancy being changed). */
  subtitle: string;
  onProceed: (actor: Actor, action: string) => void;
  onCancel: () => void;
}

/**
 * The dialog every manual change goes through: a fixed Actor dropdown (Me / Them)
 * plus the free-text reason. Nothing is committed until "Proceed" - "Cancel" just
 * closes, so the card stays where it was.
 */
export default function ReasonDialog({
  title,
  fromLabel,
  toLabel,
  subtitle,
  onProceed,
  onCancel,
}: ReasonDialogProps) {
  const [actor, setActor] = useState<Actor>('Me');
  const [action, setAction] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const canProceed = action.trim().length > 0;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-6">
      <form
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (canProceed) onProceed(actor, action);
        }}
      >
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>

        <div className="mt-4 flex items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <span className="font-medium">{fromLabel}</span>
          <span aria-hidden>→</span>
          <span className="font-medium text-slate-900">{toLabel}</span>
        </div>

        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500">
          Actor
          <select
            value={actor}
            onChange={(event) => setActor(event.target.value as Actor)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-900"
          >
            <option value="Me">Me</option>
            <option value="Them">Them</option>
          </select>
        </label>

        <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-500">
          Action
          <input
            ref={inputRef}
            value={action}
            onChange={(event) => setAction(event.target.value)}
            placeholder="What happened? (required)"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-900 placeholder:text-slate-400"
          />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canProceed}
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Proceed
          </button>
        </div>
      </form>
    </div>
  );
}
