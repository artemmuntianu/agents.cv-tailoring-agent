/**
 * The batch contract between the scraper (Chrome extension) and the queue.
 *
 * One listing page produces one request with N vacancies; each vacancy becomes
 * exactly one `ResumeTaskMessage` (see `agent/contracts.py`). This module is pure:
 * `parseBatchRequest` rejects anything the worker would choke on *before* a message
 * is published, so a bad page never burns attempts or lands in the DLQ.
 */

export const MAX_BATCH_SIZE = 25;
const MAX_DESCRIPTION_CHARS = 200_000;
const MAX_FIELD_CHARS = 300;

export interface ScrapedVacancy {
  external_id: string;
  title: string;
  company: string;
  description_raw: string;
  source_url?: string;
}

export type BatchParse =
  | { ok: true; vacancies: ScrapedVacancy[]; duplicates: number }
  | { ok: false; error: string };

function asText(value: unknown, limit = MAX_FIELD_CHARS): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export function parseBatchRequest(body: unknown): BatchParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const items = (body as { vacancies?: unknown }).vacancies;
  if (!Array.isArray(items)) return { ok: false, error: 'vacancies must be an array' };
  if (items.length === 0) return { ok: false, error: 'vacancies is empty' };
  if (items.length > MAX_BATCH_SIZE) {
    return { ok: false, error: `too many vacancies (${items.length} > ${MAX_BATCH_SIZE})` };
  }

  const seen = new Set<string>();
  const vacancies: ScrapedVacancy[] = [];
  let duplicates = 0;

  for (const [index, raw] of items.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `vacancies[${index}] must be an object` };
    }
    const item = raw as Record<string, unknown>;

    // external_id is the vacancy's id on the source site; it is half of the
    // idempotency key, so it must be present and stable.
    const externalId = asText(item.external_id);
    if (!externalId) return { ok: false, error: `vacancies[${index}].external_id is required` };

    const description = typeof item.description_raw === 'string' ? item.description_raw.trim() : '';
    if (!description) {
      return { ok: false, error: `vacancies[${index}].description_raw is required` };
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      return {
        ok: false,
        error: `vacancies[${index}].description_raw is too long (${description.length} chars)`,
      };
    }

    const sourceUrl = asText(item.source_url, 1000);
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
      return { ok: false, error: `vacancies[${index}].source_url must be http(s)` };
    }

    // Two cards of the same vacancy on one page are one task.
    if (seen.has(externalId)) {
      duplicates += 1;
      continue;
    }
    seen.add(externalId);

    vacancies.push({
      external_id: externalId,
      title: asText(item.title),
      company: asText(item.company),
      description_raw: description,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
    });
  }

  return { ok: true, vacancies, duplicates };
}

/**
 * Build the wire payload for one vacancy. Field names mirror
 * `agent/contracts.py::ResumeTaskMessage`; `cv_data` is deliberately absent, so the
 * worker downloads the master CV it already validates against `cv.docx`.
 */
export function toTaskMessage(
  vacancy: ScrapedVacancy,
  userId: string,
  options: { jobId: string; cvVersion?: string; now?: Date },
): Record<string, unknown> {
  return {
    job_id: options.jobId,
    user_id: userId,
    external_id: vacancy.external_id,
    title: vacancy.title,
    company: vacancy.company,
    source_url: vacancy.source_url ?? null,
    description_raw: vacancy.description_raw,
    cv_version: options.cvVersion ?? 'v1',
    attempt: 0,
    enqueued_at: (options.now ?? new Date()).toISOString(),
  };
}
