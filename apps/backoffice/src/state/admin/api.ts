import { createApi } from '@reduxjs/toolkit/query/react';
import type { VocabularyKind } from '../../lib/admin';
import type { BoardAction } from '../../lib/types';
import { baseQuery, JSON_HEADERS } from '../api/baseQuery';
import type { WriteResult } from '../api/types';

export interface AdminVocabulary {
  actions: BoardAction[];
  actors: { value: string; hint: string }[];
  stages: { id: string; label: string; hint: string }[];
  subStates: { id: string; label: string }[];
}

/** The vocabulary admin surface: the catalogue and its three writes. */
export const adminApi = createApi({
  reducerPath: 'adminApi',
  baseQuery,
  endpoints: (build) => ({
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
        headers: JSON_HEADERS,
      }),
    }),
  }),
});

export const {
  useGetAdminVocabularyQuery,
  useAdminAddMutation,
  useAdminRenameMutation,
  useAdminRemoveMutation,
} = adminApi;