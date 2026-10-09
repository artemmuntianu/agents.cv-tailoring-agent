import { createHash } from 'node:crypto';
import { applicationProfile, saveApplicationProfile } from './db';
import { mergeStandingAnswers, sanitizeCandidate } from './candidateFacts';
import type { CandidateProfile } from './candidateFacts';

/**
 * The candidate facts every prompt is grounded in - the gateway's half of `apps/worker/utils/candidate.py`.
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
 * and "nothing I can see" has to describe it truthfully. Those rules themselves live in
 * `lib/candidateFacts.ts` (importable from the browser); this module is the store around them.
 */

// The document rules themselves - the vocabulary, the two caps, `sanitizeCandidate` and the
// `standing_answers` guard - live in `lib/candidateFacts.ts`, so an island can share them without
// pulling `pg`/`node:crypto` into the browser bundle. These re-exports keep the callers that already
// import them from here (`api/profile.ts`, `api/sources.ts`, `candidate.test.ts`) untouched.
export {
  CANDIDATE_FACTS,
  MAX_ANSWER_CHARS,
  MAX_ANSWERS,
  MAX_VALUE_CHARS,
  mergeStandingAnswers,
  sanitizeCandidate,
} from './candidateFacts';
export type { CandidateFact, CandidateProfile } from './candidateFacts';

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
