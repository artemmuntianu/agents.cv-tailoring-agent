/**
 * The manual-add contract: a vacancy the operator types in by hand.
 *
 * There is deliberately no second intake. This module builds **the gateway's own payload**
 * (`lib/vacancies.ts` - the exact body the Chrome extension posts) with one vacancy in it, and the
 * page sends it to `POST /api/vacancies/batch`. A hand-typed card is therefore validated,
 * de-duplicated and filed by the same code a scraped one is: same `status = submitted`, same
 * Scraped column, same business key (`lib/ingest.ts`). Nothing downstream can tell the two apart,
 * which is the point - the drag into Prepare, the tailoring and the board's own de-dupe need no
 * special case for a card nobody scraped.
 *
 * What this module owns is the **vacancy id**, the one field the operator does not type. It is
 * half of the business key (`user_id` + `source` + `external_id` + `cv_version`), so it has to
 * exist and be stable: the posting URL is hashed into it, which makes re-adding the same link a
 * *duplicate* rather than a second card. The hash is a plain FNV-1a over the canonical URL rather
 * than `node:crypto`, because a React island imports this module as well as the page around it -
 * and it is a de-duplication key, never a secret.
 *
 * One honest limitation, repeated on the page itself: a hand-added card is **invisible to the
 * scrapers' de-dupe**. They look a vacancy up by the id the *site* publishes, and this one carries
 * a derived id, so scraping the same posting later can file a second card - an ordinary card the
 * operator can remove like any other.
 */

import { normalizeApplyUrl } from './applyUrl';
import type { ParseResult } from './board';
import { SOURCE_SLUGS, sourceLabel } from './cardMeta';
import type { DetailsRequest } from './types';
import { MAX_DESCRIPTION_CHARS, MAX_FIELD_CHARS, SOURCE_SLUG } from './vacancies';

/**
 * The slug a hand-typed vacancy carries when the operator cannot name the site - the same `other`
 * the scrape's own fallback uses (`apps/extension/src/sites/index.js::GENERIC`), so one card face
 * and one de-dupe bucket serve both intakes.
 */
export const GENERIC_SOURCE = 'other';

/**
 * What the Site field **suggests**: the sites the board already labels, derived from its own map so
 * the two cannot drift - one entry in `cardMeta.ts::SOURCE_LABELS` is a new suggestion here and
 * nothing else. It is a suggestion list, not a vocabulary: the field is a combobox
 * (`<input list>` + `<datalist>`, exactly like the Action field), so the operator can name a site
 * nobody has scraped yet and the card carries *their* slug instead of the `other` fallback.
 * "Other" stays last on purpose - it is the honest answer for a site we cannot name, never the one
 * to reach for first.
 */
export const SOURCE_SUGGESTIONS: { slug: string; label: string }[] = [
  ...SOURCE_SLUGS.map((slug) => ({ slug, label: sourceLabel(slug) })),
  { slug: GENERIC_SOURCE, label: 'Other / not listed' },
];

/** The form's own shape: strings, never null - what the operator has typed so far. */
export interface ManualVacancyDraft {
  title: string;
  company: string;
  /** The job description: the one field the tailoring prompt cannot do without. */
  descriptionRaw: string;
  /** The page the vacancy is published on. Required - the card's id is derived from it. */
  sourceUrl: string;
  /** Where Apply actually lands, when that is a different page. Optional. */
  applyUrl: string;
  /**
   * The site slug (`SOURCE_SUGGESTIONS` are the ones the board already labels; anything the store
   * accepts will do). `''` is "not said", which files the card under `other` - the same fallback
   * the scrape uses for a host it cannot name.
   */
  source: string;
}

export const EMPTY_MANUAL_DRAFT: ManualVacancyDraft = {
  title: '',
  company: '',
  descriptionRaw: '',
  sourceUrl: '',
  applyUrl: '',
  source: '',
};

/** The validated draft: fields trimmed, `applyUrl` canonicalised, the derived id attached. */
export interface ManualVacancy {
  source: string;
  externalId: string;
  title: string;
  company: string;
  descriptionRaw: string;
  sourceUrl: string;
  applyUrl: string | null;
}

/** The longest URL the batch contract and the DB's own column accept. */
const MAX_URL_CHARS = 1000;

function asText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** The slug a typed site is read as: collapsed and lower-cased, `''` staying "not said". */
export function normalizeSourceSlug(raw: string): string {
  return asText(raw).toLowerCase();
}

/**
 * Whether a typed site is one the store accepts - the combobox's live hint.
 *
 * `''` answers `true`: an empty field is the fallback (`other`), not a mistake. The shape is
 * `resumes_source_shape`'s (`lib/vacancies.ts::SOURCE_SLUG`), so a value this says yes to cannot
 * be refused later by the database.
 */
export function isSourceSlug(raw: string): boolean {
  const slug = normalizeSourceSlug(raw);
  return slug === '' || SOURCE_SLUG.test(slug);
}

/**
 * The URL a posting is identified by: origin + path (trailing slash dropped) + **query**.
 *
 * The query is kept, unlike `lib/applyUrl.ts`'s deliberately lossy canonicalisation: a
 * Greenhouse-style board carries the vacancy's own id in it (`?gh_jid=…`, or the embed form's
 * `?token=…`), so dropping it would hash two different postings to one id - and the second one
 * added would look like a duplicate. The fragment goes; it never identifies a posting.
 */
export function canonicalPostingUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return raw.trim();
  }
}

/**
 * The id a hand-typed vacancy is filed under: `m-` plus an FNV-1a hash of its canonical URL.
 *
 * Stable across runs (a re-added link is a duplicate, not a twin) and short enough to read on a
 * card. `Math.imul` keeps the 32-bit multiply exact without a `BigInt`, so the same input gives
 * the same id in the browser and in Node.
 */
export function manualExternalId(sourceUrl: string): string {
  const canonical = canonicalPostingUrl(sourceUrl);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `m-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Validate what the operator typed - the one place "complete enough to tailor" is defined.
 *
 * Pure and shared: the island calls it to say what is missing *before* anything is posted, and
 * the caps and shapes it enforces are the batch contract's own (`lib/vacancies.ts`), so a
 * hand-typed card can never be one the gateway would refuse. The wording is the form's, which is
 * why these checks are not delegated to `parseBatchRequest`'s `vacancies[0].…` messages.
 */
export function parseManualVacancy(draft: ManualVacancyDraft): ParseResult<ManualVacancy> {
  const source = normalizeSourceSlug(draft.source) || GENERIC_SOURCE;
  if (!SOURCE_SLUG.test(source)) {
    return { ok: false, error: `"${source.slice(0, 32)}" is not a site slug` };
  }

  const title = asText(draft.title);
  if (!title) return { ok: false, error: 'a job title is required' };
  if (title.length > MAX_FIELD_CHARS) {
    return { ok: false, error: `the job title must be at most ${MAX_FIELD_CHARS} characters` };
  }

  const company = asText(draft.company);
  if (!company) return { ok: false, error: 'a company is required' };
  if (company.length > MAX_FIELD_CHARS) {
    return { ok: false, error: `the company must be at most ${MAX_FIELD_CHARS} characters` };
  }

  const descriptionRaw =
    typeof draft.descriptionRaw === 'string' ? draft.descriptionRaw.trim() : '';
  if (!descriptionRaw) {
    return { ok: false, error: 'the job description is required - the tailoring prompt reads it' };
  }
  if (descriptionRaw.length > MAX_DESCRIPTION_CHARS) {
    return {
      ok: false,
      error: `the job description is too long (${descriptionRaw.length} characters)`,
    };
  }

  const sourceUrl = asText(draft.sourceUrl);
  if (!sourceUrl) return { ok: false, error: 'a posting URL is required - the card is keyed on it' };
  if (!/^https?:\/\//i.test(sourceUrl)) {
    return { ok: false, error: 'the posting URL must be http(s)' };
  }
  if (sourceUrl.length > MAX_URL_CHARS) {
    return { ok: false, error: `the posting URL must be at most ${MAX_URL_CHARS} characters` };
  }

  const typedApply = asText(draft.applyUrl);
  let applyUrl: string | null = null;
  if (typedApply) {
    if (!/^https?:\/\//i.test(typedApply)) {
      return { ok: false, error: 'the application URL must be http(s)' };
    }
    applyUrl = normalizeApplyUrl(typedApply);
    if (!applyUrl) return { ok: false, error: 'the application URL must be http(s)' };
  }

  return {
    ok: true,
    value: {
      source,
      externalId: manualExternalId(sourceUrl),
      title,
      company,
      descriptionRaw,
      sourceUrl,
      applyUrl,
    },
  };
}

/** The `POST /api/vacancies/batch` body for one hand-typed vacancy - the gateway's own contract. */
export function manualBatchBody(vacancy: ManualVacancy): Record<string, unknown> {
  return {
    source: vacancy.source,
    vacancies: [
      {
        external_id: vacancy.externalId,
        title: vacancy.title,
        company: vacancy.company,
        description_raw: vacancy.descriptionRaw,
        source_url: vacancy.sourceUrl,
      },
    ],
  };
}

/**
 * The card's Details request that remembers the application URL, or `null` when none was typed.
 *
 * The application URL is `resume_board.apply_url` - the board's own field, with the board's own
 * route and canonicalisation - so it is not smuggled through the gateway. The other four fields
 * are explicitly empty: the card was just created, it has no details yet, and the route replaces
 * the set.
 */
export function manualApplyDetails(jobId: string, vacancy: ManualVacancy): DetailsRequest | null {
  if (!vacancy.applyUrl) return null;
  return {
    jobId,
    recruiter: null,
    salaryOffered: null,
    salaryDesired: null,
    communicationChannels: [],
    applyUrl: vacancy.applyUrl,
  };
}
