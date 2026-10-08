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
 * so the rule lives here and nowhere else. It drops the **fragment** and the **tracking
 * parameters** (`?gh_src=…`, `?utm_…`) and keeps everything else. An ATS's tracking tail is not
 * part of the vacancy's identity and a stored URL that kept one would never match the page it came
 * from - but on a board that renders every posting at one path the query *is* the vacancy
 * (Greenhouse's `?gh_jid=7822098003`), so dropping it wholesale made the stored URL a dead link
 * *and* ambiguous between two postings (reported 2026-10-08). The host is lower-cased, the
 * trailing slash goes, and what is left is what the column holds - the DB CHECK
 * (`resume_board_details_shape`) accepts only `http(s)://…`.
 */

/** The length the DB CHECK enforces on `resume_board.apply_url`. */
export const MAX_APPLY_URL_LENGTH = 1000;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Query parameters that never identify the page: the tail a tracking link, a referrer app or a
 * mail client appends. Everything not named here is **kept** - which is the point of the list
 * being a deny-list rather than the old "drop the whole query": an ATS whose query carries the
 * vacancy's own id must keep it.
 *
 * Deliberately short, and named only where the parameter is known to be noise. A wrong guess here
 * is a stored URL that stops matching its page, so an unknown parameter survives by default.
 */
const TRACKING_PARAMS: RegExp[] = [
  /^utm($|_)/i,
  /^gh_src$/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^_ga$/i,
];

/** The query minus its tracking tail, in the order the page wrote it (`''` when nothing is left). */
function identityQuery(parsed: URL): string {
  const kept = new URLSearchParams();
  parsed.searchParams.forEach((value, name) => {
    if (TRACKING_PARAMS.some((pattern) => pattern.test(name))) return;
    kept.append(name, value);
  });
  const query = kept.toString();
  return query ? `?${query}` : '';
}

/**
 * The canonical form of an application URL, or `null` when the value cannot be one.
 *
 * `origin` is what removes any credentials a paste carried (`https://user:pw@host/…`) and
 * lower-cases the scheme and host; the path keeps its case, because a path is case-sensitive on
 * most servers even though the host is not. The surviving query keeps the order the page wrote it
 * in: the operator pastes the URL out of the address bar, so it *is* the page's own order, and
 * sorting it would be a second, invisible normalisation to explain.
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

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${identityQuery(parsed)}`;
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
