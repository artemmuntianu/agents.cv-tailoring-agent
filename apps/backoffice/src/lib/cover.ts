import type { CoverLetterState } from './types';

/**
 * What the modal shows for one card's cover letter - and why a button is unavailable.
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
 * pay for a second Gemini call. A `completed` row without text is no exception: the modal
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
      return 'Cover letter could not be queued - use Generate in the card.';
    case 'unavailable':
      return 'No letter: this card has no stored job description (scrape the page again).';
    case 'skipped':
      return null;
  }
}

/**
 * Why *Generate* is unavailable, or null when it is available.
 *
 * A card without a stored job description cannot produce a letter at all - the worker refuses
 * such a message on purpose (invariant 23) - so the modal explains that instead of offering a
 * button that must fail.
 */
export function coverBlockedReason(hasDescription: boolean): string | null {
  return hasDescription
    ? null
    : 'This card has no job description stored (it was scraped before that column existed) - scrape the page again first.';
}
