import type { BoardCard, Interview, InterviewDraft, InterviewRequest, InterviewType } from './types';

/**
 * The Interviews section: its vocabulary, its visibility rule and the pure helpers the card
 * and its dialogs share.
 *
 * The four types are the same kind of vocabulary as the Actors and the columns - code plus a
 * DB CHECK (`resume_interview.type`), never editable from `/admin`.
 *
 * An interview write is **operator activity**: `resume_interview` stays the interview's own
 * record (the `result` text lives there and nowhere else), and each of the three writes also
 * leaves one `resume_history` line and bumps `resume_board.updated_at`, so the card's *Updated*
 * label and the inactivity sweep count it (`CONSTITUTION.md` invariant 26, revised 2026-10-01).
 */

export const INTERVIEW_TYPES: InterviewType[] = [
  'Initial Interview',
  'Technical Interview',
  'Management Interview',
  'Final Interview',
];

export const INTERVIEW_HINT: Record<InterviewType, string> = {
  'Initial Interview': 'the screening call',
  'Technical Interview': 'the skills round',
  'Management Interview': 'your future manager',
  'Final Interview': 'the last round',
};

/** Longest `result` the database accepts (`resume_interview_result_check`). */
export const MAX_RESULT_LENGTH = 2000;

/** The three interview writes, as History words them. */
export type InterviewHistoryVerb = 'added' | 'edited' | 'removed';

const INTERVIEW_HISTORY_VERB: Record<InterviewHistoryVerb, string> = {
  added: 'Interview added',
  edited: 'Interview edited',
  removed: 'Interview removed',
};

/**
 * The `resume_history.action` line one interview write leaves - pure, so the wording is unit
 * tested instead of living in SQL.
 *
 * It carries the round and when it was scheduled, never the `result`: that column caps at 500
 * characters while a `result` may hold 2000, and the *Interviews* section (with the pencil) is
 * where the note belongs. The date is rendered stable and timezone-free - the same wall-clock
 * the operator typed - because a History line is data, not a formatted cell.
 */
export function interviewHistoryAction(
  verb: InterviewHistoryVerb,
  interview: { scheduledAt: string; type: string },
): string {
  const when = String(interview.scheduledAt ?? '').replace('T', ' ').slice(0, 16);
  const type = String(interview.type ?? '').trim() || 'Interview';
  return `${INTERVIEW_HISTORY_VERB[verb]}: ${type}${when ? `, ${when}` : ''}`;
}

export function isInterviewType(value: unknown): value is InterviewType {
  return typeof value === 'string' && (INTERVIEW_TYPES as string[]).includes(value);
}

/**
 * Whether the card has ever been in the **Interviewing** column.
 *
 * The section is shown on the strength of the history (`kind = 'move'` into `interviewing`) or
 * of the current column - never on the strength of an interview row: a card that moved on to
 * Offer keeps the interviews it had, and one whose scheduling was undone does not keep an
 * empty section.
 */
export function hasReachedInterviewing(card: BoardCard): boolean {
  if (card.stage === 'interviewing') return true;
  return card.history.some((entry) => entry.kind === 'move' && entry.to === 'interviewing');
}

/** Oldest first: the list reads as a timeline, not as a feed. */
export function sortInterviews(interviews: Interview[]): Interview[] {
  return [...interviews].sort((a, b) => {
    const byDate = a.scheduledAt.localeCompare(b.scheduledAt);
    return byDate !== 0 ? byDate : a.id - b.id;
  });
}

/** The next interview that has not happened yet, or null. */
export function nextInterview(interviews: Interview[], now: Date = new Date()): Interview | null {
  return (
    sortInterviews(interviews).find(
      (interview) => new Date(interview.scheduledAt).getTime() >= now.getTime(),
    ) ?? null
  );
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function asObject(body: unknown): ParseResult<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  return { ok: true, value: body as Record<string, unknown> };
}

/**
 * Validate an interview body (`POST`/`PATCH /api/board/interviews`).
 *
 * `scheduledAt` is either a `<input type="datetime-local">` value or anything `Date` can read;
 * it is normalised to an ISO timestamp because the column is `timestamptz`. An empty `result`
 * means "clear it", and the type must be one of the four the section offers - so the DB CHECK
 * is never the first thing to reject a request.
 */
export function parseInterviewRequest(body: unknown): ParseResult<InterviewRequest> {
  const object = asObject(body);
  if (!object.ok) return object;
  const raw = object.value;

  const scheduledAt = typeof raw.scheduledAt === 'string' ? raw.scheduledAt.trim() : '';
  const at = scheduledAt ? new Date(scheduledAt) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return { ok: false, error: 'scheduledAt must be a date and time' };
  }
  if (!isInterviewType(raw.type)) {
    return { ok: false, error: `type must be one of: ${INTERVIEW_TYPES.join(', ')}` };
  }

  const result = typeof raw.result === 'string' ? raw.result.replace(/\s+/g, ' ').trim() : '';
  if (result.length > MAX_RESULT_LENGTH) {
    return { ok: false, error: `result must be at most ${MAX_RESULT_LENGTH} characters` };
  }

  return {
    ok: true,
    value: { scheduledAt: at.toISOString(), type: raw.type, result: result || null },
  };
}

/**
 * Validate a `POST /api/board/interviews` body: the card it belongs to plus the interview.
 *
 * The job id is checked here rather than in the route so the whole body contract is in one
 * place - and a body without one is rejected before the database is touched.
 */
export function parseInterviewCreate(
  body: unknown,
): ParseResult<{ jobId: string; interview: InterviewRequest }> {
  const object = asObject(body);
  if (!object.ok) return object;
  const jobId = typeof object.value.jobId === 'string' ? object.value.jobId.trim() : '';
  if (!jobId) return { ok: false, error: 'jobId is required' };

  const interview = parseInterviewRequest(body);
  if (!interview.ok) return interview;
  return { ok: true, value: { jobId, interview: interview.value } };
}

/** A `datetime-local` value for an ISO timestamp (the two shapes are not interchangeable). */
export function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** `Wed, 30 Sep 2026, 14:30` - the one format the section and its dialog both use. */
export function formatInterviewAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The draft the Move dialog collects when a card enters **Interviewing**, and the card's
 * `➕ Add` collects from scratch. `Initial Interview` is the type the first round usually is.
 */
export const EMPTY_INTERVIEW_DRAFT: InterviewDraft = {
  scheduledAt: '',
  type: 'Initial Interview',
};

/**
 * The draft as the API wants it, or null when the operator left it alone.
 *
 * A date is what makes a draft an interview: the section is where an *unscheduled* interview
 * lives, so an empty draft must not create a row with a made-up date.
 */
export function draftToRequest(draft: InterviewDraft): InterviewRequest | null {
  if (!draft.scheduledAt.trim()) return null;
  const parsed = parseInterviewRequest({
    scheduledAt: draft.scheduledAt,
    type: draft.type,
    result: null,
  });
  return parsed.ok ? parsed.value : null;
}
