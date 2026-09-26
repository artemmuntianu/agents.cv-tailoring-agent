import type { APIRoute } from 'astro';
import { failCoverRequest, markCoverRequested, taskMessageRow } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';
import { coverQueueName, publishCoverRequests } from '../../../lib/queue';

export const prerender = false;

/**
 * POST /api/cover/<job_id> - "write a cover letter for this card".
 *
 * Available for **any** card, whatever column it is in and whether it is archived: a letter is
 * application material, not a stage of the funnel. The work happens on the `resumes.cover`
 * queue with its own worker and its own ScaledObject, so asking for a letter can never wake a
 * tailoring task - and the card's own row (`resume_cover_letter`, read by the board's card
 * payload) is how the modal sees the result.
 *
 * Order: claim the row, publish, and mark the row `failed` when the broker refuses. A claim
 * that is refused means a letter is *being written right now* - two clicks must not queue two
 * generations, and the modal's polling will show the first one landing.
 */
export const POST: APIRoute = async ({ params, locals }) => {
  const session = locals.session;
  if (!session) return json({ ok: false, error: 'authentication required' }, 401);

  const jobId = String(params.jobId ?? '').trim();
  if (!/^[A-Za-z0-9_.:-]{4,80}$/.test(jobId)) {
    return json({ ok: false, error: 'invalid job_id' }, 400);
  }

  let row;
  try {
    row = await taskMessageRow(jobId);
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }
  if (!row) return json({ ok: false, error: `no vacancy with job_id ${jobId}` }, 404);
  if (!row.descriptionRaw) {
    // A letter is written from the stored description; the worker refuses such a message on
    // purpose, so the request must not be queued at all.
    return json(
      {
        ok: false,
        error:
          'this card has no job description stored (it was scraped before that column ' +
          'existed) - scrape the page again first',
      },
      409,
    );
  }

  try {
    const claimed = await markCoverRequested(jobId);
    if (!claimed) {
      return json(
        { ok: false, error: 'a cover letter is already being written for this card' },
        409,
      );
    }
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }

  try {
    const published = await publishCoverRequests([
      { job_id: jobId, enqueued_at: new Date().toISOString() },
    ]);
    return json({ ok: true, published, queue: coverQueueName() });
  } catch (error) {
    await failCoverRequest(jobId, errorMessage(error)).catch(() => undefined);
    return json({ ok: false, error: errorMessage(error) }, 502);
  }
};
