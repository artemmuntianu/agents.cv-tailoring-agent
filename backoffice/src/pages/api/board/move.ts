import type { APIRoute } from 'astro';
import { parseMoveRequest, tailoringRequest } from '../../../lib/board';
import type { InterviewRequest } from '../../../lib/types';
import { fetchCard, moveCard, taskMessageRow } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';
import { parseInterviewRequest } from '../../../lib/interviews';
import { publishResumeTasks } from '../../../lib/queue';
import { toTaskMessage } from '../../../lib/vacancies';

export const prerender = false;

/**
 * POST /api/board/move - the only way a card changes column, and the only thing that queues
 * tailoring.
 *
 * Entering **Prepare** is the operator's instruction to spend Gemini on that vacancy: the row
 * is read, one `ResumeTaskMessage` is published, and only then is the stage written. If the
 * broker refuses, a card that just left Scraped goes back - "in Prepare" has to mean
 * "tailoring was requested", not quietly the opposite. A card already in Prepare with a parked
 * status is *retried* by the same request (the stage does not change, so no history noise).
 *
 * A card without a stored job description cannot be queued at all: it predates the
 * `description_raw` column, and the worker would refuse a message with no description. The
 * answer says so and the card stays where it is, instead of burning an attempt in the DLQ.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const parsed = parseMoveRequest(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  const move = parsed.value;

  // The Interview section of the Move dialog: a first interview is part of *entering*
  // Interviewing, so it is only accepted for that column - anything else would be an interview
  // for a card that never reached the section. An absent/empty draft simply inserts nothing.
  const draft = (body as { interview?: unknown }).interview;
  let interview: InterviewRequest | null = null;
  if (typeof draft === 'object' && draft !== null) {
    if (move.to !== 'interviewing') {
      return json(
        { ok: false, error: 'an interview can only be added when moving to Interviewing' },
        400,
      );
    }
    const parsedInterview = parseInterviewRequest(draft);
    if (!parsedInterview.ok) return json({ ok: false, error: parsedInterview.error }, 400);
    interview = parsedInterview.value;
  }

  let row;
  try {
    row = await taskMessageRow(move.jobId);
  } catch (error) {
    return json({ ok: false, error: `job store unavailable: ${errorMessage(error)}` }, 503);
  }
  if (!row) {
    return json({ ok: false, error: `no vacancy with job_id ${move.jobId}` }, 404);
  }

  const wanted = tailoringRequest(row.stage, row.status, move.to);
  let queued = 0;

  if (wanted !== 'none' && !row.descriptionRaw) {
    return json(
      {
        ok: false,
        error:
          'this card has no job description stored (it was scraped before that column ' +
          'existed) - scrape the page again, then move it to Prepare',
      },
      409,
    );
  }

  if (wanted !== 'none') {
    const message = toTaskMessage(
      {
        external_id: row.externalId,
        title: row.title,
        company: row.company,
        description_raw: row.descriptionRaw ?? '',
        ...(row.sourceUrl ? { source_url: row.sourceUrl } : {}),
      },
      row.userId,
      { jobId: row.jobId, cvVersion: row.cvVersion, source: row.source },
    );

    try {
      queued = await publishResumeTasks([message]);
    } catch (error) {
      const reason = `Tailoring request failed - ${errorMessage(error)}`.slice(0, 500);
      if (move.to !== row.stage) {
        await moveCard({ ...move, to: 'scraped', action: reason }).catch(() => undefined);
      }
      return json({ ok: false, error: errorMessage(error) }, 502);
    }
  }

  try {
    // A retry does not change the column: answer with the card as it stands.
    const card =
      move.to === row.stage ? await fetchCard(move.jobId) : await moveCard(move, interview);
    if (!card) {
      return json({ ok: false, error: `no vacancy with job_id ${move.jobId}` }, 404);
    }
    return json({ ok: true, card, queued });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
