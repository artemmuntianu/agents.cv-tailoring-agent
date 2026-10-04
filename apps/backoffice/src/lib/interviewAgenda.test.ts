import { describe, expect, it } from 'vitest';
import { RELATIVE_DAYS, shortDate } from './cardMeta';
import {
  dayOffset,
  faceInterview,
  lastCall,
  nextCall,
  unrecordedResults,
  whenLabel,
} from './interviewAgenda';
import type { BoardCard, Interview } from './types';

/**
 * The card face's interview line, pinned to one instant: 29 Sep 2026, 09:00 local.
 *
 * Two boundary rules carry most of these tests. A call belongs to its *day*, so a 14:30 call read
 * at 15:00 still reads as today - and a result is only owed once that day is over.
 */

const NOW = new Date(2026, 8, 29, 9, 0, 0);

/** An interview `days` local days from 29 Sep 2026 at `hour:minute` - local, so no zone shifts it. */
function at(days: number, hour = 14, minute = 30): string {
  return new Date(2026, 8, 29 + days, hour, minute).toISOString();
}

/** The time and the weekday the board's own locale renders - asserted against, never hardcoded. */
function localeTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function weekday(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
}

/** The `Mon 9:00 AM` half of every label, derived from the locale rather than hardcoded. */
function clock(iso: string): string {
  return `${weekday(iso)} ${localeTime(iso)}`;
}

function interview(overrides: Partial<Interview> = {}): Interview {
  return {
    id: 1,
    jobId: '374001-1',
    scheduledAt: at(1),
    type: 'Technical Interview',
    result: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    jobId: '374001-1',
    externalId: '374001',
    source: 'dou',
    title: 'Platform Lead',
    company: 'Acme',
    sourceUrl: null,
    cvVersion: 'v1',
    status: 'completed',
    attempts: 1,
    revisionCount: 1,
    durationMs: 12000,
    error: null,
    pdfUrl: null,
    docxPath: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:05:00.000Z',
    stage: 'applied',
    archivedAt: null,
    archivedActor: null,
    archivedReason: null,
    archived: false,
    artifactAvailability: { pdf: false, docx: false },
    coverLetter: null,
    docxUpdate: null,
    hasDescription: true,
    history: [],
    details: {
      recruiter: null,
      salaryOffered: null,
      salaryDesired: null,
      communicationChannels: [],
      applyUrl: null,
    },
    interviews: [],
    ...overrides,
  };
}

describe('the day is the unit the face dates a call in', () => {
  it('counts whole local days around today', () => {
    expect(dayOffset(at(0, 0, 1), NOW)).toBe(0);
    expect(dayOffset(at(1, 0, 1), NOW)).toBe(1);
    expect(dayOffset(at(-1, 23, 59), NOW)).toBe(-1);
    expect(dayOffset(at(RELATIVE_DAYS + 3), NOW)).toBe(RELATIVE_DAYS + 3);
  });

  it('reads an unreadable stamp as neither today nor a date', () => {
    expect(dayOffset('not a date', NOW)).toBeNull();
    expect(dayOffset('', NOW)).toBeNull();
    expect(whenLabel('not a date', NOW)).toBe('unknown');
  });
});

describe('a call reads as its distance from today', () => {
  it('spells out the three days that need no number', () => {
    expect(whenLabel(at(0), NOW)).toBe(`today, ${clock(at(0))}`);
    expect(whenLabel(at(1, 9), NOW)).toBe(`tomorrow, ${clock(at(1, 9))}`);
    expect(whenLabel(at(-1), NOW)).toBe(`yesterday, ${clock(at(-1))}`);
  });

  it('counts the days inside the boundary, in both directions, boundary included', () => {
    expect(whenLabel(at(2, 11, 0), NOW)).toBe(`in 2 days, ${clock(at(2, 11, 0))}`);
    expect(whenLabel(at(-2, 11, 0), NOW)).toBe(`2 days ago, ${clock(at(-2, 11, 0))}`);
    expect(whenLabel(at(RELATIVE_DAYS, 13, 45), NOW)).toBe(
      `in ${RELATIVE_DAYS} days, ${clock(at(RELATIVE_DAYS, 13, 45))}`,
    );
    expect(whenLabel(at(-RELATIVE_DAYS), NOW)).toBe(
      `${RELATIVE_DAYS} days ago, ${clock(at(-RELATIVE_DAYS))}`,
    );
  });

  it('shows the date itself one day past the boundary, whichever way it points', () => {
    const ahead = at(RELATIVE_DAYS + 1, 1, 0);
    const behind = at(-RELATIVE_DAYS - 1, 1, 0);
    expect(whenLabel(ahead, NOW)).toBe(`${shortDate(ahead)}, ${clock(ahead)}`);
    expect(whenLabel(behind, NOW)).toBe(`${shortDate(behind)}, ${clock(behind)}`);
    expect(whenLabel(ahead, NOW)).not.toContain('days');
  });

  it('keeps a call that already started today as today', () => {
    const call = at(0, 8, 0);
    expect(whenLabel(call, new Date(2026, 8, 29, 15, 0, 0))).toBe(`today, ${clock(call)}`);
  });

  it('leaves the year off, because the far form is a day inside the current plan', () => {
    expect(whenLabel(new Date(2027, 0, 18, 11, 0, 0).toISOString(), NOW)).not.toContain('2027');
  });
});

describe('the face line answers "what is next, and what did I forget"', () => {
  const interviewing = { stage: 'interviewing' as const };

  it('says nothing about a card that never reached Interviewing', () => {
    expect(faceInterview(card(), NOW)).toBeNull();
  });

  it('says nothing on a refused card, even one with a call still booked', () => {
    const refused = card({
      ...interviewing,
      archived: true,
      archivedAt: at(-2, 12, 0),
      interviews: [interview({ scheduledAt: at(1) })],
    });
    expect(faceInterview(refused, NOW)).toBeNull();
  });

  it('says the section is empty when the card reached Interviewing without a call', () => {
    expect(faceInterview(card(interviewing), NOW)).toEqual({
      label: 'no interview scheduled',
      tone: 'none',
      at: null,
      resultsToWrite: 0,
    });
  });

  it('reads the soonest call beside the results still owed', () => {
    const face = faceInterview(
      card({
        ...interviewing,
        interviews: [
          interview({ id: 1, scheduledAt: at(-2), result: null }),
          interview({ id: 2, scheduledAt: at(1, 9) }),
          interview({ id: 3, scheduledAt: at(4) }),
        ],
      }),
      NOW,
    );
    expect(face?.label).toBe(`tomorrow, ${clock(at(1, 9))}`);
    expect(face?.tone).toBe('next');
    expect(face?.at).toBe(at(1, 9));
    expect(face?.resultsToWrite).toBe(1);
  });

  it('does not call a call earlier today an unwritten result', () => {
    const face = faceInterview(
      card({
        ...interviewing,
        interviews: [interview({ scheduledAt: at(0, 8, 0), result: null })],
      }),
      new Date(2026, 8, 29, 15, 0, 0),
    );
    expect(face?.label).toBe(`today, ${clock(at(0, 8, 0))}`);
    expect(face?.resultsToWrite).toBe(0);
  });

  it('falls back to the last call once nothing is upcoming', () => {
    const face = faceInterview(
      card({
        ...interviewing,
        interviews: [
          interview({ id: 1, scheduledAt: at(-6), result: 'went well' }),
          interview({ id: 2, scheduledAt: at(-2, 11, 0), result: 'no offer' }),
        ],
      }),
      NOW,
    );
    expect(face?.label).toBe(whenLabel(at(-2, 11, 0), NOW));
    expect(face?.tone).toBe('last');
    expect(face?.at).toBe(at(-2, 11, 0));
    expect(face?.resultsToWrite).toBe(0);
  });

  it('adds next or last only where the date cannot say which way it points', () => {
    const ahead = at(RELATIVE_DAYS + 2, 1, 0);
    const behind = at(-RELATIVE_DAYS - 2, 1, 0);
    const faceOf = (scheduledAt: string) =>
      faceInterview(card({ ...interviewing, interviews: [interview({ scheduledAt })] }), NOW);

    expect(faceOf(ahead)?.label).toBe(`next ${whenLabel(ahead, NOW)}`);
    expect(faceOf(behind)?.label).toBe(`last ${whenLabel(behind, NOW)}`);
  });

  it('counts every past call still missing a result', () => {
    const face = faceInterview(
      card({
        ...interviewing,
        interviews: [
          interview({ id: 1, scheduledAt: at(-3), result: null }),
          interview({ id: 2, scheduledAt: at(-2), result: null }),
          interview({ id: 3, scheduledAt: at(2) }),
        ],
      }),
      NOW,
    );
    expect(face?.tone).toBe('next');
    expect(face?.resultsToWrite).toBe(2);
  });

  it('keeps the line a card earned by moving on', () => {
    const face = faceInterview(
      card({ stage: 'offer', interviews: [interview({ scheduledAt: at(2) })] }),
      NOW,
    );
    expect(face?.tone).toBe('next');
  });

  it('follows the rows, so a card whose rows are gone stops advertising a call', () => {
    expect(faceInterview(card({ stage: 'applied', interviews: [] }), NOW)).toBeNull();
    const rowsOnly = faceInterview(
      card({ stage: 'applied', interviews: [interview({ scheduledAt: at(1) })] }),
      NOW,
    );
    expect(rowsOnly?.tone).toBe('next');
  });

  it('reports unreadable stamps instead of inventing a date', () => {
    expect(
      faceInterview(card({ ...interviewing, interviews: [interview({ scheduledAt: 'nope' })] }), NOW),
    ).toEqual({
      label: 'interview date unreadable',
      tone: 'none',
      at: null,
      resultsToWrite: 0,
    });
    const two = faceInterview(
      card({
        ...interviewing,
        interviews: [interview({ id: 1, scheduledAt: '' }), interview({ id: 2, scheduledAt: 'x' })],
      }),
      NOW,
    );
    expect(two?.label).toBe('2 interview dates unreadable');
  });
});

describe('picking the calls the line is built from', () => {
  it('takes the soonest upcoming call, not the oldest row', () => {
    expect(
      nextCall(
        [
          interview({ id: 1, scheduledAt: at(-3) }),
          interview({ id: 2, scheduledAt: at(5) }),
          interview({ id: 3, scheduledAt: at(1) }),
        ],
        NOW,
      )?.id,
    ).toBe(3);
  });

  it('takes the most recent past call, and none from the future', () => {
    expect(
      lastCall(
        [
          interview({ id: 1, scheduledAt: at(-3) }),
          interview({ id: 2, scheduledAt: at(-1) }),
          interview({ id: 3, scheduledAt: at(4) }),
        ],
        NOW,
      )?.id,
    ).toBe(2);
    expect(lastCall([interview({ id: 9, scheduledAt: at(1) })], NOW)).toBeNull();
  });

  it('owes a result only for a day that is over, oldest first', () => {
    const interviews = [
      interview({ id: 1, scheduledAt: at(-4), result: 'went well' }),
      interview({ id: 2, scheduledAt: at(-2), result: null }),
      interview({ id: 3, scheduledAt: at(-1), result: null }),
      interview({ id: 4, scheduledAt: at(0, 8, 0), result: null }),
      interview({ id: 5, scheduledAt: at(2), result: null }),
    ];
    expect(unrecordedResults(interviews, new Date(2026, 8, 29, 15, 0, 0)).map((row) => row.id)).toEqual([
      2, 3,
    ]);
  });
});
