import type { BoardCard } from '../../lib/types';

/** The smallest complete card the state tests need. */
export function card(jobId: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    jobId,
    externalId: jobId.split('-')[0] ?? jobId,
    source: 'dou',
    title: `Vacancy ${jobId}`,
    company: 'Acme',
    sourceUrl: null,
    cvVersion: 'v1',
    status: 'completed',
    attempts: 1,
    revisionCount: 1,
    durationMs: 1000,
    error: null,
    pdfUrl: null,
    docxPath: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
    stage: 'scraped',
    archivedAt: null,
    archivedActor: null,
    archivedReason: null,
    archived: false,
    artifactAvailability: { pdf: false, docx: false },
    coverLetter: null,
    docxUpdate: null,
    hasDescription: true,
    history: [],
    details: {
      recruiter: null,
      salaryOffered: null,
      salaryDesired: null,
      communicationChannels: [],
      applyUrl: null,
    },
    interviews: [],
    ...overrides,
  };
}