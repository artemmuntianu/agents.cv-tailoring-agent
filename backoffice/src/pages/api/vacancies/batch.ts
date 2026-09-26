import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import {
  deleteSubmittedRows,
  findExistingVacancies,
  insertSubmittedRows,
} from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';
import { INGEST_STATUS, planIngest } from '../../../lib/ingest';
import { cvVersion, publishResumeTasks, queueDepth, queueName } from '../../../lib/queue';
import { parseBatchRequest, toTaskMessage } from '../../../lib/vacancies';

export const prerender = false;

/**
 * POST /api/vacancies/batch - the API gateway the design describes.
 *
 * The Chrome extension scrapes every `div[id^="job-item-"]` on a listing page and
 * posts the array here; one AMQP message per vacancy goes to `resumes.generate`, and
 * KEDA does the rest. Validation happens before publishing, so a malformed page
 * cannot produce poison messages.
 *
 * Order matters and is the point of this route:
 *
 *   1. read what the board already has by business key;
 *   2. **create the cards** (`status = submitted`, claimable - see `lib/ingest.ts`),
 *      so a scraped vacancy is in the Created column at once instead of only after
 *      KEDA boots a worker;
 *   3. publish one message per card, then report the queue depth.
 *
 * If the publish fails the cards created by *this* request are taken back, so the
 * board never shows work that will not run.
 *
 * Auth: the session cookie, or `Authorization: Bearer <token>` from
 * `POST /api/auth/token` (that is what the extension uses).
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const session = locals.session;
  if (!session) return json({ ok: false, error: 'authentication required' }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseBatchRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  const version = cvVersion();

  let known;
  try {
    known = await findExistingVacancies(
      session.sub,
      parsed.vacancies.map((vacancy) => vacancy.external_id),
      version,
    );
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }

  const plan = planIngest(parsed.vacancies, known, { makeJobId: () => randomUUID() });

  let created: string[] = [];
  try {
    created = await insertSubmittedRows(plan.insert, session.sub, version, INGEST_STATUS);
  } catch (error) {
    return json({ ok: false, error: `could not create the board cards: ${errorMessage(error)}` }, 503);
  }

  // A row that lost a race (a concurrent request created it) is that request's to
  // publish; this one only queues what it created, plus the retries.
  const own = new Set(created);
  const pending = plan.publish.filter((item) => item.retry || own.has(item.jobId));
  const messages = pending.map((item) =>
    toTaskMessage(item.vacancy, session.sub, { jobId: item.jobId, cvVersion: version }),
  );

  const payload = {
    ok: true as const,
    published: messages.length,
    duplicates: parsed.duplicates + plan.duplicates,
    retries: plan.retries,
    queue: queueName(),
    jobIds: pending.map((item) => item.jobId),
  };

  // Nothing to publish (a page the board already knows): no broker round trip.
  if (messages.length === 0) return json({ ...payload, depth: null });

  try {
    const published = await publishResumeTasks(messages);
    return json({ ...payload, published, depth: await queueDepth() });
  } catch (error) {
    await deleteSubmittedRows(created, INGEST_STATUS).catch(() => undefined);
    return json({ ok: false, error: errorMessage(error) }, 502);
  }
};
