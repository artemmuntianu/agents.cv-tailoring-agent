import type { APIRoute } from 'astro';
import { deleteHistoryLine, updateHistoryLine } from '../../../../lib/db';
import { parseHistoryRequest } from '../../../../lib/history';
import { errorMessage, json } from '../../../../lib/http';

export const prerender = false;

/** The row id from the path, or null when it is not a positive integer. */
function historyId(params: Record<string, string | undefined>): number | null {
  const raw = String(params.id ?? '').trim();
  if (!/^[0-9]{1,12}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

/**
 * PATCH /api/board/history/<id> - correct one line of a card's History.
 *
 * The whole line is rewritten (date, actor, wording, kind and both states) because the button
 * exists for a *mis-recorded* line: a wrong reason, a wrong actor, a date nobody had to hand. The
 * card is not touched - not its column, not `resume_board.updated_at` - so a correction is not
 * operator activity and cannot silently reset the inactivity clock (invariant 29). The wording is
 * corrected in place, so `board_actions` is **not** widened by an edit: a new action is a dialog
 * away, in the place where the operator actually makes a change.
 */
export const PATCH: APIRoute = async ({ params, request }) => {
  const id = historyId(params);
  if (id === null) return json({ ok: false, error: 'invalid history id' }, 400);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseHistoryRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const outcome = await updateHistoryLine(id, parsed.value);
    if (!outcome.ok) return json({ ok: false, error: `no history line with id ${id}` }, 404);
    return json({ ok: true, card: outcome.card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};

/**
 * DELETE /api/board/history/<id> - drop one line of a card's History.
 *
 * The operator's own bad record and nothing else: the card, its column, its archive flags and its
 * remaining lines stay. 404 when the id is unknown (a second click on an already-removed line says
 * so rather than succeeding quietly). The one knock-on is the Interviews section, which is shown on
 * the strength of a `move` into Interviewing - its own rows are never touched.
 */
export const DELETE: APIRoute = async ({ params }) => {
  const id = historyId(params);
  if (id === null) return json({ ok: false, error: 'invalid history id' }, 400);

  try {
    const outcome = await deleteHistoryLine(id);
    if (!outcome.ok) return json({ ok: false, error: `no history line with id ${id}` }, 404);
    return json({ ok: true, card: outcome.card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
