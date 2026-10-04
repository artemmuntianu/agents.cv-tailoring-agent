/**
 * The batch contract between the scraper (Chrome extension) and the queue.
 *
 * One listing page produces one request with N vacancies; each vacancy becomes
 * exactly one `ResumeTaskMessage` (see `apps/worker/agent/contracts.py`). This module is pure:
 * `parseBatchRequest` rejects anything the worker would choke on *before* a message
 * is published, so a bad page never burns attempts or lands in the DLQ.
 */

export const MAX_BATCH_SIZE = 25;
/** How many vacancies one status lookup may ask about (a whole listing page). */
export const MAX_STATUS_IDS = 200;
const MAX_DESCRIPTION_CHARS = 200_000;
const MAX_FIELD_CHARS = 300;
/** Ids the DB's shape guard accepts (`resumes_job_id_shape` uses the same alphabet). */
const EXTERNAL_ID = /^[A-Za-z0-9_.:-]+$/;
/**
 * A site slug (`resumes.source`, guarded by `resumes_source_shape`): lower-case, dashes,
 * 2-32 characters. `djinni` is the default so an extension build that predates `source`
 * keeps producing exactly the rows it did before.
 */
const SOURCE_SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const DEFAULT_SOURCE = 'djinni';

export interface ScrapedVacancy {
  external_id: string;
  title: string;
  company: string;
  description_raw: string;
  source_url?: string;
}

export type BatchParse =
  | { ok: true; vacancies: ScrapedVacancy[]; duplicates: number; source: string }
  | { ok: false; error: string };

function asText(value: unknown, limit = MAX_FIELD_CHARS): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export function parseBatchRequest(body: unknown): BatchParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  // The site is per *request*, not per vacancy: one page is scraped from one site, and
  // the scout posts a batch of one feed. It is half of the vacancy's identity, so it is
  // validated before anything is queued.
  const source = (asText((body as { source?: unknown }).source, 32) || DEFAULT_SOURCE).toLowerCase();
  if (!SOURCE_SLUG.test(source)) {
    return { ok: false, error: `source must be a site slug (got "${source.slice(0, 32)}")` };
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

  return { ok: true, vacancies, duplicates, source };
}

/**
 * Validate `GET /api/vacancies/status?external_ids=a,b,c`.
 *
 * The injected per-card buttons ask this before they decide between `Scrape` and
 * `Scraped`, so it has to answer for a whole listing page in one call. Rejects anything the
 * batch validator would reject later, and de-duplicates: a page with the same vacancy twice
 * must not cost two lookups.
 */
export function parseStatusQuery(
  raw: string | null | undefined,
  rawSource?: string | null,
): { ok: true; ids: string[]; source: string } | { ok: false; error: string } {
  const source = (String(rawSource ?? '').trim() || DEFAULT_SOURCE).toLowerCase();
  if (!SOURCE_SLUG.test(source)) {
    return { ok: false, error: `source must be a site slug (got "${source.slice(0, 32)}")` };
  }
  const ids = String(raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return { ok: false, error: 'external_ids is required (comma-separated)' };
  }
  if (ids.length > MAX_STATUS_IDS) {
    return { ok: false, error: `too many ids (${ids.length} > ${MAX_STATUS_IDS})` };
  }
  for (const id of ids) {
    if (id.length > MAX_FIELD_CHARS || !EXTERNAL_ID.test(id)) {
      return { ok: false, error: `"${id.slice(0, 40)}" is not a valid external_id` };
    }
  }
  return { ok: true, ids: Array.from(new Set(ids)), source };
}

/**
 * Build the wire payload for one vacancy. Field names mirror
 * `apps/worker/agent/contracts.py::ResumeTaskMessage`; `cv_data` is deliberately absent, so the
 * worker downloads the master CV it already validates against `cv.docx`.
 */
export function toTaskMessage(
  vacancy: ScrapedVacancy,
  // `null` is a real case: the CLI/smoke-test rows carry no user id, and the message has to
  // match the row's business key or the worker's claim would insert a second row.
  userId: string | null,
  options: { jobId: string; cvVersion?: string; source?: string; now?: Date },
): Record<string, unknown> {
  return {
    job_id: options.jobId,
    user_id: userId,
    external_id: vacancy.external_id,
    source: options.source ?? DEFAULT_SOURCE,
    title: vacancy.title,
    company: vacancy.company,
    source_url: vacancy.source_url ?? null,
    description_raw: vacancy.description_raw,
    cv_version: options.cvVersion ?? 'v1',
    attempt: 0,
    enqueued_at: (options.now ?? new Date()).toISOString(),
  };
}
