/**
 * What the card face says about the *vacancy* rather than about the application: which site the
 * intake found it on, and how long ago it last moved.
 *
 * Both are display vocabularies over values someone else owns, which is why they live here and
 * not inside the component: the site is `resumes.source` (part of the worker's business key -
 * two sites number their vacancies independently, so the slug the board stores is `djinni`, not
 * "Djinni") and the stamp is `resume_board.updated_at`, the board's own activity clock that every
 * move, archive, restore and recorded action bumps (`apps/worker/archiver/AGENTS.md`). Deliberately **not**
 * `resumes.updated_at`: the worker writes status changes there, so a tailoring run would look
 * like operator activity.
 *
 * The recency rule is the point of this module. A card that moved within the last
 * `RELATIVE_DAYS` reads as a distance ("9 days ago"), because that is the question the card is
 * actually asked - is this still warm? - and one parked longer reads as the date it happened,
 * because nobody converts "43 days ago" back into a day. The two ends the boundary hides
 * (`0 days ago`, `1 days ago`) are spelled out instead.
 */

/** Days a card is dated by distance; past this it shows the date itself. */
export const RELATIVE_DAYS = 9;

/**
 * The `resumes.source` slugs in use today. `scout` produces the first two from its feeds
 * (`apps/worker/scout/sources.py`), and the extension's site registry
 * (`apps/extension/src/sites/index.js`, one plugin per site) produces the rest from the host of the
 * page it is injected into. `indeed` is the browser scrape's alone: Indeed serves no feed at all
 * (`/rss` is gone and `robots.txt` disallows it), so no parser can ever emit that slug.
 * `teamtailor` is the same shape from the other end: an employer's ATS page reached from a card's
 * Application URL, where the browser's *form filler* is the only producer - such a page renders no
 * cards, so no scrape can originate from it.
 */
const SOURCE_LABELS: Record<string, string> = {
  djinni: 'Djinni',
  dou: 'DOU',
  greenhouse: 'Greenhouse',
  indeed: 'Indeed',
  teamtailor: 'Teamtailor',
};

/**
 * The slugs the map above names, in declaration order - every site the intake can stamp today.
 *
 * Derived from the map rather than repeated: `lib/manual.ts` suggests exactly these plus its "not
 * listed" slug when the operator types a vacancy in by hand, so a new site is one entry in this
 * map and nothing else. The list stays outside `SOURCE_LABELS` on purpose - the `other` fallback
 * is deliberately absent from the labels, so it cannot leak into a suggestion list by accident.
 */
export const SOURCE_SLUGS: string[] = Object.keys(SOURCE_LABELS);

/**
 * The name of the site a vacancy came from.
 *
 * An unlisted slug is echoed as it is rather than prettified: the scraper derives a stable slug
 * from *any* host it runs on, and inventing a name for a site nobody configured would read as a
 * fact the board does not have.
 */
export function sourceLabel(slug: string): string {
  const key = (slug || '').trim().toLowerCase();
  if (!key) return 'unknown site';
  return SOURCE_LABELS[key] ?? key;
}

/** The card face's plain date, for anything too old to read as a distance. */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * How to read one card's change stamp: `today`, `yesterday`, `9 days ago`, then the date itself.
 *
 * `now` is a parameter so the rule is testable and so a list rendered in one pass dates every
 * card against a single instant.
 */
export function updatedLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';

  const days = calendarDaysBetween(at, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= RELATIVE_DAYS) return `${days} days ago`;
  return shortDate(iso);
}

/**
 * Whole days between two local midnights - the unit these labels are written in, so a card
 * touched at 23:00 reads as "yesterday" at 08:00 the next morning instead of "today".
 *
 * Positive when `at` is in the past. Exported because it is the board's one piece of local-midnight
 * arithmetic: the card's interview line dates calls in the same day (`lib/interviewAgenda.ts`), so
 * "today" must not mean two different things on one card face.
 */
export function calendarDaysBetween(at: Date, now: Date): number {
  const day = 24 * 60 * 60 * 1000;
  return Math.round((startOfDay(now) - startOfDay(at)) / day);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
