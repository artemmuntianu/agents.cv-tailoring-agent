import { describe, expect, it } from 'vitest';
import { STAGES, nextStage } from './stages';

/**
 * `nextStage` backs the vacancy dialog's `Move to <next column>` button. The invariant worth
 * pinning is that it agrees with the board's own column order instead of keeping a second copy.
 */
describe('nextStage (the dialog move-to-next-column button)', () => {
  it('walks the funnel in board order', () => {
    expect(nextStage('scraped')?.id).toBe('prepare');
    expect(nextStage('prepare')?.id).toBe('applied');
    expect(nextStage('applied')?.id).toBe('negotiating');
    expect(nextStage('negotiating')?.id).toBe('interviewing');
    expect(nextStage('interviewing')?.id).toBe('offer');
  });

  it('has nowhere to go from the last column', () => {
    expect(nextStage('offer')).toBeUndefined();
  });

  it('returns undefined for a column that does not exist', () => {
    expect(nextStage('nope')).toBeUndefined();
  });

  it('never disagrees with the STAGES order', () => {
    for (let index = 0; index < STAGES.length - 1; index += 1) {
      expect(nextStage(STAGES[index].id)).toBe(STAGES[index + 1]);
    }
    expect(nextStage(STAGES[STAGES.length - 1].id)).toBeUndefined();
  });
});