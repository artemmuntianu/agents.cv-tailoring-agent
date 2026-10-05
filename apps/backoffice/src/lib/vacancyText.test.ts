import { describe, expect, it } from 'vitest';
import { MAX_JOB_ID_LENGTH, describeText, parseJobQuery, textStats } from './vacancyText';

/**
 * The parsed-vacancy page's two rules: which `job_id`s a URL may name, and how much text a card carries.
 * Both are pure, so the route and the page can share them without a browser or a database.
 */

describe('the job_id a text page asks about', () => {
  it('accepts the ids the database accepts, trimmed', () => {
    expect(parseJobQuery('  dou-351812-1 ')).toEqual({ ok: true, value: 'dou-351812-1' });
    expect(parseJobQuery('dou:351812_v1')).toEqual({ ok: true, value: 'dou:351812_v1' });
    expect(parseJobQuery('851326-1761200000')).toEqual({ ok: true, value: '851326-1761200000' });
  });

  it('names the problem instead of passing a bad id to a query', () => {
    expect(parseJobQuery('')).toEqual({ ok: false, error: 'job_id is required' });
    expect(parseJobQuery(null).ok).toBe(false);
    expect(parseJobQuery(undefined).ok).toBe(false);
    // The shape guard's own floor and ceiling (`resumes_job_id_shape`).
    expect(parseJobQuery('ab').ok).toBe(false);
    expect(parseJobQuery('a'.repeat(MAX_JOB_ID_LENGTH + 1)).ok).toBe(false);
    // ...and an id that could never be one, rather than a string a query would have to be trusted with.
    expect(parseJobQuery("'; drop table resumes; --").ok).toBe(false);
  });
});

describe('how much text a card carries', () => {
  it('counts characters, non-blank lines and words', () => {
    expect(textStats('one two\n\nthree ')).toEqual({ chars: 15, lines: 2, words: 3 });
    expect(textStats('single')).toEqual({ chars: 6, lines: 1, words: 1 });
  });

  it('treats a row with no text as empty rather than as a crash', () => {
    // A row created before the column existed (2026-09-26) is the real case, not a hypothetical one.
    expect(textStats(null)).toEqual({ chars: 0, lines: 0, words: 0 });
    expect(textStats(undefined)).toEqual({ chars: 0, lines: 0, words: 0 });
    expect(textStats('')).toEqual({ chars: 0, lines: 0, words: 0 });
  });

  it('says how big the text is in words a page can show', () => {
    expect(describeText(null)).toBe('no parsed text on this row');
    expect(describeText('a\nb')).toBe('3 characters · 2 lines · 2 words');
  });
});
