import { describe, expect, it } from 'vitest';
import {
  MAX_SUGGESTIONS,
  defaultArchiveAction,
  defaultMoveAction,
  normalizeAction,
  rankActions,
  withNewAction,
} from './actions';
import { STAGES } from './stages';
import type { BoardAction } from './types';

const action = (
  value: string,
  kind: BoardAction['kind'] = 'archive',
  uses = 0,
  lastUsedAt = '2026-09-01T00:00:00.000Z',
): BoardAction => ({ value, kind, uses, lastUsedAt });

describe('the Action combobox suggests the persisted vocabulary', () => {
  it('puts the dialog\'s own kind first, then the most used', () => {
    const actions = [
      action('Applied via portal', 'move', 9),
      action('Salary mismatch', 'archive', 3),
      action('No response', 'archive', 7),
      action('Referral', 'move', 1),
    ];

    expect(rankActions(actions, { kind: 'archive' }).map((item) => item.value)).toEqual([
      'No response',
      'Salary mismatch',
      'Applied via portal',
      'Referral',
    ]);
    // Nothing is hidden from the other dialog - it is only ranked lower.
    expect(rankActions(actions, { kind: 'move' }).map((item) => item.value)).toEqual([
      'Applied via portal',
      'Referral',
      'No response',
      'Salary mismatch',
    ]);
  });

  it('filters on what has been typed, case-insensitively', () => {
    const actions = [action('Salary mismatch'), action('No response'), action('Rejected by company')];
    expect(rankActions(actions, { kind: 'archive', query: 'sal' }).map((a) => a.value)).toEqual([
      'Salary mismatch',
    ]);
    expect(rankActions(actions, { kind: 'archive', query: 'REJECT' }).map((a) => a.value)).toEqual([
      'Rejected by company',
    ]);
    expect(rankActions(actions, { kind: 'archive', query: 'zzz' })).toHaveLength(0);
  });

  it('breaks ties by recency, then alphabetically, and honours a limit', () => {
    const actions = [
      action('Beta', 'archive', 2, '2026-09-01T00:00:00.000Z'),
      action('Alpha', 'archive', 2, '2026-09-01T00:00:00.000Z'),
      action('Gamma', 'archive', 2, '2026-09-20T00:00:00.000Z'),
    ];
    expect(rankActions(actions, { kind: 'archive' }).map((a) => a.value)).toEqual([
      'Gamma',
      'Alpha',
      'Beta',
    ]);
    expect(rankActions(actions, { kind: 'archive', limit: 2 })).toHaveLength(2);
    expect(MAX_SUGGESTIONS).toBeGreaterThanOrEqual(20);
  });
});

describe('what gets stored vs what gets suggested', () => {
  it('normalises the typed value into a catalogue key', () => {
    expect(normalizeAction('  Salary   mismatch \n ')).toBe('Salary mismatch');
    expect(normalizeAction('x'.repeat(600))).toHaveLength(500);
    expect(normalizeAction('   ')).toBe('');
  });

  it('adds a brand-new action optimistically and bumps a known one', () => {
    const existing = [action('Salary mismatch', 'archive', 3)];
    const added = withNewAction(existing, 'Asked for a portfolio', 'archive', new Date('2026-09-26T10:00:00Z'));
    expect(added[0]).toEqual({
      value: 'Asked for a portfolio',
      kind: 'archive',
      uses: 1,
      lastUsedAt: '2026-09-26T10:00:00.000Z',
    });
    expect(added).toHaveLength(2);

    const bumped = withNewAction(existing, 'Salary mismatch', 'archive', new Date('2026-09-26T10:00:00Z'));
    expect(bumped).toHaveLength(1);
    expect(bumped[0].uses).toBe(4);
    // An empty value changes nothing.
    expect(withNewAction(existing, '   ', 'archive')).toEqual(existing);
  });
});

describe('the wording each dialog starts with', () => {
  it("offers the destination column's own wording for a move", () => {
    expect(defaultMoveAction('prepare')).toBe('To Prepare');
    expect(defaultMoveAction('applied')).toBe('To Applied');

    // Every column has one: the pattern is `To <column>`, and a renamed column has to be
    // renamed here too - which is the point, the default and the column cannot drift apart.
    expect(STAGES.map((stage) => defaultMoveAction(stage.id))).toEqual(
      STAGES.map((stage) => `To ${stage.label}`),
    );
  });

  it('offers "Not Applicable" only for a card still in Scraped', () => {
    expect(defaultArchiveAction('scraped')).toBe('Not Applicable');
    // A refusal from any other column is a judgement call, so nothing is prefilled.
    expect(STAGES.map((stage) => defaultArchiveAction(stage.id))).toEqual(
      STAGES.map((stage) => (stage.id === 'scraped' ? 'Not Applicable' : '')),
    );
  });
});
