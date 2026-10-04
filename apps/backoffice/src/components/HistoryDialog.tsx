import { useEffect, useState } from 'react';
import { ACTORS } from '../lib/board';
import {
  HISTORY_KINDS,
  KIND_LABEL,
  defaultTransition,
  draftFromHistory,
  draftToRequest,
  stateLabel,
  stateOptions,
} from '../lib/history';
import { ACTOR_HINT } from '../lib/stages';
import type { Actor, HistoryDraft, HistoryEntry, HistoryEntryRequest, HistoryKind } from '../lib/types';

interface HistoryDialogProps {
  /** The line being corrected. */
  entry: HistoryEntry;
  /** Which card it belongs to (`title · company`), so the dialog says where it is editing. */
  subtitle: string;
  onSave: (request: HistoryEntryRequest) => void;
  onCancel: () => void;
  /** True while the write is in flight: the buttons say so and stay disabled. */
  busy?: boolean;
  /** A failure from the API, shown above the buttons. */
  error?: string | null;
}

const LABEL = 'text-[11px] font-medium uppercase tracking-wide text-slate-400';
const FIELD =
  'mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal normal-case ' +
  'tracking-normal text-slate-900';

/**
 * Correct one line of a card's History: the date, who did it, the wording, the kind and the two
 * states - the whole line, because a half-fixed audit trail is still wrong.
 *
 * Two things make this dialog different from the ones that *change* a card. The **kind decides the
 * two state dropdowns** (a column id means nothing to an archive line, and the table itself cannot
 * check that), so switching kind moves the states to that kind's own pair. And the **wording is
 * corrected in place**: unlike the Move/Archive dialogs this never adds a value to the Action
 * vocabulary, because fixing what a line says is not making a new action.
 *
 * Like every dialog here it closes on Escape, on Cancel and on a click on the overlay; Escape is
 * handled in the **capture phase** so it does not also close the card behind it.
 */
export default function HistoryDialog({
  entry,
  subtitle,
  onSave,
  onCancel,
  busy = false,
  error = null,
}: HistoryDialogProps) {
  const [draft, setDraft] = useState<HistoryDraft>(() => draftFromHistory(entry));
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onCancel]);

  /** A new kind brings its own states: keep a state only when that kind still understands it. */
  function changeKind(kind: HistoryKind) {
    const options = stateOptions(kind);
    const fallback = defaultTransition(kind);
    setLocalError(null);
    setDraft((current) => ({
      ...current,
      kind,
      from: options.includes(current.from) ? current.from : fallback.from,
      to: options.includes(current.to) ? current.to : fallback.to,
    }));
  }

  const canSave = draft.action.trim().length > 0 && draft.at.trim().length > 0 && !busy;

  function submit() {
    const parsed = draftToRequest(draft);
    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }
    setLocalError(null);
    onSave(parsed.value);
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-6"
      onClick={onCancel}
    >
      <form
        className="w-full max-w-xl rounded-xl bg-white p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) submit();
        }}
      >
        <h2 className="text-base font-semibold text-slate-900">✏️ Correct this history line</h2>
        <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="block">
            <span className={LABEL}>When</span>
            <input
              type="datetime-local"
              value={draft.at}
              onChange={(event) => setDraft((current) => ({ ...current, at: event.target.value }))}
              className={FIELD}
              autoFocus
            />
          </label>
          <label className="block">
            <span className={LABEL}>Actor</span>
            <select
              value={draft.actor}
              onChange={(event) =>
                setDraft((current) => ({ ...current, actor: event.target.value as Actor }))
              }
              className={FIELD}
            >
              {ACTORS.map((actor) => (
                <option key={actor} value={actor}>
                  {actor} ({ACTOR_HINT[actor]})
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="mt-3 block">
          <span className={LABEL}>Reason</span>
          <input
            type="text"
            value={draft.action}
            maxLength={500}
            onChange={(event) =>
              setDraft((current) => ({ ...current, action: event.target.value }))
            }
            className={FIELD}
          />
        </label>

        <label className="mt-3 block">
          <span className={LABEL}>Kind</span>
          <select
            value={draft.kind}
            onChange={(event) => changeKind(event.target.value as HistoryKind)}
            className={FIELD}
          >
            {HISTORY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className={LABEL}>From</span>
            <select
              value={draft.from}
              onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
              className={FIELD}
            >
              {stateOptions(draft.kind).map((state) => (
                <option key={state} value={state}>
                  {stateLabel(draft.kind, state)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={LABEL}>To</span>
            <select
              value={draft.to}
              onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
              className={FIELD}
            >
              {stateOptions(draft.kind).map((state) => (
                <option key={state} value={state}>
                  {stateLabel(draft.kind, state)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
          This rewrites the record and nothing else: the card keeps its column, the Action list is
          not touched, and the corrected line keeps the date you set - the change is not dated
          itself, so fixing the log is not operator activity and does not reset the inactivity
          clock.
        </p>

        {(localError ?? error) && (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {localError ?? error}
          </p>
        )}

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
            disabled={!canSave}
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {busy ? 'Saving…' : 'Save line'}
          </button>
        </div>
      </form>
    </div>
  );
}

