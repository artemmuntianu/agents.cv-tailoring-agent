import { describe, expect, it } from 'vitest';
import { MAX_ANSWER_CHARS, MAX_ANSWERS, MAX_VALUE_CHARS, sanitizeCandidate } from './candidateFacts';
import {
  answerIssues,
  answerSummary,
  answersOf,
  factLabel,
  factLines,
  savePayload,
} from './profile';
import type { CandidateProfile } from './candidateFacts';

const PROFILE: CandidateProfile = {
  facts: { full_name: 'Artem Muntianu', location: 'Portugal' },
  standing_answers: { 'Years of React': 'More than 4 years.' },
};

describe('reading the row into an editor', () => {
  it('hands the editor a copy of the answer set, never the payload itself', () => {
    const answers = answersOf(PROFILE);
    expect(answers).toEqual(PROFILE.standing_answers);
    answers['Years of React'] = 'edited';
    expect(PROFILE.standing_answers['Years of React']).toBe('More than 4 years.');
    expect(answersOf(null)).toEqual({});
  });

  it('labels a fact for reading, in the prompt order and never as a raw key', () => {
    expect(factLabel('salary_expectation')).toBe('Salary expectation');
    expect(factLines(PROFILE)).toEqual(['Full name: Artem Muntianu', 'Location: Portugal']);
    expect(factLines(null)).toEqual([]);
  });

  it('counts the answers and finds the longest one', () => {
    expect(answerSummary({ a: 'one', b: 'three' })).toEqual({
      count: 2,
      cap: MAX_ANSWER_CHARS,
      longest: 5,
      longestQuestion: 'b',
    });
    expect(answerSummary(null).count).toBe(0);
  });
});

describe('the problems that stop a save', () => {
  it('accepts a document the prompts can take as it stands', () => {
    expect(answerIssues(PROFILE.standing_answers)).toEqual([]);
  });

  it('reports an answer past the cap instead of letting the server cut it', () => {
    const issues = answerIssues({ Q: 'x'.repeat(MAX_ANSWER_CHARS + 1) });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`the cap is ${MAX_ANSWER_CHARS}`);
  });

  it('reports an empty answer, a nameless question and a question past the cap', () => {
    const issues = answerIssues({
      '  ': 'An answer with no question',
      '': 'also nameless',
      'A question': '   ',
      [`q`.repeat(MAX_VALUE_CHARS + 1)]: 'An answer',
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      'a question needs wording - it is what the prompt shows',
      'a question needs wording - it is what the prompt shows',
      'an answer is text; an empty one is dropped on save - remove the question instead',
      `the question is ${MAX_VALUE_CHARS + 1} characters, the cap is ${MAX_VALUE_CHARS}`,
    ]);
  });

  it('reports the answers past MAX_ANSWERS as dropped', () => {
    const answers = Object.fromEntries(
      Array.from({ length: MAX_ANSWERS + 1 }, (_, index) => [`Q${index}`, 'A']),
    );
    const issues = answerIssues(answers);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`only the first ${MAX_ANSWERS} answers are kept`);
  });

  it('refuses anything that is not an object of pairs', () => {
    expect(answerIssues(['a'])[0].path).toBe('standing_answers');
    expect(answerIssues(null)[0].path).toBe('standing_answers');
  });
});

describe('the save payload', () => {
  it('sends the whole set, so a removed or reworded question really leaves the row', () => {
    const payload = savePayload(PROFILE, { 'A new question': 'An answer.' });
    expect(payload).toEqual({
      full_name: 'Artem Muntianu',
      location: 'Portugal',
      standing_answers: { 'A new question': 'An answer.' },
    });
    expect(payload.standing_answers).not.toHaveProperty('Years of React');
  });

  it('sends an empty object when the operator cleared the set - the documented way to empty it', () => {
    expect(savePayload(PROFILE, {}).standing_answers).toEqual({});
  });

  it('keeps an answer that is text and drops a nested value the prompt could not read', () => {
    const payload = savePayload(PROFILE, { Q: { nested: true }, K: 7 });
    expect(payload.standing_answers).toEqual({ K: '7' });
  });

  it('never writes a fact the prompts do not know, and keeps the ones they do', () => {
    const stored = sanitizeCandidate({ location: 'Portugal', unknown_fact: 'gone' });
    expect(savePayload(stored, {})).toEqual({
      location: 'Portugal',
      standing_answers: {},
    });
  });
});
