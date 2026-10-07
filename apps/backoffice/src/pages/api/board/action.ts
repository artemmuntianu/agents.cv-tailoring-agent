import type { APIRoute } from 'astro';
import { parseActionRequest } from '../../../lib/board';
import { appendAction } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';

export const prerender = false;

/**
 * POST /api/board/action - record an action **without** moving the card.
 *
 * The vacancy dialog's `➕ Add action` button opens the same dialog as a move (an Actor and a reason),
 * but nothing about the funnel changes: the column is read and written back untouched, one
 * `move` history row with `from_state = to_state = <column>` is written with the Action
 * catalogue upsert, and the vocabulary grows with whatever the operator typed.
 *
 * Why not `POST /api/board/move` with the current column: in **Prepare** a move into the same
 * column is a tailoring *retry* (`lib/board.ts::tailoringRequest`), so an Add Action there
 * would spend Gemini; and for every other column the move route writes no history row at all
 * when the column does not change. Recording an action has to be its own route.
 *
 * 404 unknown job id; the board re-reads the card afterwards (the database is the display).
 */
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseActionRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const card = await appendAction(parsed.value);
    if (!card) {
      return json({ ok: false, error: `no vacancy with job_id ${parsed.value.jobId}` }, 404);
    }
    return json({ ok: true, card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
