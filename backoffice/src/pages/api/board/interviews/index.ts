import type { APIRoute } from 'astro';
import { insertInterview } from '../../../../lib/db';
import { errorMessage, json } from '../../../../lib/http';
import { parseInterviewCreate } from '../../../../lib/interviews';

export const prerender = false;

/**
 * POST /api/board/interviews - add one interview to a card (the section's `➕ Add`).
 *
 * Mirrors the DB's own guard: `scheduled_at` is required, the type is one of the four the
 * section offers (a CHECK), and `result` is optional free text. **No history row is written** -
 * the interview list is the interview history (invariant 26) - and the card's column is not
 * touched, so this cannot be a back door into a move.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseInterviewCreate(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const outcome = await insertInterview(parsed.value.jobId, parsed.value.interview);
    if (!outcome.ok) {
      return json({ ok: false, error: `no vacancy with job_id ${parsed.value.jobId}` }, 404);
    }
    return json({ ok: true, card: outcome.card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
