import type {
  BoardCard,
  CommunicationChannel,
  DetailsDraft,
  DetailsRequest,
  VacancyDetails,
} from './types';
import { normalizeApplyUrl, parseApplyUrl, type ParseResult } from './applyUrl';

/**
 * The card's own detail fields: the recruiter, the two salaries, the communication channels and
 * the URL the application is finished on.
 *
 * The channels are a code + DB-CHECK vocabulary exactly like the Actors, the columns and the
 * interview types - the six places this job search actually happens, two of which are the sites
 * the intake scrapes. Everything else here is free text with one length cap, except the
 * application URL, whose shape lives in `lib/applyUrl.ts` because the lookup route
 * (`GET /api/vacancies/link`) has to read it the same way this form writes it. The whole module
 * is pure, so the form, the route and the tests share one definition of "valid".
 */

export const COMMUNICATION_CHANNELS: CommunicationChannel[] = [
  'Email',
  'LinkedIn',
  'WhatsApp',
  'Telegram',
  'Dou',
  'Djinni',
];

export const CHANNEL_HINT: Record<CommunicationChannel, string> = {
  Email: 'the mailbox',
  LinkedIn: 'the social network',
  WhatsApp: 'the phone',
  Telegram: 'the messenger',
  Dou: 'the job board',
  Djinni: 'the job board',
};

/** Longest value the database accepts (`resume_board_details_shape`). */
export const MAX_DETAIL_LENGTH = 200;

/** The five fields as the form holds them: strings, never null. */
export const EMPTY_DETAILS_DRAFT: DetailsDraft = {
  recruiter: '',
  salaryOffered: '',
  salaryDesired: '',
  communicationChannels: [],
  applyUrl: '',
};

export function isCommunicationChannel(value: unknown): value is CommunicationChannel {
  return typeof value === 'string' && (COMMUNICATION_CHANNELS as string[]).includes(value);
}

export type { ParseResult };

function asObject(body: unknown): ParseResult<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  return { ok: true, value: body as Record<string, unknown> };
}

/**
 * Collapse whitespace and treat "nothing" as null - the normalisation the DB CHECK expects
 * (`char_length between 1 and 200`, so `''` would be refused).
 */
export function normalizeText(value: string): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

/** One free-text field: trimmed, `''` -> null, capped like the DB CHECK. */
function parseField(raw: unknown, field: string): ParseResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${field} must be text` };
  const value = normalizeText(raw);
  if (value === null) return { ok: true, value: null };
  if (value.length > MAX_DETAIL_LENGTH) {
    return { ok: false, error: `${field} must be at most ${MAX_DETAIL_LENGTH} characters` };
  }
  return { ok: true, value };
}

/**
 * The channel list: unknown values are refused (the CHECK would refuse them anyway, one whole
 * update at a time), duplicates collapse, and the result keeps the vocabulary's own order so
 * "Email, Dou" always reads the same way.
 */
export function parseChannels(raw: unknown): ParseResult<CommunicationChannel[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'communicationChannels must be a list' };
  for (const item of raw) {
    if (!isCommunicationChannel(item)) {
      return {
        ok: false,
        error: `communicationChannels may only contain: ${COMMUNICATION_CHANNELS.join(', ')}`,
      };
    }
  }
  const wanted = new Set(raw as CommunicationChannel[]);
  return { ok: true, value: COMMUNICATION_CHANNELS.filter((channel) => wanted.has(channel)) };
}


/**
 * Validate a `POST /api/board/details` body - the card's Details form.
 *
 * Every field is optional in the body and `null`/`''` means "clear it", so the form can send all
 * five at once without a diff: the route replaces the row's details with exactly this.
 */
export function parseDetailsRequest(body: unknown): ParseResult<DetailsRequest> {
  const object = asObject(body);
  if (!object.ok) return object;
  const raw = object.value;

  const jobId = typeof raw.jobId === 'string' ? raw.jobId.trim() : '';
  if (!jobId) return { ok: false, error: 'jobId is required' };

  const recruiter = parseField(raw.recruiter, 'recruiter');
  if (!recruiter.ok) return recruiter;
  const salaryOffered = parseField(raw.salaryOffered, 'salaryOffered');
  if (!salaryOffered.ok) return salaryOffered;
  const salaryDesired = parseField(raw.salaryDesired, 'salaryDesired');
  if (!salaryDesired.ok) return salaryDesired;
  const channels = parseChannels(raw.communicationChannels);
  if (!channels.ok) return channels;
  const applyUrl = parseApplyUrl(raw.applyUrl);
  if (!applyUrl.ok) return applyUrl;

  return {
    ok: true,
    value: {
      jobId,
      recruiter: recruiter.value,
      salaryOffered: salaryOffered.value,
      salaryDesired: salaryDesired.value,
      communicationChannels: channels.value,
      applyUrl: applyUrl.value,
    },
  };
}

/**
 * Stored details as the form needs them (null -> `''`).
 *
 * Also what a successful save resets the draft to: `draftToRequest` normalises (collapse
 * whitespace, drop empties) and the request it produces is exactly what the row now holds, so
 * this is the way the form stops looking "dirty" after its own save.
 */
export function draftFromDetails(details: VacancyDetails): DetailsDraft {
  return {
    recruiter: details.recruiter ?? '',
    salaryOffered: details.salaryOffered ?? '',
    salaryDesired: details.salaryDesired ?? '',
    communicationChannels: [...details.communicationChannels],
    applyUrl: details.applyUrl ?? '',
  };
}

/** The details of a card, as the form needs them. */
export function draftFromCard(card: BoardCard): DetailsDraft {
  return draftFromDetails(card.details);
}

/** The draft as the API wants it: trimmed, empties cleared, channels in vocabulary order. */
export function draftToRequest(jobId: string, draft: DetailsDraft): DetailsRequest {
  const parsed = parseDetailsRequest({ ...draft, jobId });
  if (!parsed.ok) {
    // The form only ever builds a valid draft (one capped input per field, a fixed list of
    // channels); a draft that fails here means a caller bypassed `DetailsDraft`.
    throw new Error(parsed.error);
  }
  return parsed.value;
}

/** Two details are equal when all five fields are - the Save button's dirty check. */
export function detailsEqual(a: VacancyDetails, b: VacancyDetails): boolean {
  return (
    (a.recruiter ?? '') === (b.recruiter ?? '') &&
    (a.salaryOffered ?? '') === (b.salaryOffered ?? '') &&
    (a.salaryDesired ?? '') === (b.salaryDesired ?? '') &&
    (a.applyUrl ?? '') === (b.applyUrl ?? '') &&
    a.communicationChannels.length === b.communicationChannels.length &&
    a.communicationChannels.every((channel, index) => b.communicationChannels[index] === channel)
  );
}

/**
 * Whether the form holds something the card does not - the Save button's dirty check.
 *
 * The draft is normalised the same way the request is (`''` -> null, whitespace collapsed, an
 * application URL canonicalised), so typing a trailing space - or pasting the same ATS link with
 * its `?gh_src=…` tail - does not look like a change.
 */
export function detailsChanged(draft: DetailsDraft, current: VacancyDetails): boolean {
  return !detailsEqual(
    {
      recruiter: normalizeText(draft.recruiter),
      salaryOffered: normalizeText(draft.salaryOffered),
      salaryDesired: normalizeText(draft.salaryDesired),
      communicationChannels: draft.communicationChannels,
      applyUrl: normalizeApplyUrl(draft.applyUrl),
    },
    current,
  );
}

/** Add or remove one channel, keeping the vocabulary's order (what the dropdown calls). */
export function toggleChannel(
  channels: CommunicationChannel[],
  channel: CommunicationChannel,
): CommunicationChannel[] {
  const wanted = new Set(channels);
  if (wanted.has(channel)) wanted.delete(channel);
  else wanted.add(channel);
  return COMMUNICATION_CHANNELS.filter((item) => wanted.has(item));
}

/** `Email, Dou` for a tooltip; an empty list reads as "not said yet". */
export function describeChannels(channels: CommunicationChannel[]): string {
  return channels.length > 0 ? channels.join(', ') : 'not said yet';
}
