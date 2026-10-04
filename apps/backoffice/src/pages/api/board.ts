import type { APIRoute } from 'astro';
import { fetchBoard } from '../../lib/db';
import { errorMessage, json } from '../../lib/http';

export const prerender = false;

/** GET /api/board - every vacancy the worker has a row for, with board state. */
export const GET: APIRoute = async () => {
  try {
    const cards = await fetchBoard();
    return json({ ok: true, cards });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
