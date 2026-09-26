import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  dateWindow,
  filterCards,
  matchesAction,
  matchesQuery,
  summarize,
  type BoardFilters,
} from './filters';
import type { BoardCard } from './types';

// 2026-09-26 is a Saturday, so its ISO week is Mon 21st - Sun 27th. Local dates are
// used on purpose: the window arithmetic is calendar-based, not UTC-based.
const NOW = new Date(2026, 8, 26, 12, 0, 0);

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    jobId: 'job-1',
    externalId: '374001',
    title: 'Senior Data Engineer',
    company: 'InScale',
    sourceUrl: null,
    cvVersion: 'v1',
    status: 'completed',
    attempts: 1,
    revisionCount: null,
    durationMs: null,
    error: null,
    pdfUrl: null,
    docxPath: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: new Date(2026, 8, 26, 9, 0, 0).toISOString(),
    stage: 'applied',
    archivedAt: null,
    archivedActor: null,
    archivedReason: null,
    archived: false,
    history: [],
    ...overrides,
  };
}

function archived(overrides: Partial<BoardCard> = {}): BoardCard {
  return card({
    jobId: 'job-archived',
    stage: 'interviewing',
    archivedAt: new Date(2026, 8, 26, 10, 0, 0).toISOString(),
    archivedActor: 'Company',
    archivedReason: 'Salary mismatch',
    archived: true,
    ...overrides,
  });
}

function updated(daysAgo: number): string {
  return new Date(2026, 8, 26 - daysAgo, 9, 0, 0).toISOString();
}

function withFilters(overrides: Partial<BoardFilters> = {}): BoardFilters {
  return { ...DEFAULT_FILTERS, ...overrides };
}

describe('visibility (active vs archived)', () => {
  it('opens on the active pipeline only', () => {
    const cards = [card(), archived()];
    expect(filterCards(cards, DEFAULT_FILTERS, NOW).map((item) => item.jobId)).toEqual(['job-1']);
  });

  it('shows refused cards in their own column when the toggle is on', () => {
    const cards = [card(), archived()];
    const shown = filterCards(cards, withFilters({ showArchived: true }), NOW);
    expect(shown.map((item) => item.jobId)).toEqual(['job-1', 'job-archived']);
    expect(shown[1].stage).toBe('interviewing'); // in place, not a column of its own
  });

  it('can show archived only, and hides everything when both toggles are off', () => {
    const cards = [card(), archived()];
    expect(
      filterCards(cards, withFilters({ showActive: false, showArchived: true }), NOW).map(
        (item) => item.jobId,
      ),
    ).toEqual(['job-archived']);
    expect(
      filterCards(cards, withFilters({ showActive: false, showArchived: false }), NOW),
    ).toHaveLength(0);
  });
});

describe('search', () => {
  it('matches title, company, id and the refusal reason, case-insensitively', () => {
    const target = card({ title: 'Senior Platform Engineer', company: 'New Wave Devs' });
    expect(matchesQuery(target, 'platform')).toBe(true);
    expect(matchesQuery(target, 'NEW WAVE')).toBe(true);
    expect(matchesQuery(target, '374001')).toBe(true);
    expect(matchesQuery(target, '  ')).toBe(true);
    expect(matchesQuery(target, 'devops')).toBe(false);
    expect(matchesQuery(archived(), 'salary')).toBe(true);
  });
});


describe('date range (default: rolling 30 days)', () => {
  it('is the default and drops anything older than 30 days', () => {
    expect(DEFAULT_FILTERS.range).toBe('last30');
    const cards = [
      card({ jobId: 'fresh', updatedAt: updated(3) }),
      card({ jobId: 'old', updatedAt: updated(40) }),
    ];
    expect(filterCards(cards, DEFAULT_FILTERS, NOW).map((item) => item.jobId)).toEqual(['fresh']);
    expect(filterCards(cards, withFilters({ range: 'all' }), NOW)).toHaveLength(2);
  });

  it('resolves calendar windows against the local calendar', () => {
    expect(dateWindow(withFilters({ range: 'this_week' }), NOW)).toEqual({
      from: new Date(2026, 8, 21).getTime(),
      to: null,
    });
    expect(dateWindow(withFilters({ range: 'last_week' }), NOW)).toEqual({
      from: new Date(2026, 8, 14).getTime(),
      to: new Date(2026, 8, 21).getTime(),
    });
    expect(dateWindow(withFilters({ range: 'this_month' }), NOW)).toEqual({
      from: new Date(2026, 8, 1).getTime(),
      to: null,
    });
    expect(dateWindow(withFilters({ range: 'last_month' }), NOW)).toEqual({
      from: new Date(2026, 7, 1).getTime(),
      to: new Date(2026, 8, 1).getTime(),
    });
    expect(dateWindow(withFilters({ range: 'all' }), NOW)).toEqual({ from: null, to: null });
  });

  it('includes both ends of a custom range', () => {
    const cards = [
      card({ jobId: 'from', updatedAt: new Date(2026, 8, 10, 0, 0, 0).toISOString() }),
      card({ jobId: 'to', updatedAt: new Date(2026, 8, 12, 23, 0, 0).toISOString() }),
      card({ jobId: 'after', updatedAt: new Date(2026, 8, 13, 0, 30, 0).toISOString() }),
    ];
    const filters = withFilters({ range: 'custom', from: '2026-09-10', to: '2026-09-12' });
    expect(filterCards(cards, filters, NOW).map((item) => item.jobId)).toEqual(['from', 'to']);
    // A half-filled custom range is unbounded on the empty side, never "nothing".
    expect(filterCards(cards, withFilters({ range: 'custom', from: '2026-09-12' }), NOW)).toHaveLength(2);
  });

  it('keeps this week and last week apart', () => {
    const cards = [
      card({ jobId: 'this', updatedAt: new Date(2026, 8, 22, 9, 0, 0).toISOString() }),
      card({ jobId: 'last', updatedAt: new Date(2026, 8, 16, 9, 0, 0).toISOString() }),
    ];
    expect(
      filterCards(cards, withFilters({ range: 'this_week' }), NOW).map((item) => item.jobId),
    ).toEqual(['this']);
    expect(
      filterCards(cards, withFilters({ range: 'last_week' }), NOW).map((item) => item.jobId),
    ).toEqual(['last']);
  });
});

describe('stage and action filters', () => {
  it('keeps the selected columns, and every column when none is selected', () => {
    const cards = [card({ stage: 'applied' }), card({ jobId: 'b', stage: 'offer' })];
    expect(filterCards(cards, withFilters({ stages: ['offer'] }), NOW).map((c) => c.jobId)).toEqual(['b']);
    expect(filterCards(cards, withFilters({ stages: [] }), NOW)).toHaveLength(2);
    expect(filterCards(cards, withFilters({ stages: ['applied', 'offer'] }), NOW)).toHaveLength(2);
  });

  it('matches a card through any of its history entries', () => {
    const target = card({
      history: [
        {
          id: 1,
          at: '2026-09-20T10:00:00.000Z',
          actor: 'Candidate',
          action: 'Applied via portal',
          kind: 'move',
          from: 'created',
          to: 'applied',
        },
        {
          id: 2,
          at: '2026-09-21T10:00:00.000Z',
          actor: 'Company',
          action: 'Salary mismatch',
          kind: 'archive',
          from: 'active',
          to: 'archived',
        },
      ],
    });
    expect(matchesAction(target, [])).toBe(true);
    expect(matchesAction(target, ['Salary mismatch'])).toBe(true);
    expect(matchesAction(target, ['Referral'])).toBe(false);
    expect(
      filterCards(
        [target, card({ jobId: 'other' })],
        withFilters({ actions: ['Salary mismatch'] }),
        NOW,
      ).map((c) => c.jobId),
    ).toEqual(['job-1']);
  });
});

describe('the toolbar reports itself', () => {
  it('counts off-default groups for the badge', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount(withFilters({ query: 'x' }))).toBe(1);
    expect(
      activeFilterCount(
        withFilters({ query: 'x', range: 'all', stages: ['offer'], showArchived: true }),
      ),
    ).toBe(4);
  });

  it('spells out how much of the board is on screen', () => {
    expect(summarize(3, 12)).toBe('showing 3 of 12 cards');
    expect(summarize(1, 1)).toBe('showing 1 of 1 card');
  });
});
