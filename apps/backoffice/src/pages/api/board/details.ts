import type { APIRoute } from 'astro';
import { updateDetails } from '../../../lib/db';
import { parseDetailsRequest } from '../../../lib/details';
import { errorMessage, json } from '../../../lib/http';

export const prerender = false;

/**
 * POST /api/board/details - save the card's own detail fields.
 *
 * The recruiter, the two salaries and the communication channels live on `resume_board` (the
 * board's table) and are replaced as a set: the form sends all four, `''`/null clears a field,
 * and the row's `updated_at` moves - editing a card's details *is* operator activity, which is
 * what the date window and the inactivity sweep read.
 *
 * No `resume_history` row: like the interviews, these are card attributes rather than a funnel
 * transition (invariant 28). 404 unknown job id; the card comes back re-read.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseDetailsRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const card = await updateDetails(parsed.value);
    if (!card) {
      return json({ ok: false, error: `no vacancy with job_id ${parsed.value.jobId}` }, 404);
    }
    return json({ ok: true, card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
