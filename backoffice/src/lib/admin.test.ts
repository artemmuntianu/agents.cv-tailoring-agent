import { describe, expect, it } from 'vitest';
import {
  VOCABULARY_KINDS,
  isAdminPath,
  isVocabularyKind,
  parseActionInput,
  parseActionValue,
  parseRenameInput,
  sortVocabulary,
  summarizeVocabulary,
} from './admin';
import type { BoardAction } from './types';

const action = (
  value: string,
  kind: BoardAction['kind'] = 'archive',
  uses = 0,
  lastUsedAt = '2026-09-01T00:00:00.000Z',
  catalogued = true,
): BoardAction => ({ value, kind, uses, lastUsedAt, catalogued });

describe('who may see the vocabulary admin surface', () => {
  it('matches the page and its API, and nothing else', () => {
    for (const path of ['/admin', '/admin/', '/api/admin/vocabulary', '/api/admin/actions']) {
      expect(isAdminPath(path), path).toBe(true);
    }
    for (const path of ['/', '/api/board', '/api/board/actions', '/administrator', '/adminx']) {
      expect(isAdminPath(path), path).toBe(false);
    }
  });
});

describe('the add/rename/remove contract', () => {
  it('accepts a new entry and normalises its wording', () => {
    expect(parseActionInput({ value: '  Salary   mismatch \n', kind: 'archive' })).toEqual({
      ok: true,
      value: { value: 'Salary mismatch', kind: 'archive' },
    });
    expect(parseActionInput({ value: 'Referral', kind: 'move' }).ok).toBe(true);
  });

  it('rejects an empty value, a bad kind and a non-object body', () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /body must be a JSON object/],
      [[], /body must be a JSON object/],
      [{ value: '   ', kind: 'archive' }, /value is required/],
      [{ kind: 'archive' }, /value is required/],
      [{ value: 'Nope', kind: 'sideways' }, /kind must be/],
      [{ value: 'Nope' }, /kind must be/],
    ];
    for (const [body, pattern] of cases) {
      const parsed = parseActionInput(body);
      expect(parsed.ok, JSON.stringify(body)).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(pattern);
    }
    expect(VOCABULARY_KINDS.map((kind) => kind.id)).toEqual(['archive', 'move']);
    expect(isVocabularyKind('archive')).toBe(true);
    expect(isVocabularyKind('Archive')).toBe(false);
  });

  it('rewords, but refuses a no-op or an empty target', () => {
    expect(parseRenameInput({ from: 'No  response', to: 'No reply' })).toEqual({
      ok: true,
      value: { from: 'No response', to: 'No reply' },
    });
    expect(parseRenameInput({ from: 'No response', to: 'no RESPONSE' })).toEqual({
      ok: false,
      error: 'the new wording is the same as the current one',
    });
    expect(parseRenameInput({ from: 'No response', to: '  ' }).ok).toBe(false);
    expect(parseRenameInput({ to: 'No reply' }).ok).toBe(false);
  });

  it('reads the value to remove from the query string', () => {
    expect(parseActionValue('Salary mismatch')).toEqual({ ok: true, value: 'Salary mismatch' });
    expect(parseActionValue('')).toEqual({ ok: false, error: 'value is required' });
    expect(parseActionValue(null).ok).toBe(false);
  });
});

describe('the table (sorting and the summary)', () => {
  it('keeps catalogue entries above retired ones, most used first', () => {
    const sorted = sortVocabulary([
      action('Beta', 'archive', 2),
      action('Alpha', 'archive', 2),
      action('Gamma', 'archive', 5),
      action('Old wording', 'move', 99, '2026-01-01T00:00:00.000Z', false),
    ]);
    expect(sorted.map((item) => item.value)).toEqual(['Gamma', 'Alpha', 'Beta', 'Old wording']);
  });

  it('counts live entries per kind and the retired remainder', () => {
    const summary = summarizeVocabulary([
      action('Salary mismatch', 'archive', 3),
      action('No response', 'archive', 1),
      action('Applied via portal', 'move', 2),
      action('Old wording', 'move', 7, '2026-01-01T00:00:00.000Z', false),
    ]);
    expect(summary).toEqual({ total: 3, refusals: 2, progress: 1, retired: 1 });
  });
});
