import {
  CANDIDATE_FACTS,
  MAX_ANSWER_CHARS,
  MAX_ANSWERS,
  MAX_VALUE_CHARS,
  sanitizeCandidate,
} from './candidateFacts';
import type { CandidateProfile } from './candidateFacts';

/**
 * The editable half of the `application_profile` row: what `/sources` does to a hand edit before it
 * becomes a `PUT /api/profile` body.
 *
 * The row is one JSON document read by all three prompts, so the surface that edits it must not be
 * able to store something the prompts would silently drop - `apps/worker/utils/candidate.py::sanitize`
 * is the judge and this module is the client-side mirror of its verdict. Two of its rules shape
 * everything here:
 *
 *  - **A save sends the whole answer set.** `candidateFacts.ts::mergeStandingAnswers` keeps the stored
 *    set only while the key is *absent*; sending the object replaces it key for key, which is what
 *    makes a removed or reworded question really leave the row. The flip side is that sending an empty
 *    object clears all of them, which is why the editor says so before it saves.
 *  - **A value the server would cut or drop is reported, never truncated quietly.** `answerIssues`
 *    gates the Save button: an answer past `MAX_ANSWER_CHARS`, a question past `MAX_VALUE_CHARS`, a
 *    41st answer or an empty answer is a thing to fix rather than a thing to lose.
 *
 * Pure and browser-safe on purpose (no `pg`, no `node:crypto`): the tree editor is an island
 * (`components/StandingAnswersEditor.tsx`) and only calls in here.
 */

/** Where a problem is, as the question itself - for the message list under the editor. */
export interface ProfileIssue {
  path: string;
  message: string;
}

/** `full_name` -> `Full name`: what a label reads. The key itself belongs to `candidateFacts.ts`. */
export function factLabel(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The facts as the page reads them out: one labelled line each, in the prompt's own order.
 *
 * This replaces the `JSON.stringify` of the whole row the page used to print - the long answers are
 * the tree editor's job, and a fact is a line, not a document.
 */
export function factLines(profile: CandidateProfile | null): string[] {
  if (!profile) return [];
  return CANDIDATE_FACTS.filter((fact) => profile.facts[fact]).map(
    (fact) => `${factLabel(fact)}: ${profile.facts[fact]}`,
  );
}

/** The answers as the editor's own document - a copy, so an edit cannot mutate the payload. */
export function answersOf(profile: CandidateProfile | null): Record<string, string> {
  return { ...(profile?.standing_answers ?? {}) };
}

export interface AnswerSummary {
  count: number;
  cap: number;
  /** The longest answer in characters, and the question it belongs to - the row's own gauge. */
  longest: number;
  longestQuestion: string | null;
}

/** The editor's header: how many answers, and how close the longest one is to the cap. */
export function answerSummary(answers: unknown): AnswerSummary {
  let longest = 0;
  let longestQuestion: string | null = null;
  for (const [question, answer] of answerEntries(answers)) {
    const length = String(answer ?? '').trim().length;
    if (length > longest) {
      longest = length;
      longestQuestion = question;
    }
  }
  return { count: answerEntries(answers).length, cap: MAX_ANSWER_CHARS, longest, longestQuestion };
}

/**
 * Every way the document in the editor would lose data on save - empty means "safe to PUT".
 *
 * Each message names the cap or the rule it broke, because the operator's only other signal would be
 * a prompt that quietly misses an answer.
 */
export function answerIssues(answers: unknown): ProfileIssue[] {
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
    return [
      {
        path: 'standing_answers',
        message:
          'the answers must be an object of question/answer pairs - an absent key keeps the stored set',
      },
    ];
  }
  const issues: ProfileIssue[] = [];
  answerEntries(answers).forEach(([question, answer], index) => {
    const trimmed = question.trim();
    const label = trimmed || '(an unnamed question)';
    if (index >= MAX_ANSWERS) {
      issues.push({
        path: label,
        message: `only the first ${MAX_ANSWERS} answers are kept - this one would be dropped`,
      });
      return;
    }
    if (!trimmed) {
      issues.push({ path: label, message: 'a question needs wording - it is what the prompt shows' });
    } else if (trimmed.length > MAX_VALUE_CHARS) {
      issues.push({
        path: `${label.slice(0, 60)}…`,
        message: `the question is ${trimmed.length} characters, the cap is ${MAX_VALUE_CHARS}`,
      });
    }
    const text =
      typeof answer === 'string' || typeof answer === 'number' ? String(answer).trim() : '';
    if (!text) {
      issues.push({
        path: label,
        message: 'an answer is text; an empty one is dropped on save - remove the question instead',
      });
    } else if (text.length > MAX_ANSWER_CHARS) {
      issues.push({
        path: label,
        message: `the answer is ${text.length} characters, the cap is ${MAX_ANSWER_CHARS}`,
      });
    }
  });
  return issues;
}

/**
 * The `PUT /api/profile` body: the stored facts plus the edited answer set, sent whole.
 *
 * `sanitizeCandidate` runs here too - not to hide a mistake (the Save button is gated on
 * `answerIssues`) but so the payload is exactly what the row will hold: an unknown fact key or a
 * nested value never reaches the column.
 */
export function savePayload(
  profile: CandidateProfile | null,
  answers: unknown,
): Record<string, unknown> {
  const clean = sanitizeCandidate({ facts: profile?.facts ?? {}, standing_answers: answers });
  return { ...clean.facts, standing_answers: clean.standing_answers };
}

function answerEntries(answers: unknown): Array<[string, unknown]> {
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return [];
  return Object.entries(answers as Record<string, unknown>);
}
