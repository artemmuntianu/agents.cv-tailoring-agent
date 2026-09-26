import { describe, expect, it } from 'vitest';
import { coverBlockedReason, coverState, coverStateLabel } from './cover';
import type { CoverLetterState } from './types';

const letter = (overrides: Partial<CoverLetterState> = {}): CoverLetterState => ({
  status: 'queued',
  text: null,
  error: null,
  model: null,
  updatedAt: '2026-09-26T10:00:00.000Z',
  ...overrides,
});

describe('cover-letter state (what the modal shows)', () => {
  it('treats "nobody asked yet" as absent', () => {
    expect(coverState(null)).toBe('absent');
    expect(coverStateLabel('absent')).toBe('Not generated');
  });

  it('only calls a letter ready when there is text to copy', () => {
    expect(coverState(letter({ status: 'completed', text: 'Hello,' }))).toBe('completed');
    // A `completed` row without text is a broken row, not something to show: keep waiting.
    expect(coverState(letter({ status: 'completed', text: null }))).toBe('queued');
  });

  it("reads the worker's own statuses", () => {
    expect(coverState(letter({ status: 'running' }))).toBe('running');
    expect(coverState(letter({ status: 'failed', error: 'boom' }))).toBe('failed');
    expect(coverState(letter({ status: 'queued' }))).toBe('queued');
  });

  it('falls back to queued for a status it does not know', () => {
    expect(coverState(letter({ status: 'something-new' }))).toBe('queued');
  });

  it('blocks the button, with a reason, when there is no stored job description', () => {
    expect(coverBlockedReason(true)).toBeNull();
    expect(coverBlockedReason(false)).toMatch(/no job description stored/);
  });
});
