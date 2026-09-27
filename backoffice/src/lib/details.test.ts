import { describe, expect, it } from 'vitest';
import {
  COMMUNICATION_CHANNELS,
  EMPTY_DETAILS_DRAFT,
  MAX_DETAIL_LENGTH,
  describeChannels,
  detailsEqual,
  draftFromDetails,
  draftToRequest,
  isCommunicationChannel,
  parseChannels,
  parseDetailsRequest,
  toggleChannel,
} from './details';
import type { BoardCard, VacancyDetails } from './types';

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    jobId: '374001-1',
    externalId: '374001',
    source: 'dou',
    title: 'Platform Lead',
    company: 'Acme',
    sourceUrl: null,
    cvVersion: 'v1',
    status: 'completed',
    attempts: 1,
    revisionCount: 1,
    durationMs: 12000,
    error: null,
    pdfUrl: null,
    docxPath: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:05:00.000Z',
    stage: 'applied',
    archivedAt: null,
    archivedActor: null,
    archivedReason: null,
    archived: false,
    artifactAvailability: { pdf: false, docx: false },
    coverLetter: null,
    hasDescription: true,
    history: [],
    details: {
      recruiter: null,
      salaryOffered: null,
      salaryDesired: null,
      communicationChannels: [],
    },
    interviews: [],
    ...overrides,
  };
}

const details = (overrides: Partial<VacancyDetails> = {}): VacancyDetails => ({
  recruiter: null,
  salaryOffered: null,
  salaryDesired: null,
  communicationChannels: [],
  ...overrides,
});

describe('the communication channel vocabulary', () => {
  it('is the six values the database CHECK accepts', () => {
    expect(COMMUNICATION_CHANNELS).toEqual([
      'Email',
      'LinkedIn',
      'WhatsApp',
      'Telegram',
      'Dou',
      'Djinni',
    ]);
  });

  it('knows what a channel is', () => {
    expect(isCommunicationChannel('Djinni')).toBe(true);
    expect(isCommunicationChannel('djinni')).toBe(false);
    expect(isCommunicationChannel('Carrier pigeon')).toBe(false);
    expect(isCommunicationChannel(null)).toBe(false);
  });

  it('refuses an unknown value, collapses duplicates and keeps the vocabulary order', () => {
    const parsed = parseChannels(['Dou', 'Email', 'Dou']);
    expect(parsed).toEqual({ ok: true, value: ['Email', 'Dou'] });

    expect(parseChannels(['Email', 'Carrier pigeon']).ok).toBe(false);
    expect(parseChannels(['Email', null]).ok).toBe(false);
    expect(parseChannels('Email').ok).toBe(false);
    expect(parseChannels(undefined)).toEqual({ ok: true, value: [] });
    expect(parseChannels(null)).toEqual({ ok: true, value: [] });
  });

  it('toggles one channel and keeps the order stable', () => {
    expect(toggleChannel([], 'Telegram')).toEqual(['Telegram']);
    expect(toggleChannel(['Telegram'], 'Email')).toEqual(['Email', 'Telegram']);
    expect(toggleChannel(['Email', 'Telegram'], 'Email')).toEqual(['Telegram']);
    expect(describeChannels(['Email', 'Dou'])).toBe('Email, Dou');
    expect(describeChannels([])).toBe('not said yet');
  });
});


describe('parseDetailsRequest (the card Details form)', () => {
  it('accepts all four fields and trims the text', () => {
    const parsed = parseDetailsRequest({
      jobId: '374001-1',
      recruiter: '  Mariia   Melenchuk ',
      salaryOffered: '$5,000',
      salaryDesired: '6000 EUR',
      communicationChannels: ['Email', 'Dou'],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      jobId: '374001-1',
      recruiter: 'Mariia Melenchuk',
      salaryOffered: '$5,000',
      salaryDesired: '6000 EUR',
      communicationChannels: ['Email', 'Dou'],
    });
  });

  it('treats an empty field as "clear it", never as an empty string', () => {
    const parsed = parseDetailsRequest({
      jobId: '374001-1',
      recruiter: '   ',
      salaryOffered: '',
      salaryDesired: null,
      communicationChannels: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.recruiter).toBeNull();
    expect(parsed.value.salaryOffered).toBeNull();
    expect(parsed.value.salaryDesired).toBeNull();
    expect(parsed.value.communicationChannels).toEqual([]);
  });

  it('requires a job id and refuses unknown channels, long text and non-text values', () => {
    expect(parseDetailsRequest({ recruiter: 'x' }).ok).toBe(false);
    expect(parseDetailsRequest(null).ok).toBe(false);
    expect(
      parseDetailsRequest({ jobId: 'a-1', communicationChannels: ['Email', 'Carrier pigeon'] }).ok,
    ).toBe(false);
    expect(
      parseDetailsRequest({ jobId: 'a-1', recruiter: 'x'.repeat(MAX_DETAIL_LENGTH + 1) }).ok,
    ).toBe(false);
    expect(parseDetailsRequest({ jobId: 'a-1', salaryOffered: 5000 }).ok).toBe(false);
  });

  it('keeps a value at exactly the cap', () => {
    const capped = parseDetailsRequest({
      jobId: 'a-1',
      recruiter: 'x'.repeat(MAX_DETAIL_LENGTH),
    });
    expect(capped.ok).toBe(true);
  });
});

describe('the draft the form holds', () => {
  it('starts empty and maps null to an empty input', () => {
    expect(EMPTY_DETAILS_DRAFT).toEqual({
      recruiter: '',
      salaryOffered: '',
      salaryDesired: '',
      communicationChannels: [],
    });
    expect(draftFromDetails(details())).toEqual(EMPTY_DETAILS_DRAFT);
    expect(
      draftFromDetails(details({ recruiter: 'R', communicationChannels: ['Email'] })),
    ).toEqual({
      recruiter: 'R',
      salaryOffered: '',
      salaryDesired: '',
      communicationChannels: ['Email'],
    });
  });

  it('reads a card into the form', () => {
    expect(draftFromDetails(card().details).recruiter).toBe('');
  });

  it('turns a draft into the request, normalising as it goes', () => {
    expect(
      draftToRequest('374001-1', {
        recruiter: '  Mariia  Melenchuk ',
        salaryOffered: '$5,000',
        salaryDesired: '   ',
        communicationChannels: ['Djinni'],
      }),
    ).toEqual({
      jobId: '374001-1',
      recruiter: 'Mariia Melenchuk',
      salaryOffered: '$5,000',
      salaryDesired: null,
      communicationChannels: ['Djinni'],
    });
  });

  it('round-trips: a save leaves the form clean', () => {
    const draft = {
      recruiter: '  Mariia  Melenchuk ',
      salaryOffered: '',
      salaryDesired: '6000 EUR',
      communicationChannels: ['Email', 'Dou'] as ('Email' | 'Dou')[],
    };
    const request = draftToRequest('374001-1', draft);
    // The form resets from the *request* after a save, so the dirty check must come out false.
    const reset = draftFromDetails(request);
    expect(detailsEqual(draftToRequest('374001-1', reset), request)).toBe(true);
  });
});

describe('the dirty check', () => {
  it('is true for any of the four fields', () => {
    const base = details();
    expect(detailsEqual(base, details())).toBe(true);
    expect(detailsEqual(base, details({ recruiter: 'R' }))).toBe(false);
    expect(detailsEqual(base, details({ salaryOffered: '$5' }))).toBe(false);
    expect(detailsEqual(base, details({ salaryDesired: '$6' }))).toBe(false);
    expect(detailsEqual(base, details({ communicationChannels: ['Email'] }))).toBe(false);
  });

  it('compares the channel list positionally (the vocabulary order is canonical)', () => {
    expect(
      detailsEqual(
        details({ communicationChannels: ['Email', 'Dou'] }),
        details({ communicationChannels: ['Email', 'Dou'] }),
      ),
    ).toBe(true);
    expect(
      detailsEqual(
        details({ communicationChannels: ['Email', 'Dou'] }),
        details({ communicationChannels: ['Dou', 'Email'] }),
      ),
    ).toBe(false);
  });
});
