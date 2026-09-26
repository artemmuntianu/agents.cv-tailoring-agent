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
