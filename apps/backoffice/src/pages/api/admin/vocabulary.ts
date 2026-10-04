import type { APIRoute } from 'astro';
import { summarizeVocabulary } from '../../../lib/admin';
import { fetchActionVocabulary } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';
import { ACTOR_HINT, STAGES, TAILORING_STATES } from '../../../lib/stages';
import { ACTORS } from '../../../lib/board';

export const prerender = false;

/**
 * GET /api/admin/vocabulary - everything the admin page renders, in one read.
 *
 * Only **Actions** are data (`board_actions`). The other three vocabularies are fixed in
 * code and shown read-only, from the very constants that define them: the Actor list is a
 * DB CHECK, the columns are the board's shape (`isStageId`), and the tailoring sub-states
 * are *derived* from the worker's statuses (`tailoringFromStatus`) - none of them can be
 * "edited" without changing behaviour.
 *
 * Admin-only: the middleware gates `/api/admin/*` on the signed `is_admin` claim, and the
 * route re-checks it so the rule survives a change to that path list.
 */
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.session?.admin) return json({ ok: false, error: 'administrator only' }, 403);

  try {
    const actions = await fetchActionVocabulary();
    return json({
      ok: true,
      actions,
      summary: summarizeVocabulary(actions),
      actors: ACTORS.map((value) => ({ value, hint: ACTOR_HINT[value] })),
      stages: STAGES.map((stage) => ({ id: stage.id, label: stage.label, hint: stage.hint })),
      subStates: TAILORING_STATES.map((state) => ({ id: state.id, label: state.label })),
    });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
