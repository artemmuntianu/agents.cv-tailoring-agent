import type { CoverLetterState } from './types';

/**
 * What the cover-letter page (`/cover/<job_id>`) shows for one card - and why the ask button is
 * unavailable.
 *
 * Pure on purpose: the wording and the branch are unit tested, and the component stays a
 * rendering layer (`CONSTITUTION.md` invariant 23 is the server-side half of the same idea).
 */
export type CoverState = 'absent' | 'queued' | 'running' | 'completed' | 'failed';

export function coverState(letter: CoverLetterState | null): CoverState {
  if (!letter) return 'absent';
  const status = (letter.status || '').toLowerCase();
  if (status === 'completed') return letter.text ? 'completed' : 'queued';
  if (status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  return 'queued';
}

export function coverStateLabel(state: CoverState): string {
  switch (state) {
    case 'completed':
      return 'Ready';
    case 'running':
      return 'Writing…';
    case 'queued':
      return 'Queued';
    case 'failed':
      return 'Failed';
    case 'absent':
      return 'Not generated';
  }
}

/**
 * What a request for a letter did, or decided not to do.
 *
 * `skipped` is the honest answer for a card that did not enter Prepare, so the move route can
 * report one value in every case; `unavailable` is the card that cannot have a letter at all
 * (no stored job description - invariant 24).
 */
export type CoverOutcome = 'queued' | 'already' | 'busy' | 'failed' | 'skipped' | 'unavailable';

/**
 * Whether entering Prepare should publish a letter request.
 *
 * Everything except "nothing here" and "the last attempt failed" counts as already asked for:
 * `queued` means *asked for* (invariant 24), so a letter that is written or on its way must not
 * be regenerated behind the operator's back - that would replace text they may have read, and
 * pay for a second Gemini call. A `completed` row without text is no exception: the page
 * reads that as "on its way", and the operator's own *Generate* is what fixes it.
 */
export function coverNeeded(letter: CoverLetterState | null): boolean {
  const state = coverState(letter);
  return state === 'absent' || state === 'failed';
}

/** The one line the board shows after a move; null when there is nothing worth saying. */
export function coverOutcomeNote(outcome: CoverOutcome): string | null {
  switch (outcome) {
    case 'queued':
      return 'Cover letter queued as well.';
    case 'already':
      return 'Cover letter already written or on its way - left it alone.';
    case 'busy':
      return 'A cover letter is being written right now.';
    case 'failed':
      return 'Cover letter could not be queued - use Generate on its page.';
    case 'unavailable':
      return 'No letter: this card has no stored job description (scrape the page again).';
    case 'skipped':
      return null;
  }
}

/**
 * What the *ask for a letter* button says in each state.
 *
 * It lived as a ternary inside the card modal's section; it is here because the page that owns the button
 * should stay a rendering layer - the same reason `coverState` and the blocked reason are here.
 */
export function coverActionLabel(state: CoverState): string {
  if (state === 'absent') return 'Generate';
  if (state === 'failed') return 'Try again';
  return 'Regenerate';
}

/** The page's status chip, one class string per state (`lib/docxUpload.ts` does the same for renders). */
export const COVER_STATE_CHIP: Record<CoverState, string> = {
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  running: 'bg-amber-50 text-amber-800 ring-amber-200',
  queued: 'bg-slate-100 text-slate-700 ring-slate-200',
  failed: 'bg-rose-50 text-rose-700 ring-rose-200',
  absent: 'bg-slate-100 text-slate-500 ring-slate-200',
};

/**
 * Why *Generate* is unavailable, or null when it is available.
 *
 * A card without a stored job description cannot produce a letter at all - the worker refuses
 * such a message on purpose (invariant 23) - so the page explains that instead of offering a
 * button that must fail.
 */
export function coverBlockedReason(hasDescription: boolean): string | null {
  return hasDescription
    ? null
    : 'This card has no job description stored (it was scraped before that column existed) - scrape the page again first.';
}
