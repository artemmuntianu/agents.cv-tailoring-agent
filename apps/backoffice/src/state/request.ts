import type { AppDispatch } from './store';

/** What a saga resolves or rejects the caller's promise with. */
export interface RequestMeta<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * Dispatch an effect and await its outcome. The callbacks ride in `meta`, which no reducer
 * reads - the store is not serialized and this is the one place a component needs an answer
 * (a dialog staying open with the route's message).
 */
export function request<T>(dispatch: AppDispatch, action: { type: string }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    dispatch({ ...action, meta: { resolve, reject } } as never);
  });
}