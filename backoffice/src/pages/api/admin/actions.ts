import type { APIRoute } from 'astro';
import { parseActionInput, parseActionValue, parseRenameInput } from '../../../lib/admin';
import { deleteAction, insertAction, renameAction } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';

export const prerender = false;

/**
 * The Action vocabulary, writable.
 *
 *   POST   /api/admin/actions          { value, kind }    add
 *   PATCH  /api/admin/actions          { from, to }       reword
 *   DELETE /api/admin/actions?value=…                    remove from the catalogue
 *
 * Every one of them is *catalogue-only*: `resume_history` and
 * `resume_board.archived_reason` keep the words they were recorded with, which is why a
 * removed value comes back from `GET /api/admin/vocabulary` as `catalogued: false` (still
 * filterable, no longer suggested). Nothing here can rewrite history.
 *
 * Admin-only; see `GET /api/admin/vocabulary` for why the route re-checks the claim.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.session?.admin) return json({ ok: false, error: 'administrator only' }, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseActionInput(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const outcome = await insertAction(parsed.value);
    if (outcome === 'exists') {
      return json({ ok: false, error: `"${parsed.value.value}" is already in the vocabulary` }, 409);
    }
    return json({ ok: true, value: parsed.value.value, kind: parsed.value.kind }, 201);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  if (!locals.session?.admin) return json({ ok: false, error: 'administrator only' }, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseRenameInput(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const outcome = await renameAction(parsed.value.from, parsed.value.to);
    if (outcome === 'unknown') {
      return json({ ok: false, error: `"${parsed.value.from}" is not in the vocabulary` }, 404);
    }
    if (outcome === 'exists') {
      return json({ ok: false, error: `"${parsed.value.to}" already exists` }, 409);
    }
    return json({ ok: true, from: parsed.value.from, to: parsed.value.to });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};

export const DELETE: APIRoute = async ({ url, locals }) => {
  if (!locals.session?.admin) return json({ ok: false, error: 'administrator only' }, 403);

  const parsed = parseActionValue(url.searchParams.get('value'));
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const removed = await deleteAction(parsed.value);
    if (!removed) {
      return json({ ok: false, error: `"${parsed.value}" is not in the vocabulary` }, 404);
    }
    return json({ ok: true, value: parsed.value });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
