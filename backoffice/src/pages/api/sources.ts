import type { APIRoute } from 'astro';
import { sanitizeCandidate } from '../../lib/candidate';
import { applicationProfile } from '../../lib/db';
import { errorMessage, json } from '../../lib/http';
import { readCvModel, readFileSource, readModelState, sourcePaths } from '../../lib/sources';

export const prerender = false;

/**
 * GET /api/sources - the inputs a generated CV or cover letter is built from.
 *
 * `/processes` answers "did the jobs run"; this answers "what did the worker actually read": the
 * master CV model, the master document, the operator's candidate facts and the model rotation
 * state. Everything here is read-only, and a source this machine does not have is reported absent
 * with its path (never invented, never silently empty) - see `lib/sources.ts`.
 */
export const GET: APIRoute = async ({ locals }) => {
  const session = locals.session;
  if (!session) return json({ ok: false, error: 'authentication required' }, 401);

  const paths = sourcePaths();
  let profile = null;
  let factsUpdatedAt: string | null = null;
  try {
    const row = await applicationProfile(session.sub);
    if (row) {
      // The sanitized view is what the prompts are built from: the caps are applied here exactly
      // as `utils/candidate.py` applies them on the worker side.
      profile = sanitizeCandidate(row.facts);
      factsUpdatedAt = row.updatedAt ? new Date(row.updatedAt).toISOString() : null;
    }
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }

  return json({
    ok: true,
    sources: {
      cvModel: readCvModel(paths.cvData),
      masterCv: readFileSource('Master CV document (input/cv.docx)', paths.masterCv),
      modelState: readModelState(paths.modelState),
      facts: { present: Boolean(profile), updatedAt: factsUpdatedAt, profile },
    },
  });
};
