import { call, delay, put, takeLatest } from 'redux-saga/effects';
import { coverState } from '../../lib/cover';
import { api, errorMessage, redirectToLogin, SessionExpiredError } from '../api/client';
import {
  COVER_ASK_REQUESTED,
  COVER_REQUESTED,
  coverAsking,
  coverFailed,
  coverLoaded,
  type CoverAskRequestedAction,
  type CoverPayload,
  type CoverRequestedAction,
} from './slice';

/** The page's cadence and its giving-up point (the queue is where a stuck letter shows). */
export const COVER_POLL_MS = 3000;
export const COVER_DEADLINE_MS = 3 * 60 * 1000;

function pending(payload: CoverPayload | null): boolean {
  const state = coverState(payload);
  return state === 'queued' || state === 'running';
}

export function* fetchCoverSaga(jobId: string): Generator<any, CoverPayload | null, any> {
  try {
    const payload = yield call(api.getCover, jobId);
    yield put(coverLoaded(payload));
    return payload;
  } catch (cause) {
    if (cause instanceof SessionExpiredError) {
      yield call(redirectToLogin, `/cover/${encodeURIComponent(jobId)}`);
      return null;
    }
    yield put(coverFailed(errorMessage(cause)));
    return null;
  }
}

/** While the worker has it, this page is the only thing that will notice it landing. */
export function* pollCoverSaga(jobId: string): Generator<any, void, any> {
  const started = Date.now();
  while (true) {
    yield delay(COVER_POLL_MS);
    if (Date.now() - started > COVER_DEADLINE_MS) return;
    const payload = yield call(fetchCoverSaga, jobId);
    if (payload && !pending(payload)) return;
  }
}

export function* coverRequestedSaga(action: CoverRequestedAction): Generator<any, void, any> {
  const payload = yield call(fetchCoverSaga, action.jobId);
  if (payload && pending(payload)) yield call(pollCoverSaga, action.jobId);
}

export function* askCoverSaga(action: CoverAskRequestedAction): Generator<any, void, any> {
  yield put(coverAsking(true));
  try {
    yield call(api.askCover, action.jobId);
    const payload = yield call(fetchCoverSaga, action.jobId);
    if (payload && pending(payload)) yield call(pollCoverSaga, action.jobId);
  } catch (cause) {
    if (cause instanceof SessionExpiredError) {
      yield call(redirectToLogin, `/cover/${encodeURIComponent(action.jobId)}`);
    } else {
      yield put(coverFailed(errorMessage(cause)));
    }
  } finally {
    yield put(coverAsking(false));
  }
}

export default function* coverSaga(): Generator<any, void, any> {
  yield takeLatest(COVER_REQUESTED, coverRequestedSaga);
  yield takeLatest(COVER_ASK_REQUESTED, askCoverSaga);
}