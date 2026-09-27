import { describe, expect, it } from 'vitest';
import {
  EMPTY_INTERVIEW_DRAFT,
  INTERVIEW_TYPES,
  draftToRequest,
  formatInterviewAt,
  hasReachedInterviewing,
  nextInterview,
  parseInterviewCreate,
  parseInterviewRequest,
  sortInterviews,
  toDateTimeLocal,
} from './interviews';
import { STAGES } from './stages';
import type { BoardCard, Interview } from './types';

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
    hasDescription: true,
    history: [],
    details: {
      recruiter: null,
      salaryOffered: null,
      salaryDesired: null,
      communicationChannels: [],
    },
    interviews: [],
    ...overrides,
  };
}

function interview(overrides: Partial<Interview> = {}): Interview {
  return {
    id: 1,
    jobId: '374001-1',
    scheduledAt: '2026-09-30T14:30:00.000Z',
    type: 'Technical Interview',
    result: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

describe('the interview vocabulary', () => {
  it('is the four types the database CHECK accepts', () => {
    expect(INTERVIEW_TYPES).toEqual([
      'Initial Interview',
      'Technical Interview',
      'Management Interview',
      'Final Interview',
    ]);
  });

  it('parses a datetime-local value into an instant and normalises the result', () => {
    const parsed = parseInterviewRequest({
      scheduledAt: '2026-09-30T14:30',
      type: 'Initial Interview',
      result: '  went   well  ',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(new Date(parsed.value.scheduledAt).getTime()).toBe(
      new Date('2026-09-30T14:30').getTime(),
    );
    expect(parsed.value.result).toBe('went well');
    expect(parsed.value.type).toBe('Initial Interview');
  });

  it('rejects a missing date, an unknown type and an over-long result', () => {
    expect(parseInterviewRequest({ type: 'Initial Interview' }).ok).toBe(false);
    expect(parseInterviewRequest({ scheduledAt: 'not a date', type: 'Initial Interview' }).ok).toBe(
      false,
    );
    expect(parseInterviewRequest({ scheduledAt: '2026-09-30T14:30', type: 'Screening' }).ok).toBe(
      false,
    );
    expect(
      parseInterviewRequest({
        scheduledAt: '2026-09-30T14:30',
        type: 'Final Interview',
        result: 'x'.repeat(2001),
      }).ok,
    ).toBe(false);
    expect(parseInterviewRequest(null).ok).toBe(false);
  });

  it('clears the result when it is empty', () => {
    const parsed = parseInterviewRequest({
      scheduledAt: '2026-09-30T14:30',
      type: 'Final Interview',
      result: '   ',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.result).toBeNull();
  });

  it('requires a job id when an interview is created', () => {

    expect(
      parseInterviewCreate({ scheduledAt: '2026-09-30T14:30', type: 'Initial Interview' }).ok,
    ).toBe(false);

    const withJob = parseInterviewCreate({
      jobId: '374001-1',
      scheduledAt: '2026-09-30T14:30',
      type: 'Initial Interview',
    });
    expect(withJob.ok).toBe(true);
    if (withJob.ok) expect(withJob.value.jobId).toBe('374001-1');
  });
});

describe('hasReachedInterviewing (the section is shown, not a stored flag)', () => {
  it('is true while the card is in the column', () => {
    expect(hasReachedInterviewing(card({ stage: 'interviewing' }))).toBe(true);
  });

  it('stays true after the card moved on', () => {
    const moved = card({
      stage: 'offer',
      history: [
        {
          id: 1,
          at: '2026-09-25T11:00:00.000Z',
          actor: 'Candidate',
          action: 'Moved',
          kind: 'move',
          from: 'applied',
          to: 'interviewing',
        },
      ],
    });
    expect(hasReachedInterviewing(moved)).toBe(true);
  });

  it('is false for a card that never got there', () => {
    expect(hasReachedInterviewing(card({ stage: 'scraped' }))).toBe(false);
    // A refusal is not a move into the column.
    expect(
      hasReachedInterviewing(
        card({
          history: [
            {
              id: 2,
              at: '2026-09-25T11:00:00.000Z',
              actor: 'Candidate',
              action: 'Refused',
              kind: 'archive',
              from: 'active',
              to: 'archived',
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('does not depend on an interview row existing', () => {
    expect(hasReachedInterviewing(card({ stage: 'interviewing', interviews: [] }))).toBe(true);
  });

  it('covers every column of the board', () => {
    for (const stage of STAGES) {
      expect(hasReachedInterviewing(card({ stage: stage.id }))).toBe(stage.id === 'interviewing');
    }
  });
});

describe('the interview list', () => {
  it('reads as a timeline, not as a feed', () => {
    const later = interview({ id: 2, scheduledAt: '2026-10-05T09:00:00.000Z' });
    const earlier = interview({ id: 1, scheduledAt: '2026-09-30T14:30:00.000Z' });
    expect(sortInterviews([later, earlier]).map((item) => item.id)).toEqual([1, 2]);
  });

  it('breaks a tie by id, so two calls on one day keep their order', () => {
    expect(sortInterviews([interview({ id: 2 }), interview({ id: 1 })]).map((item) => item.id)).toEqual(
      [1, 2],
    );
  });

  it('finds the next interview that has not happened yet', () => {
    const past = interview({ id: 1, scheduledAt: '2026-09-01T10:00:00.000Z' });
    const soon = interview({ id: 2, scheduledAt: '2026-09-30T10:00:00.000Z' });
    const now = new Date('2026-09-27T09:00:00.000Z');
    expect(nextInterview([past, soon], now)?.id).toBe(2);
    expect(nextInterview([past], now)).toBeNull();
  });
});

describe('the drafts the dialogs collect', () => {
  it('starts on Initial Interview and schedules nothing', () => {
    expect(EMPTY_INTERVIEW_DRAFT).toEqual({ scheduledAt: '', type: 'Initial Interview' });
    expect(draftToRequest(EMPTY_INTERVIEW_DRAFT)).toBeNull();
  });

  it('turns a filled draft into the API contract', () => {
    const request = draftToRequest({ scheduledAt: '2026-09-30T14:30', type: 'Final Interview' });
    expect(request?.type).toBe('Final Interview');
    expect(request?.result).toBeNull();
    expect(request?.scheduledAt).toBe(new Date('2026-09-30T14:30').toISOString());
  });

  it('round-trips an instant through the datetime-local input', () => {
    const iso = '2026-09-30T14:30:00.000Z';
    const local = toDateTimeLocal(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // The local value means the same instant as the ISO one it came from.
    expect(new Date(local).getTime()).toBe(new Date(iso).getTime());
    expect(toDateTimeLocal(null)).toBe('');
  });

  it('formats a date for the section and survives nonsense', () => {
    expect(formatInterviewAt('2026-09-30T14:30:00.000Z')).not.toBe('');
    expect(formatInterviewAt('not a date')).toBe('not a date');
  });
});
