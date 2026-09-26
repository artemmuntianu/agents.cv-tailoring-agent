import { describe, expect, it } from 'vitest';
import { MAX_SUGGESTIONS, normalizeAction, rankActions, withNewAction } from './actions';
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

  it('does not suggest a value retired from the catalogue, but can be asked to', () => {
    const retired: BoardAction = {
      value: 'Old wording',
      kind: 'archive',
      uses: 99,
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      catalogued: false,
    };
    const live = action('Salary mismatch', 'archive', 1);

    expect(rankActions([retired, live], { kind: 'archive' }).map((item) => item.value)).toEqual([
      'Salary mismatch',
    ]);
    expect(
      rankActions([retired, live], { kind: 'archive', includeRetired: true }).map(
        (item) => item.value,
      ),
    ).toEqual(['Old wording', 'Salary mismatch']);
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
      catalogued: true,
    });
    expect(added).toHaveLength(2);

    const bumped = withNewAction(existing, 'Salary mismatch', 'archive', new Date('2026-09-26T10:00:00Z'));
    expect(bumped).toHaveLength(1);
    expect(bumped[0].uses).toBe(4);
    // An empty value changes nothing.
    expect(withNewAction(existing, '   ', 'archive')).toEqual(existing);
  });
});
