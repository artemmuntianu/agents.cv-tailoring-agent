import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
} from '@reduxjs/toolkit/query/react';
import type { VocabularyKind } from '../lib/admin';
import type {
  ActionRequest,
  ArchiveRequest,
  BoardAction,
  BoardCard,
  CoverLetterState,
  DetailsRequest,
  HistoryEntryRequest,
  InterviewRequest,
  MoveRequest,
} from '../lib/types';

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

export interface AdminVocabulary {
  actions: BoardAction[];
  actors: { value: string; hint: string }[];
  stages: { id: string; label: string; hint: string }[];
  subStates: { id: string; label: string }[];
}

export type WriteResult = { ok: true; note?: string };

const jsonHeaders = { 'content-type': 'application/json' };

const rawBaseQuery = fetchBaseQuery({ baseUrl: '/' });

/** The 8h session expired: send the browser to the login page and come back. */
const baseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args,
  api,
  extraOptions,
) => {
  const result = await rawBaseQuery(args, api, extraOptions);
  if (result.error?.status === 401 && typeof window !== 'undefined') {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }
  return result;
};

export const api = createApi({
  reducerPath: 'api',
  baseQuery,
  endpoints: (build) => ({
    getBoard: build.query<BoardCard[], void>({
      query: () => '/api/board',
      transformResponse: (response: { cards?: BoardCard[] }) => response.cards ?? [],
    }),
    getActions: build.query<BoardAction[], void>({
      query: () => '/api/board/actions',
      transformResponse: (response: { actions?: BoardAction[] }) => response.actions ?? [],
    }),

    move: build.mutation<WriteResult, MoveRequest & { interview?: InterviewRequest }>({
      query: (body) => ({ url: '/api/board/move', method: 'POST', body }),
    }),
    recordAction: build.mutation<WriteResult, ActionRequest>({
      query: (body) => ({ url: '/api/board/action', method: 'POST', body }),
    }),
    archive: build.mutation<WriteResult, ArchiveRequest>({
      query: (body) => ({ url: '/api/board/archive', method: 'POST', body }),
    }),
    restore: build.mutation<WriteResult, string>({
      query: (jobId) => ({ url: '/api/board/restore', method: 'POST', body: { jobId } }),
    }),
    remove: build.mutation<WriteResult, string>({
      query: (jobId) => ({ url: '/api/board/remove', method: 'POST', body: { jobId } }),
    }),

    addInterview: build.mutation<WriteResult, { jobId: string; request: InterviewRequest }>({
      query: ({ jobId, request }) => ({
        url: '/api/board/interviews',
        method: 'POST',
        body: { jobId, ...request },
      }),
    }),
    editInterview: build.mutation<WriteResult, { id: number; request: InterviewRequest }>({
      query: ({ id, request }) => ({
        url: `/api/board/interviews/${id}`,
        method: 'PATCH',
        body: request,
      }),
    }),
    removeInterview: build.mutation<WriteResult, number>({
      query: (id) => ({
        url: `/api/board/interviews/${id}`,
        method: 'DELETE',
        headers: jsonHeaders,
      }),
    }),

    editHistory: build.mutation<WriteResult, { id: number; request: HistoryEntryRequest }>({
      query: ({ id, request }) => ({
        url: `/api/board/history/${id}`,
        method: 'PATCH',
        body: request,
      }),
    }),
    removeHistory: build.mutation<WriteResult, number>({
      query: (id) => ({
        url: `/api/board/history/${id}`,
        method: 'DELETE',
        headers: jsonHeaders,
      }),
    }),

    saveDetails: build.mutation<WriteResult, DetailsRequest>({
      query: (body) => ({ url: '/api/board/details', method: 'POST', body }),
    }),
    uploadDocx: build.mutation<WriteResult, { jobId: string; file: File }>({
      query: ({ jobId, file }) => {
        const form = new FormData();
        form.append('file', file);
        return { url: `/api/board/docx/${encodeURIComponent(jobId)}`, method: 'POST', body: form };
      },
    }),

    getCover: build.query<CoverPayload, string>({
      query: (jobId) => `/api/cover/${encodeURIComponent(jobId)}`,
    }),
    askCover: build.mutation<WriteResult, string>({
      query: (jobId) => ({
        url: `/api/cover/${encodeURIComponent(jobId)}`,
        method: 'POST',
        headers: jsonHeaders,
      }),
    }),

    getAdminVocabulary: build.query<AdminVocabulary, void>({
      query: () => '/api/admin/vocabulary',
    }),
    adminAdd: build.mutation<WriteResult, { value: string; kind: VocabularyKind }>({
      query: (body) => ({ url: '/api/admin/actions', method: 'POST', body }),
    }),
    adminRename: build.mutation<WriteResult, { from: string; to: string }>({
      query: (body) => ({ url: '/api/admin/actions', method: 'PATCH', body }),
    }),
    adminRemove: build.mutation<WriteResult, string>({
      query: (value) => ({
        url: `/api/admin/actions?value=${encodeURIComponent(value)}`,
        method: 'DELETE',
        headers: jsonHeaders,
      }),
    }),
  }),
});

export const {
  useGetBoardQuery,
  useGetActionsQuery,
  useMoveMutation,
  useRecordActionMutation,
  useArchiveMutation,
  useRestoreMutation,
  useRemoveMutation,
  useAddInterviewMutation,
  useEditInterviewMutation,
  useRemoveInterviewMutation,
  useEditHistoryMutation,
  useRemoveHistoryMutation,
  useSaveDetailsMutation,
  useUploadDocxMutation,
  useGetCoverQuery,
  useAskCoverMutation,
  useGetAdminVocabularyQuery,
  useAdminAddMutation,
  useAdminRenameMutation,
  useAdminRemoveMutation,
} = api;