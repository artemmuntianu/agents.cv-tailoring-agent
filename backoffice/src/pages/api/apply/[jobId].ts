import type { APIRoute } from 'astro';
import { parseApplicationRequest, toApplicationMessage } from '../../../lib/application';
import { candidateVersion } from '../../../lib/candidate';
import {
  applicationFor,
  failApplicationRequest,
  markApplicationRequested,
  taskMessageRow,
} from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';
import { applicationQueueName, publishApplicationRequests } from '../../../lib/queue';

export const prerender = false;

const JOB_ID = /^[A-Za-z0-9_.:-]{4,80}$/;

/**
 * POST /api/apply/<job_id> - "draft this application form for me".
 *
 * The body is the extension's snapshot of the *rendered* form: every fillable control carries a
 * `data-cvt-id` the extension minted, so the plan it gets back can address a field exactly without
 * the model ever seeing a selector. Two things happen here: the row is claimed for the snapshot's
 * hash and one message is published to `applications.draft`.
 *
 * `queued: false` is a normal answer - it means a draft for *exactly this form* is already in
 * flight, or its plan is already stored. The extension's question is "does a plan exist for this
 * form?", not "publish a message", so this route is idempotent per snapshot (and the worker acks
 * the same snapshot without a second Gemini call).
 *
 * The generated cover letter and the tailored PDF never travel through here: the extension
 * inserts those itself, and the message only says which element each belongs in.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const session = locals.session;
  if (!session) return json({ ok: false, error: 'authentication required' }, 401);

  const jobId = String(params.jobId ?? '').trim();
  if (!JOB_ID.test(jobId)) return json({ ok: false, error: 'invalid job_id' }, 400);

  let row;
  try {
    row = await taskMessageRow(jobId);
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }
  if (!row) return json({ ok: false, error: `no vacancy with job_id ${jobId}` }, 404);
  if (!row.descriptionRaw) {
    // The draft is written from the stored description; the worker refuses such a message, so the
    // request must not be queued at all (the same rule the cover letter follows).
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseApplicationRequest(body, await candidateVersion(session.sub));
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  let existing;
  try {
    existing = await applicationFor(jobId);
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }
  if (
    existing &&
    existing.status === 'completed' &&
    existing.plan &&
    existing.schemaHash === parsed.schemaHash
  ) {
    return json({ ok: true, queued: false, status: 'completed', schemaHash: parsed.schemaHash });
  }

  let claimed;
  try {
    claimed = await markApplicationRequested(jobId, parsed.schemaHash);
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }
  if (!claimed) {
    return json({ ok: true, queued: false, status: 'running', schemaHash: parsed.schemaHash });
  }

  const context = body as { url?: unknown; host?: unknown };
  try {
    const published = await publishApplicationRequests([
      toApplicationMessage(parsed.form, {
        jobId,
        url: String(context.url ?? '').slice(0, 1000),
        host: String(context.host ?? '').slice(0, 200),
        schemaHash: parsed.schemaHash,
      }),
    ]);
    return json({
      ok: true,
      queued: true,
      status: 'queued',
      published,
      queue: applicationQueueName(),
      schemaHash: parsed.schemaHash,
    });
  } catch (error) {
    await failApplicationRequest(jobId, errorMessage(error)).catch(() => undefined);
    return json({ ok: false, error: errorMessage(error) }, 502);
  }
};

/**
 * GET /api/apply/<job_id>?schema=<hash> - the poll the extension runs while it waits.
 *
 * `status: 'stale'` means the stored plan was drafted for a different form than the one on screen
 * (the page was reloaded, the vacancy changed its questions, the candidate file was edited): the
 * extension then POSTs again, which re-drafts and spends one Gemini call.
 * `status: 'none'` means nothing has ever been asked for this card - POST first.
 */
export const GET: APIRoute = async ({ params, url, locals }) => {
  if (!locals.session) return json({ ok: false, error: 'authentication required' }, 401);

  const jobId = String(params.jobId ?? '').trim();
  if (!JOB_ID.test(jobId)) return json({ ok: false, error: 'invalid job_id' }, 400);

  const wanted = url.searchParams.get('schema')?.trim() || '';

  let row;
  try {
    row = await applicationFor(jobId);
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }
  if (!row) return json({ ok: true, status: 'none', schemaHash: null, plan: null });

  const stale = Boolean(wanted) && Boolean(row.schemaHash) && wanted !== row.schemaHash;
  return json({
    ok: true,
    status: stale ? 'stale' : row.status,
    schemaHash: row.schemaHash,
    plan: row.plan,
    model: row.model,
    error: row.error,
    updatedAt: row.updatedAt,
  });
};
