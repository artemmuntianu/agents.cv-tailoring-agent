import type { APIRoute } from 'astro';
import { parseArchiveRequest } from '../../../lib/board';
import { archiveCard } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';

export const prerender = false;

/**
 * POST /api/board/archive - refuse a vacancy (the board's in-place soft delete).
 *
 * The card keeps the column it reached; only the board's archive columns change, in one
 * transaction with the history row and the Action catalogue. Restore is
 * `POST /api/board/restore`.
 *
 * 404 unknown job id, 409 already archived - the UI reports both without moving
 * anything, and re-reads the board (the database is the display).
 */
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseArchiveRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const outcome = await archiveCard(parsed.value);
    if (!outcome.ok) {
      return outcome.reason === 'unknown'
        ? json({ ok: false, error: `no vacancy with job_id ${parsed.value.jobId}` }, 404)
        : json({ ok: false, error: 'that vacancy is already archived' }, 409);
    }
    return json({ ok: true, card: outcome.card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
