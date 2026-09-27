import { useEffect, useState } from 'react';
import { EMPTY_INTERVIEW_DRAFT, parseInterviewRequest, toDateTimeLocal } from '../lib/interviews';
import type { Interview, InterviewDraft, InterviewRequest } from '../lib/types';
import InterviewFields from './InterviewFields';

interface InterviewDialogProps {
  /** The interview being edited, or `null` for a new one - the same dialog for both. */
  interview: Interview | null;
  /** What the dialog is for (`Add interview` / `Edit interview`) and which card. */
  title: string;
  subtitle: string;
  onSave: (request: InterviewRequest) => void;
  onCancel: () => void;
  /** True while the write is in flight: the buttons say so and stay disabled. */
  busy?: boolean;
  /** A failure from the API, shown above the buttons. */
  error?: string | null;
}

/**
 * Add or edit one interview: date &amp; time, type, and the `result` the operator wrote down.
 *
 * The **result** is what makes this dialog different from the Move dialog's Interview section -
 * that one schedules a call, this one also records how it went, which is why the section's Edit
 * button exists at all. Nothing here touches the card's column or its history.
 *
 * Like every dialog on this board it closes on Escape, on Cancel **and on a click on the
 * overlay**; the panel stops the click, so only the backdrop counts.
 */
export default function InterviewDialog({
  interview,
  title,
  subtitle,
  onSave,
  onCancel,
  busy = false,
  error = null,
}: InterviewDialogProps) {
  const [draft, setDraft] = useState<InterviewDraft>(() =>
    interview
      ? { scheduledAt: toDateTimeLocal(interview.scheduledAt), type: interview.type }
      : { ...EMPTY_INTERVIEW_DRAFT },
  );
  const [result, setResult] = useState(interview?.result ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCancel();
    };
    // Capture phase + stopPropagation: this dialog sits on top of the card modal, which also
    // listens for Escape on `window` - without this, Escape would close the card as well.
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onCancel]);

  const canSave = draft.scheduledAt.trim().length > 0 && !busy;

  function submit() {
    const parsed = parseInterviewRequest({
      scheduledAt: draft.scheduledAt,
      type: draft.type,
      result,
    });
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
        className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) submit();
        }}
      >
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>

        <InterviewFields
          scheduledAt={draft.scheduledAt}
          type={draft.type}
          onScheduledAt={(scheduledAt) => setDraft((current) => ({ ...current, scheduledAt }))}
          onType={(type) => setDraft((current) => ({ ...current, type }))}
          result={result}
          onResult={setResult}
          autoFocus
        />

        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          Interviews are their own record: editing one never adds a line to the card's History.
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
            {busy ? 'Saving…' : interview ? 'Save interview' : 'Add interview'}
          </button>
        </div>
      </form>
    </div>
  );
}
