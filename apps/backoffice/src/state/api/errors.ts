import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';

/** Turn an RTK Query error into the one line the operator sees. */
export function errorMessage(error: unknown): string {
  if (error == null) return 'request failed';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;

  if (typeof error === 'object' && 'data' in error) {
    const data = (error as FetchBaseQueryError & { data?: unknown }).data;
    if (typeof data === 'string') return data;
    if (data && typeof data === 'object' && 'error' in data) {
      const message = (data as { error?: unknown }).error;
      if (typeof message === 'string' && message) return message;
    }
  }

  if (typeof error === 'object' && 'status' in error) {
    const status = (error as FetchBaseQueryError).status;
    return typeof status === 'number' ? `HTTP ${status}` : String(status);
  }

  return String(error);
}