import { RELATIVE_DAYS, calendarDaysBetween } from './cardMeta';
import { hasReachedInterviewing, sortInterviews } from './interviews';
import type { BoardCard, Interview } from './types';

/**
 * The one interview fact the card face carries: when the next call is, or - when nothing is
 * upcoming - when the last one was, plus a counter for calls whose day has passed with no
 * `result` written down.
 *
 * The Interviews section itself lives in the modal, which is the wrong place for the question the
 * board is asked every morning ("what is next, and what did I forget to write down?"). So the face
 * gets a single line, and this module owns its vocabulary - the same split as `lib/cardMeta.ts`,
 * which owns the other reading line.
 *
 * Two rules are the point of this module.
 *
 * **A call belongs to a day, not to a timestamp.** The face flips `next` to `last` at local
 * midnight, never at the start minute: a 14:30 call read at 14:31 is still what the operator is
 * doing, and a label that changes while the call is happening is worse than no label. That is why
 * the face does not use `interviews.ts::nextInterview`, whose `>= now` strictness answers a
 * different question (has it started?).
 *
 * **Only a day that is over can be missing a result.** A call earlier today is not a debt yet -
 * the operator is about to write it - so the amber counter counts past days only.
 *
 * The label is a distance, not a date: `today, Mon 9:00 AM`, `tomorrow, Fri 11:00 AM`,
 * `in 9 days, Mon 1:45 PM`, `2 days ago, Fri 11:00 AM` - and past `RELATIVE_DAYS`, the date itself
 * (`Sep 24, Wed 1:00 AM`). One boundary for both directions, shared with `cardMeta.ts`.
 */

export interface InterviewFace {
  /**
   * `today, Mon 9:00 AM` · `2 days ago, Fri 11:00 AM` · `next Sep 24, Wed 1:00 AM` (the far date is
   * the one shape that needs the direction spelled out, because a bare date does not say which way
   * it points) · `no interview scheduled`.
   */
  label: string;
  /** `next` wears the Interviewing column's violet; `last` and `none` stay quiet. */
  tone: 'next' | 'last' | 'none';
  /** The stamp `label` is about, for the chip's tooltip; null when there is none to show. */
  at: string | null;
  /** Past calls with no `result` - the amber counter beside the chip, never part of `label`. */
  resultsToWrite: number;
}

/** Chip classes; literal so Tailwind can see them (`stages.ts::STAGES` does the same). */
export const INTERVIEW_FACE_TONES: Record<InterviewFace['tone'], string> = {
  next: 'bg-violet-100 text-violet-700 ring-violet-200',
  last: 'bg-slate-100 text-slate-600 ring-slate-200',
  none: 'bg-slate-50 text-slate-500 ring-slate-200',
};

/**
 * Whole local midnights from today: `0` today, `1` tomorrow, `-1` yesterday, `null` unreadable.
 *
 * The unit is the one `cardMeta.ts` already dates cards in, so both lines on the face speak the
 * same day - "today" means the same thing in `updated today` and `today, 9:00 AM`.
 */
export function dayOffset(iso: string, now: Date = new Date()): number | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return offsetOf(at, now);
}

/**
 * The day distance, signed so that positive is the future.
 *
 * Never a negative zero: `today` has to compare equal to `0` *and* read as `0`, and `-0` only does
 * the first.
 */
function offsetOf(at: Date, now: Date): number {
  const days = calendarDaysBetween(at, now);
  return days === 0 ? 0 : -days;
}

/**
 * A call's distance from today, then the weekday and the time:
 * `today, Mon 9:00 AM` · `tomorrow, Fri 11:00 AM` · `yesterday, Thu 3:15 PM` ·
 * `in 9 days, Mon 1:45 PM` · `2 days ago, Fri 11:00 AM` · `Sep 24, Wed 1:00 AM` past the boundary.
 *
 * While the call is inside `RELATIVE_DAYS` the distance *is* the label - "2 days ago" and "in 9
 * days" are how the day is thought about - and past it the date takes over, because nobody converts
 * "43 days ago" back into a day. That boundary is `cardMeta.ts`'s on purpose: an interview and a
 * card stop being relative on the same day, so the face never mixes two ideas of "old".
 *
 * The weekday and the minute are always spelled out: the weekday is what places the date at a
 * glance, and the time is what the operator plans around. Locale-driven like the rest of the board
 * (`formatInterviewAt`, `cardMeta.ts::shortDate`), so an unreadable stamp reads as `unknown`
 * instead of a made-up date.
 */
export function whenLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';

  const days = offsetOf(at, now);
  const weekday = at.toLocaleDateString(undefined, { weekday: 'short' });
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const clock = `${weekday} ${time}`;

  if (days === 0) return `today, ${clock}`;
  if (days === 1) return `tomorrow, ${clock}`;
  if (days === -1) return `yesterday, ${clock}`;
  if (days > 1 && days <= RELATIVE_DAYS) return `in ${days} days, ${clock}`;
  if (days < -1 && days >= -RELATIVE_DAYS) return `${-days} days ago, ${clock}`;

  const date = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${date}, ${clock}`;
}

/**
 * A label with its direction, for the shapes that do not state one themselves.
 *
 * `tomorrow, Fri 11:00 AM` and `2 days ago, ...` already say which way they point, so a prefix
 * would only stutter. The bare date past the boundary is the one shape that cannot: `Sep 24, Wed
 * 1:00 AM` reads the same whether the call is behind or ahead, so it gets `next`/`last`.
 */
function directedLabel(prefix: 'next' | 'last', iso: string, now: Date): string {
  const days = dayOffset(iso, now);
  const label = whenLabel(iso, now);
  if (days === null || Math.abs(days) <= RELATIVE_DAYS) return label;
  return `${prefix} ${label}`;
}

/** The soonest call whose day has not ended yet - today's 14:30 still counts at 15:00. */
export function nextCall(interviews: Interview[], now: Date = new Date()): Interview | null {
  const upcoming = sortInterviews(interviews).find(
    (interview) => (dayOffset(interview.scheduledAt, now) ?? -1) >= 0,
  );
  return upcoming ?? null;
}

/** The latest call whose day has passed, or null. */
export function lastCall(interviews: Interview[], now: Date = new Date()): Interview | null {
  const sorted = sortInterviews(interviews);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const days = dayOffset(sorted[index].scheduledAt, now);
    if (days !== null && days < 0) return sorted[index];
  }
  return null;
}

/**
 * Past calls with no `result` written down, oldest first.
 *
 * An unreadable stamp is never counted: it cannot be proven to be in the past, and the counter is
 * a claim about the operator's own to-do list.
 */
export function unrecordedResults(interviews: Interview[], now: Date = new Date()): Interview[] {
  return sortInterviews(interviews).filter(
    (interview) => interview.result === null && (dayOffset(interview.scheduledAt, now) ?? 0) < 0,
  );
}

/**
 * The face's interview line, or null when the card has nothing to say about interviews.
 *
 * `null` covers two deliberate cases. A card that never reached Interviewing has no interview
 * vocabulary on its face. A **refused** card is muted anyway, and a call that will not happen must
 * not read as the next thing on the calendar.
 *
 * The line itself follows the rows, not the history: a card whose rows were removed stops
 * advertising a call even while its history still remembers the move into Interviewing. The
 * history is consulted for the one question rows cannot answer - whether an *empty* section is
 * honest, which is the same rule the modal's section uses (`hasReachedInterviewing`).
 */
export function faceInterview(card: BoardCard, now: Date = new Date()): InterviewFace | null {
  if (card.archived) return null;

  if (card.interviews.length === 0) {
    return hasReachedInterviewing(card)
      ? { label: 'no interview scheduled', tone: 'none', at: null, resultsToWrite: 0 }
      : null;
  }

  const resultsToWrite = unrecordedResults(card.interviews, now).length;

  const next = nextCall(card.interviews, now);
  if (next) {
    return {
      label: directedLabel('next', next.scheduledAt, now),
      tone: 'next',
      at: next.scheduledAt,
      resultsToWrite,
    };
  }

  const last = lastCall(card.interviews, now);
  if (last) {
    return {
      label: directedLabel('last', last.scheduledAt, now),
      tone: 'last',
      at: last.scheduledAt,
      resultsToWrite,
    };
  }

  // Rows exist, none of them carries a readable stamp: say so rather than dress it up as a date.
  return {
    label:
      card.interviews.length === 1
        ? 'interview date unreadable'
        : `${card.interviews.length} interview dates unreadable`,
    tone: 'none',
    at: null,
    resultsToWrite: 0,
  };
}
