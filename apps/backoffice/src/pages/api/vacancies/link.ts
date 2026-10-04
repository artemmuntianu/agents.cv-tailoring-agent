import type { APIRoute } from 'astro';
import { parseLinkQuery } from '../../../lib/applyUrl';
import { findCardByApplyUrl } from '../../../lib/db';
import { errorMessage, json } from '../../../lib/http';

export const prerender = false;

/**
 * GET /api/vacancies/link?url=https://job-boards.eu.greenhouse.io/growe/jobs/4987494101
 *
 * "Which card is this page?" - the question the extension's **Populate** asks when it is standing
 * on an application form that its own vacancy id does not resolve: a card scraped on DOU or
 * Djinni whose Apply button opened the employer's ATS posting. The card's `apply_url` is the
 * connection, so this route reads it through `findCardByApplyUrl`, with both sides of the
 * comparison canonicalised by `lib/applyUrl.ts` (a `?gh_src=…` tail must not decide the match).
 *
 * `card: null` is a normal answer, not a 404: it means no card has been linked to this page yet,
 * which is exactly what makes the applier say so instead of filling a form from the wrong
 * vacancy. Auth: the session cookie, or `Authorization: Bearer <token>` (what the extension
 * uses). 400 for a missing/!http(s) `url`, so a malformed page never reaches the database.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const session = locals.session;
  if (!session) return json({ ok: false, error: 'authentication required' }, 401);

  const parsed = parseLinkQuery(url.searchParams.get('url'));
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  try {
    const card = await findCardByApplyUrl(parsed.value);
    return json({ ok: true, card });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
};
