/**
 * The card's **application URL** (`resume_board.apply_url`) - where the Apply button actually
 * lands - and the one canonicalisation both sides of it share.
 *
 * The field exists because the scraped vacancy and the page that finishes the application are
 * two different URLs: a Djinni or DOU card whose Apply button opens the employer's own ATS
 * posting (`https://job-boards.eu.greenhouse.io/growe/jobs/4987494101`) has to remember that
 * landing page, or the extension standing on it has no way to tell which card it belongs to.
 *
 * Exactly two callers ask about one of these URLs - the card's Details form, which stores it
 * (`lib/details.ts`), and `GET /api/vacancies/link`, which matches the page the applier is on -
 * so the rule lives here and nowhere else. It is deliberately *lossy*: the fragment and the
 * query string are dropped, because an ATS page's tracking tail (`?gh_src=…`) is not part of
 * the vacancy's identity and a stored URL that kept one would never match the page it came
 * from. The host is lower-cased, the trailing slash goes, and what is left is what the column
 * holds - the DB CHECK (`resume_board_details_shape`) accepts only `http(s)://…`.
 */

/** The length the DB CHECK enforces on `resume_board.apply_url`. */
export const MAX_APPLY_URL_LENGTH = 1000;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The canonical form of an application URL, or `null` when the value cannot be one.
 *
 * `origin` is what removes any credentials a paste carried (`https://user:pw@host/…`) and
 * lower-cases the scheme and host; the path keeps its case, because a path is case-sensitive on
 * most servers even though the host is not.
 */
export function normalizeApplyUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * One detail field: absent/empty clears it (`null`, the way the form and the DB store "nothing"),
 * anything else has to be an http(s) URL within the column's cap.
 */
export function parseApplyUrl(raw: unknown): ParseResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'applyUrl must be text' };

  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  if (text.length > MAX_APPLY_URL_LENGTH) {
    return { ok: false, error: `applyUrl must be at most ${MAX_APPLY_URL_LENGTH} characters` };
  }

  const url = normalizeApplyUrl(text);
  if (url === null) return { ok: false, error: 'applyUrl must be an http(s) URL' };
  return { ok: true, value: url };
}

/**
 * `GET /api/vacancies/link?url=…` - "which card is this page?".
 *
 * The page URL comes from the browser, so it is normalised the same way the stored one was
 * before it is compared: a trailing slash, a tracking query or a fragment on either side must
 * not decide whether the applier finds its card.
 */
export function parseLinkQuery(raw: string | null | undefined): ParseResult<string> {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'url is required' };
  if (text.length > MAX_APPLY_URL_LENGTH) {
    return { ok: false, error: `url must be at most ${MAX_APPLY_URL_LENGTH} characters` };
  }

  const url = normalizeApplyUrl(text);
  if (url === null) return { ok: false, error: 'url must be http(s)' };
  return { ok: true, value: url };
}
