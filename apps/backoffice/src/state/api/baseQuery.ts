import {
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
} from '@reduxjs/toolkit/query/react';

/** Every body-less non-GET still needs a content-type (Astro's `checkOrigin`). */
export const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const rawBaseQuery = fetchBaseQuery({ baseUrl: '/' });

/** The 8h session expired: send the browser to the login page and come back. */
export const baseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
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