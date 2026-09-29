import { describe, expect, it } from 'vitest';
import {
  MAX_ANSWER_CHARS,
  MAX_ANSWERS,
  MAX_VALUE_CHARS,
  mergeStandingAnswers,
  sanitizeCandidate,
} from './candidate';

describe('sanitizing the candidate facts', () => {
  it('keeps the known keys, drops the rest and trims the values', () => {
    expect(
      sanitizeCandidate({ location: '  Portugal  ', unknown: 'gone', salary_expectation: 5000 }),
    ).toEqual({
      facts: { location: 'Portugal', salary_expectation: '5000' },
      standing_answers: {},
    });
  });

  it('accepts both the flat document and the nested facts shape', () => {
    expect(sanitizeCandidate({ facts: { location: 'Portugal' } })).toEqual(
      sanitizeCandidate({ location: 'Portugal' }),
    );
  });

  it('caps a fact at the short limit and a standing answer at the long one', () => {
    const profile = sanitizeCandidate({
      location: 'y'.repeat(MAX_VALUE_CHARS + 50),
      standing_answers: { Q: 'x'.repeat(MAX_ANSWER_CHARS + 50) },
    });
    // A form field takes a short value; a project deep-dive does not fit in one - the mirror of
    // utils/candidate.py's two caps.
    expect(profile.facts.location).toHaveLength(MAX_VALUE_CHARS);
    expect(profile.standing_answers.Q).toHaveLength(MAX_ANSWER_CHARS);
    expect(MAX_ANSWER_CHARS).toBeGreaterThan(MAX_VALUE_CHARS);
  });

  it('keeps at most MAX_ANSWERS answers', () => {
    const answers = Object.fromEntries(
      Array.from({ length: MAX_ANSWERS + 5 }, (_, index) => [`Q${index}`, 'A']),
    );
    expect(
      Object.keys(sanitizeCandidate({ standing_answers: answers }).standing_answers),
    ).toHaveLength(MAX_ANSWERS);
  });
});

describe('merging the standing answers on save', () => {
  it('keeps what is stored when the payload leaves the key out', () => {
    const stored = { 'Notice period and availability to start': 'Ready to start ASAP.' };
    expect(mergeStandingAnswers(stored, undefined)).toEqual(stored);
    expect(mergeStandingAnswers(stored, null)).toEqual(stored);
  });

  it('replaces them when the payload carries its own set, and clears on an explicit {}', () => {
    const stored = { 'Old question': 'Old answer' };
    expect(mergeStandingAnswers(stored, { 'New question': 'New answer' })).toEqual({
      'New question': 'New answer',
    });
    expect(mergeStandingAnswers(stored, {})).toEqual({});
  });

  it('ignores a payload that is not a question/answer object', () => {
    const stored = { Q: 'A' };
    expect(mergeStandingAnswers(stored, ['not', 'an', 'object'])).toEqual(stored);
    expect(mergeStandingAnswers(stored, 'nope')).toEqual(stored);
  });
});
