import type { APIRoute } from 'astro';
import { RESTORE_ACTION, parseRestoreRequest } from '../../../lib/board';
import { restoreCard } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';

export const prerender = false;

/**
 * POST /api/board/restore - undo an archive.
 *
 * One click in the UI (there is nothing to ask), but it is still a *recorded* change:
 * the route writes `RESTORE_ACTION` as the history row's reason, with the candidate as
 * the actor - the board has no way to make a silent change. The Action catalogue is
 * deliberately not touched: restores are not a reason anybody types.
 *
 * 404 unknown job id, 409 not archived.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseRestoreRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const outcome = await restoreCard(parsed.value.jobId, {
      actor: 'Candidate',
      action: RESTORE_ACTION,
    });
    if (!outcome.ok) {
      return outcome.reason === 'unknown'
        ? json({ ok: false, error: `no vacancy with job_id ${parsed.value.jobId}` }, 404)
        : json({ ok: false, error: 'that vacancy is not archived' }, 409);
    }
    return json({ ok: true, card: outcome.card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
