/**
 * The candidate-facts *document* rules: the vocabulary, the two caps and the sanitizer every writer
 * runs - the gateway's half of `apps/worker/utils/candidate.py`.
 *
 * It is its own module because two very different halves read it: `lib/candidate.ts` (the Postgres
 * row: read, merge, write) and the island that edits that row on `/sources` (`lib/profile.ts` +
 * `StandingAnswersEditor.tsx`). Anything reachable from the browser has to stay free of `pg` and
 * `node:crypto`, which is what `lib/db.ts` and `lib/candidate.ts` bring - so the pure half lives
 * here and the store imports *it*, never the other way round.
 *
 * The payload is sanitised against the known keys, because the document ends up in a Gemini prompt
 * and "nothing I can see" has to describe it truthfully.
 */

/** The known facts, in the order the prompt lists them (mirror of `apps/worker/utils/candidate.py::FACTS`). */
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
 * `standing_answers` is the one guarded field: a caller that does not send it (one whose form shows
 * the facts but not the question/answer set) means "keep what is already stored", so a save can never
 * wipe the recruiter answers - while a caller that *does* send the object replaces the set key for
 * key, which is what makes a removed question really leave the row (`lib/profile.ts` relies on it),
 * and an explicit `{}` clears them. The facts themselves stay replace-wholesale.
 */
export function mergeStandingAnswers(stored: unknown, incoming: unknown): Record<string, string> {
  const replace =
    typeof incoming === 'object' && incoming !== null && !Array.isArray(incoming);
  return sanitizeCandidate({ facts: {}, standing_answers: replace ? incoming : stored })
    .standing_answers;
}
