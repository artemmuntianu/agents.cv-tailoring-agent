import { INTERVIEW_HINT, INTERVIEW_TYPES, MAX_RESULT_LENGTH } from '../lib/interviews';
import type { InterviewType } from '../lib/types';

interface InterviewFieldsProps {
  /** `datetime-local` value; `''` means "not scheduled yet". */
  scheduledAt: string;
  type: InterviewType;
  onScheduledAt: (value: string) => void;
  onType: (value: InterviewType) => void;
  /**
   * The `result` text. Omit the pair and the field is not rendered at all - the Move dialog's
   * Interview section collects a *scheduled* call, which has no result yet.
   */
  result?: string;
  onResult?: (value: string) => void;
  autoFocus?: boolean;
}

const INPUT =
  'mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal normal-case ' +
  'tracking-normal text-slate-900 placeholder:text-slate-400';

/**
 * The interview fields, shared by the Move dialog's Interview section and the section's
 * Add/Edit dialog, so the two can never drift apart.
 *
 * The date input is **local time** - that is what `datetime-local` means - and it is converted
 * to an ISO instant before it leaves the browser (`parseInterviewRequest`), so the row stores an
 * instant and the board renders it back in whatever timezone the operator is in.
 */
export default function InterviewFields({
  scheduledAt,
  type,
  onScheduledAt,
  onType,
  result,
  onResult,
  autoFocus = false,
}: InterviewFieldsProps) {
  return (
    <>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
          Date &amp; time
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(event) => onScheduledAt(event.target.value)}
            autoFocus={autoFocus}
            className={INPUT}
          />
          <span className="mt-1 block text-[11px] font-normal normal-case tracking-normal text-slate-400">
            your local time
          </span>
        </label>

        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
          Type
          <select
            value={type}
            onChange={(event) => onType(event.target.value as InterviewType)}
            className={INPUT}
          >
            {INTERVIEW_TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] font-normal normal-case tracking-normal text-slate-400">
            {INTERVIEW_HINT[type]}
          </span>
        </label>
      </div>

      {onResult && (
        <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-500">
          Result
          <textarea
            value={result ?? ''}
            onChange={(event) => onResult(event.target.value)}
            rows={3}
            maxLength={MAX_RESULT_LENGTH}
            placeholder="how it went (optional)"
            className={`${INPUT} resize-y`}
          />
          <span className="mt-1 block text-[11px] font-normal normal-case tracking-normal text-slate-400">
            free text · optional · {MAX_RESULT_LENGTH} characters max
          </span>
        </label>
      )}
    </>
  );
}
