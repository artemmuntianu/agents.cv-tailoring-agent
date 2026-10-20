import { createApi } from '@reduxjs/toolkit/query/react';
import type { CoverLetterState } from '../../lib/types';
import { baseQuery, JSON_HEADERS } from '../api/baseQuery';
import type { WriteResult } from '../api/types';

export interface CoverVacancy {
  jobId: string;
  source: string;
  externalId: string;
  title: string;
  company: string;
  sourceUrl: string | null;
  hasDescription: boolean;
}

export interface CoverPayload extends CoverLetterState {
  vacancy: CoverVacancy | null;
}

/** One vacancy's cover letter: read it and ask the worker for it. */
export const coverApi = createApi({
  reducerPath: 'coverApi',
  baseQuery,
  endpoints: (build) => ({
    getCover: build.query<CoverPayload, string>({
      query: (jobId) => `/api/cover/${encodeURIComponent(jobId)}`,
    }),
    askCover: build.mutation<WriteResult, string>({
      query: (jobId) => ({
        url: `/api/cover/${encodeURIComponent(jobId)}`,
        method: 'POST',
        headers: JSON_HEADERS,
      }),
    }),
  }),
});

export const { useGetCoverQuery, useAskCoverMutation } = coverApi;