import type { APIRoute } from 'astro';
import { fetchActionVocabulary } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';

export const prerender = false;

/**
 * GET /api/board/actions - the Action vocabulary (`board_actions`).
 *
 * Two consumers, one source: the dialogs' Action combobox ranks these values (its own
 * kind first, most used on top) and the Filters dialog lists them as filter options.
 * Read once with the board and once after each confirmed change, so a value the
 * operator typed is offered everywhere immediately.
 */
export const GET: APIRoute = async () => {
  try {
    return json({ ok: true, actions: await fetchActionVocabulary() });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
