import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { errorMessage, json } from '../../../lib/http';
import { cvVersion, publishResumeTasks, queueDepth, queueName } from '../../../lib/queue';
import { parseBatchRequest, toTaskMessage } from '../../../lib/vacancies';

export const prerender = false;

/**
 * POST /api/vacancies/batch - the API gateway the design describes.
 *
 * The Chrome extension scrapes every `div[id^="job-item-"]` on a listing page and
 * posts the array here; one AMQP message per vacancy goes to `resumes.generate`,
 * and KEDA does the rest. Validation happens before publishing, so a malformed
 * page cannot produce poison messages.
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

  const messages = parsed.vacancies.map((vacancy) =>
    toTaskMessage(vacancy, session.sub, { jobId: randomUUID(), cvVersion: cvVersion() }),
  );

  try {
    const published = await publishResumeTasks(messages);
    return json({
      ok: true,
      published,
      duplicates: parsed.duplicates,
      queue: queueName(),
      depth: await queueDepth(),
      jobIds: messages.map((message) => message.job_id),
    });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 502);
  }
};
