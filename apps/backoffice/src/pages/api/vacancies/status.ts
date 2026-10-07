import type { APIRoute } from 'astro';
import { findExistingVacancies } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';
import { cvVersion } from '../../../lib/queue';
import { parseStatusQuery } from '../../../lib/vacancies';

export const prerender = false;

/**
 * GET /api/vacancies/status?external_ids=850374,850375
 *
 * "Is this vacancy already on the board?" - the question the injected per-card buttons ask
 * before they render `Scrape` or `Scraped`. The lookup is the very one the batch gateway
 * uses for dedupe (`findExistingVacancies`), so a listing page costs one request instead of
 * one per card, and the answer carries the `jobId` the `Scraped` link points at.
 *
 * Auth: the session cookie, or `Authorization: Bearer <token>` (which is what the extension
 * uses). 400 for a bad query, so a malformed page never reaches the database.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const session = locals.session;
  if (!session) return json({ ok: false, error: 'authentication required' }, 401);

  const parsed = parseStatusQuery(
    url.searchParams.get('external_ids'),
    url.searchParams.get('source'),
  );
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const known = await findExistingVacancies(session.sub, parsed.ids, {
      scope: 'board',
      source: parsed.source,
    });
    return json({
      ok: true,
      cvVersion: cvVersion(),
      known: Object.fromEntries(
        Array.from(known, ([externalId, row]) => [
          externalId,
          { jobId: row.jobId, status: row.status, archived: row.archived },
        ]),
      ),
    });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
