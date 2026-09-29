import { createHash } from 'node:crypto';
import { applicationProfile, saveApplicationProfile } from './db';

/**
 * The candidate facts every prompt is grounded in - the gateway's half of `utils/candidate.py`.
 *
 * `cv_data.json` is the CV's *content* (summary, skills, experience) and carries **no contacts at
 * all**, so the facts a form asks for (name, email, phone, location, salary expectation,
 * availability, work rights, English level, standing answers) live in their own document: one
 * `application_profile` row per operator. That is a database row rather than a file because the
 * board edits it on the host while the workers read it in the cluster - two different filesystems,
 * one shared Postgres.
 *
 * The CV tailoring prompt, the cover letter and the form prompt all read this block, so it is the
 * one place a fact about the candidate is maintained.
 *
 * The payload is sanitised against the known keys, because the document ends up in a Gemini prompt
 * and "nothing I can see" has to describe it truthfully.
 */

/** The known facts, in the order the prompt lists them (mirror of `utils/candidate.py::FACTS`). */
export const CANDIDATE_FACTS = [
  'full_name',
  'email',
  'phone',
  'location',
  'linkedin',
  'github',
  'portfolio',
  'english_level',
  'salary_expectation',
  'availability',
  'work_rights',
] as const;

export type CandidateFact = (typeof CANDIDATE_FACTS)[number];

export interface CandidateProfile {
  facts: Partial<Record<CandidateFact, string>>;
  standing_answers: Record<string, string>;
}

export const MAX_VALUE_CHARS = 600;
/** A *fact* is a form-field value (short); a standing answer is prose, so it caps higher. */
export const MAX_ANSWER_CHARS = 3000;
export const MAX_ANSWERS = 40;

/**
 * Keep the known keys, cap the lengths, drop everything else.
 *
 * Returning a *small* object rather than the caller's is the point: an unknown key would silently
 * vanish from the prompt anyway, and an unbounded one would push the form out of the window.
 */
export function sanitizeCandidate(raw: unknown): CandidateProfile {
  const profile: CandidateProfile = { facts: {}, standing_answers: {} };
  if (typeof raw !== 'object' || raw === null) return profile;
  const source = raw as Record<string, unknown>;
  // Accept either the flat shape the profile editor uses or a nested `facts` object.
  const factsSource =
    typeof source.facts === 'object' && source.facts !== null
      ? (source.facts as Record<string, unknown>)
      : source;

  for (const fact of CANDIDATE_FACTS) {
    const value = factsSource[fact];
    const text =
      typeof value === 'string' || typeof value === 'number'
        ? String(value).trim().slice(0, MAX_VALUE_CHARS)
        : '';
    if (text) profile.facts[fact] = text;
  }

  const answers = source.standing_answers;
  if (typeof answers === 'object' && answers !== null && !Array.isArray(answers)) {
    for (const [question, answer] of Object.entries(answers as Record<string, unknown>).slice(
      0,
      MAX_ANSWERS,
    )) {
      const key = String(question).trim().slice(0, MAX_VALUE_CHARS);
      const text =
        typeof answer === 'string' || typeof answer === 'number'
          ? String(answer).trim().slice(0, MAX_ANSWER_CHARS)
          : '';
      if (key && text) profile.standing_answers[key] = text;
    }
  }
  return profile;
}

/**
 * The standing answers to store after a save.
 *
 * `standing_answers` is the one merged field: the popup's editor only shows the facts, so an
 * *absent* key means "keep what is already stored" - a click on Save facts must never wipe the
 * question/answer set - while an explicit `{}` clears it. The facts themselves stay
 * replace-wholesale, which is what empty inputs in the editor mean.
 */
export function mergeStandingAnswers(stored: unknown, incoming: unknown): Record<string, string> {
  const replace =
    typeof incoming === 'object' && incoming !== null && !Array.isArray(incoming);
  return sanitizeCandidate({ facts: {}, standing_answers: replace ? incoming : stored })
    .standing_answers;
}

/** One operator's stored facts, or an empty document when nothing has been saved yet. */
export async function readCandidate(userId: string): Promise<CandidateProfile> {
  const row = await applicationProfile(userId).catch(() => null);
  return sanitizeCandidate(row ? row.facts : null);
}

export async function writeCandidate(userId: string, raw: unknown): Promise<CandidateProfile> {
  const profile = sanitizeCandidate(raw);
  const incoming =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).standing_answers
      : undefined;
  // The stored row is read first because `standing_answers` merges with it. Deliberately not
  // `readCandidate()`: that one swallows a DB error, and a failed read must surface as a failed
  // save (the route answers 503) instead of clearing the answers.
  const row = await applicationProfile(userId);
  const stored = sanitizeCandidate(row ? row.facts : null);
  const answers = mergeStandingAnswers(stored.standing_answers, incoming);

  const document: Record<string, unknown> = { ...profile.facts };
  if (Object.keys(answers).length > 0) {
    document.standing_answers = answers;
  }
  await saveApplicationProfile(userId, document);
  return { ...profile, standing_answers: answers };
}

/** The facts' version: the other half of the form hash, so editing them invalidates a draft. */
export async function candidateVersion(userId: string): Promise<string> {
  const profile = await readCandidate(userId);
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0, 32);
}
