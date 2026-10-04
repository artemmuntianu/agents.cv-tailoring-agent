import type { APIRoute } from 'astro';
import { deleteInterview, updateInterview } from '../../../../lib/db';
import { errorMessage, json } from '../../../../lib/http';
import { parseInterviewRequest } from '../../../../lib/interviews';

export const prerender = false;

/** The row id from the path, or null when it is not a positive integer. */
function interviewId(params: Record<string, string | undefined>): number | null {
  const raw = String(params.id ?? '').trim();
  if (!/^[0-9]{1,12}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

/**
 * PATCH /api/board/interviews/<id> - edit one interview.
 *
 * The three editable fields are exactly the section's: the date & time, the type and the
 * `result` text. No column change, no history row, no `resume_board` touch - correcting an
 * interview is not an audited change of the application (`CONSTITUTION.md` invariant 26).
 */
export const PATCH: APIRoute = async ({ params, request }) => {
  const id = interviewId(params);
  if (id === null) return json({ ok: false, error: 'invalid interview id' }, 400);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseInterviewRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const outcome = await updateInterview(id, parsed.value);
    if (!outcome.ok) return json({ ok: false, error: `no interview with id ${id}` }, 404);
    return json({ ok: true, card: outcome.card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};

/**
 * DELETE /api/board/interviews/<id> - remove one interview.
 *
 * One row, one card: the *other* interviews and the card's whole history stay. 404 when the id
 * is unknown (a second click on an already-removed row says so rather than succeeding quietly).
 */
export const DELETE: APIRoute = async ({ params }) => {
  const id = interviewId(params);
  if (id === null) return json({ ok: false, error: 'invalid interview id' }, 400);

  try {
    const outcome = await deleteInterview(id);
    if (!outcome.ok) return json({ ok: false, error: `no interview with id ${id}` }, 404);
    return json({ ok: true, card: outcome.card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
