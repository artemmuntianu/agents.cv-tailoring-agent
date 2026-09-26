import { useEffect, useState } from 'react';
import { ACTORS } from '../lib/board';
import { ACTOR_HINT } from '../lib/stages';
import type { Actor, BoardAction } from '../lib/types';
import ActionCombobox from './ActionCombobox';

interface ReasonDialogProps {
  title: string;
  fromLabel: string;
  toLabel: string;
  /** Extra hint under the title (e.g. the vacancy being changed). */
  subtitle: string;
  /** The Action vocabulary; omit it and the field is plain free text. */
  actions?: BoardAction[];
  /** Which vocabulary to rank first (refusals vs. progress notes). */
  actionsKind?: BoardAction['kind'];
  actionLabel?: string;
  confirmLabel?: string;
  /** 'danger' paints the confirm button the way the refusal it confirms reads. */
  tone?: 'neutral' | 'danger';
  defaultActor?: Actor;
  onProceed: (actor: Actor, action: string) => void;
  onCancel: () => void;
}

/**
 * The dialog every manual change goes through - a move **and** a refusal: a fixed Actor
 * dropdown (Candidate / Company, the stored vocabulary) plus the reason. The reason
 * field is the Action combobox, so it offers the persisted vocabulary and accepts new
 * wording; typing a new one stores it for next time.
 *
 * Nothing is committed until the confirm button - Cancel/Escape just closes, so the
 * card stays where it was.
 */
export default function ReasonDialog({
  title,
  fromLabel,
  toLabel,
  subtitle,
  actions = [],
  actionsKind = 'move',
  actionLabel = 'Action',
  confirmLabel = 'Proceed',
  tone = 'neutral',
  defaultActor = 'Candidate',
  onProceed,
  onCancel,
}: ReasonDialogProps) {
  const [actor, setActor] = useState<Actor>(defaultActor);
  const [action, setAction] = useState('');

  useEffect(() => {
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
            {ACTORS.map((value) => (
              <option key={value} value={value}>
                {value} ({ACTOR_HINT[value]})
              </option>
            ))}
          </select>
        </label>

        <ActionCombobox
          value={action}
          onChange={setAction}
          kind={actionsKind}
          actions={actions}
          label={actionLabel}
          autoFocus
        />

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
            className={
              tone === 'danger'
                ? 'rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300'
                : 'rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
