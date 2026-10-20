import { createApi } from '@reduxjs/toolkit/query/react';
import type {
  ActionRequest,
  ArchiveRequest,
  BoardAction,
  BoardCard,
  DetailsRequest,
  HistoryEntryRequest,
  InterviewRequest,
  MoveRequest,
} from '../../lib/types';
import { baseQuery, JSON_HEADERS } from '../api/baseQuery';
import type { WriteResult } from '../api/types';

/** The board's server state: cards, the Action catalogue and every card write. */
export const boardApi = createApi({
  reducerPath: 'boardApi',
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
        headers: JSON_HEADERS,
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
        headers: JSON_HEADERS,
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
} = boardApi;