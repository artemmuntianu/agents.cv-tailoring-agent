import type { APIRoute } from 'astro';
import { requestCoverLetter } from '../../../lib/coverRequest';
import type { CoverRequestResult } from '../../../lib/coverRequest';
import { coverLetter, taskMessageRow } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';
import { coverQueueName } from '../../../lib/queue';

export const prerender = false;

const JOB_ID = /^[A-Za-z0-9_.:-]{4,80}$/;

/**
 * POST /api/cover/<job_id> - "write a cover letter for this card".
 *
 * Available for **any** card, whatever column it is in and whether it is archived: a letter is
 * application material, not a stage of the funnel. The work happens on the `resumes.cover`
 * queue with its own worker and its own ScaledObject, so asking for a letter can never wake a
 * tailoring task - and the card's own row (`resume_cover_letter`, read by the board's card
 * payload) is how the modal sees the result.
 *
 * The claim/publish/rollback order itself lives in `lib/coverRequest.ts`, which the move route
 * shares: a claim that is refused means a letter is *being written right now* - two clicks must
 * not queue two generations, and the modal's polling will show the first one landing. Unlike the
 * automatic request this route passes no `onlyIfMissing`: a click means "write it again".
 */
export const POST: APIRoute = async ({ params, locals }) => {
  const session = locals.session;
  if (!session) return json({ ok: false, error: 'authentication required' }, 401);

  const jobId = String(params.jobId ?? '').trim();
  if (!JOB_ID.test(jobId)) {
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

  let result: CoverRequestResult;
  try {
    result = await requestCoverLetter(jobId);
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }

  if (result.outcome === 'busy') {
    return json(
      { ok: false, error: 'a cover letter is already being written for this card' },
      409,
    );
  }
  if (result.outcome === 'failed') {
    return json({ ok: false, error: result.error ?? 'the publish failed' }, 502);
  }
  // `onlyIfMissing` is off here, so `already` cannot come back: `queued` is the normal answer.
  return json({
    ok: true,
    published: result.outcome === 'queued' ? 1 : 0,
    queue: coverQueueName(),
  });
};

/**
 * GET /api/cover/<job_id> - the letter itself, for the extension's form filler.
 *
 * The board reads the letter through its card payload; a browser extension that has to paste the
 * text into an application form needs just this one card, so this is the narrow read that keeps a
 * form fill from fetching the whole board. The letter is never sent to a model: the extension
 * inserts it verbatim, and `agent/application.py` only ever says *where* it goes.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.session) return json({ ok: false, error: 'authentication required' }, 401);

  const jobId = String(params.jobId ?? '').trim();
  if (!JOB_ID.test(jobId)) return json({ ok: false, error: 'invalid job_id' }, 400);

  let row;
  try {
    row = await coverLetter(jobId);
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }
  if (!row) return json({ ok: true, status: 'none', text: null, model: null, error: null });
  return json({ ok: true, ...row });
};
