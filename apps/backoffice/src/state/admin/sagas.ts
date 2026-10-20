import { call, put, takeLatest } from 'redux-saga/effects';
import { api, errorMessage, redirectToLogin, SessionExpiredError } from '../api/client';
import type { RequestMeta } from '../request';
import {
  ADMIN_ADD_REQUESTED,
  ADMIN_LOAD_REQUESTED,
  ADMIN_REMOVE_REQUESTED,
  ADMIN_RENAME_REQUESTED,
  adminBusy,
  adminFailed,
  adminLoaded,
  adminResult,
  type AdminAddRequestedAction,
  type AdminRemoveRequestedAction,
  type AdminRenameRequestedAction,
  type AdminVocabulary,
} from './slice';

export function* fetchAdminSaga(): Generator<any, AdminVocabulary | null, any> {
  try {
    const payload = yield call(api.getAdminVocabulary);
    const vocabulary: AdminVocabulary = {
      actions: payload.actions ?? [],
      actors: payload.actors ?? [],
      stages: payload.stages ?? [],
      subStates: payload.subStates ?? [],
    };
    yield put(adminLoaded(vocabulary));
    return vocabulary;
  } catch (cause) {
    if (cause instanceof SessionExpiredError) {
      yield call(redirectToLogin, '/admin');
      return null;
    }
    yield put(adminFailed(errorMessage(cause)));
    return null;
  }
}

/** One write, then a re-read: the database is the display here too. */
export function* adminMutationSaga(
  send: () => Promise<unknown>,
  successNote: string,
  meta?: RequestMeta<boolean>,
): Generator<any, void, any> {
  yield put(adminBusy(true));
  let failure: string | null = null;
  try {
    yield call(send);
  } catch (cause) {
    if (cause instanceof SessionExpiredError) {
      yield call(redirectToLogin, '/admin');
    }
    failure = errorMessage(cause);
  }
  yield call(fetchAdminSaga);
  yield put(adminBusy(false));
  yield put(adminResult(failure, failure ? null : successNote));
  meta?.resolve(failure === null);
}

export function* addSaga(action: AdminAddRequestedAction): Generator<any, void, any> {
  yield call(
    adminMutationSaga,
    () => api.adminAdd(action.value, action.kind),
    `Added “${action.value}”.`,
    action.meta,
  );
}

export function* renameSaga(action: AdminRenameRequestedAction): Generator<any, void, any> {
  yield call(
    adminMutationSaga,
    () => api.adminRename(action.from, action.to),
    `“${action.from}” is now “${action.to}”.`,
    action.meta,
  );
}

export function* removeSaga(action: AdminRemoveRequestedAction): Generator<any, void, any> {
  yield call(
    adminMutationSaga,
    () => api.adminRemove(action.value),
    `Removed “${action.value}”.`,
    action.meta,
  );
}

export default function* adminSaga(): Generator<any, void, any> {
  yield takeLatest(ADMIN_LOAD_REQUESTED, fetchAdminSaga);
  yield takeLatest(ADMIN_ADD_REQUESTED, addSaga);
  yield takeLatest(ADMIN_RENAME_REQUESTED, renameSaga);
  yield takeLatest(ADMIN_REMOVE_REQUESTED, removeSaga);
}