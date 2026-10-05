import type { APIRoute } from 'astro';
import { taskMessageRow } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';
import { parseJobQuery, textStats } from '../../../lib/vacancyText';

export const prerender = false;

/**
 * GET /api/vacancies/text?job_id=<job_id> - the **parsed** job description of one vacancy.
 *
 * The board's cards carry `has_description` instead of the text (`lib/db.ts::CARD_SELECT`), so the one
 * page that wants to read a description asks for it here, one row at a time.
 *
 * `taskMessageRow` is the read, deliberately: it is the row a drag into *Prepare* turns into a queue
 * message, so this answers with the very text the worker will be given rather than a re-derivation of
 * it. That is the point of the page - the parse can be judged against what is actually used.
 *
 * Read-only, and it reports the empty case as a fact: a row created before the column existed
 * (2026-09-26) has `text: null` with the rest of the row intact, which is not a 404.
 */
export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.session) return json({ ok: false, error: 'authentication required' }, 401);

  const parsed = parseJobQuery(url.searchParams.get('job_id'));
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const row = await taskMessageRow(parsed.value);
    if (!row) return json({ ok: false, error: `no vacancy with job_id ${parsed.value}` }, 404);

    return json({
      ok: true,
      vacancy: {
        jobId: row.jobId,
        source: row.source,
        externalId: row.externalId,
        title: row.title,
        company: row.company,
        sourceUrl: row.sourceUrl,
        status: row.status,
        stage: row.stage,
        cvVersion: row.cvVersion,
        text: row.descriptionRaw,
        stats: textStats(row.descriptionRaw),
      },
    });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 503);
  }
};
