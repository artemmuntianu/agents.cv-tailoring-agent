import type { APIRoute } from 'astro';
import { parseMoveRequest } from '../../../lib/board';
import { moveCard } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';

export const prerender = false;

/**
 * POST /api/board/move - the only way a card changes column. The body carries the
 * actor and the reason the operator typed, and both are stored in the history in
 * the same transaction as the stage change.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseMoveRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const card = await moveCard(parsed.value);
    if (!card) {
      return json({ ok: false, error: `no vacancy with job_id ${parsed.value.jobId}` }, 404);
    }
    return json({ ok: true, card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
