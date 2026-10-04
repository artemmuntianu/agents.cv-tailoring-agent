import type { APIRoute } from 'astro';
import { CANDIDATE_FACTS, candidateVersion, readCandidate, writeCandidate } from '../../lib/candidate';
import { errorMessage, json } from '../../lib/http';

export const prerender = false;

/**
 * GET /api/profile - the candidate facts an application form is filled from.
 *
 * One `application_profile` row per operator, read by every prompt through the **card's owner**
 * (`apps/worker/utils/candidate.py`): the model may use these facts and must never invent the others. No
 * extension editor writes them any more (removed 2026-10-03); `facts` lists the known keys, so a
 * client never has to hardcode them.
 */
export const GET: APIRoute = async ({ locals }) => {
  const session = locals.session;
  if (!session) return json({ ok: false, error: 'authentication required' }, 401);
  const profile = await readCandidate(session.sub);
  return json({
    ok: true,
    profile,
    facts: [...CANDIDATE_FACTS],
    version: await candidateVersion(session.sub),
  });
};

/**
 * PUT /api/profile - save the facts.
 *
 * The payload is sanitised against the known keys and the length caps before it is written
 * (`lib/candidate.ts`): unknown keys are dropped rather than stored, because the document ends up
 * in a Gemini prompt. An empty profile is a legitimate save (the operator may want to clear it); a
 * non-object body is not.
 *
 * `standing_answers` is merged rather than replaced: leaving the key out keeps the stored
 * question/answer set (a caller whose form shows only the facts must not wipe it). Send an explicit
 * `{}` to clear it.
 */
export const PUT: APIRoute = async ({ request, locals }) => {
  const session = locals.session;
  if (!session) return json({ ok: false, error: 'authentication required' }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json({ ok: false, error: 'body must be a JSON object' }, 400);
  }

  try {
    const profile = await writeCandidate(session.sub, body);
    return json({ ok: true, profile, version: await candidateVersion(session.sub) });
  } catch (error) {
    return json(
      { ok: false, error: `could not save the candidate facts: ${errorMessage(error)}` },
      503,
    );
  }
};
