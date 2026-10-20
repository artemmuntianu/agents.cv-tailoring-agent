import { all, call, cancel, delay, fork, put, select, take, takeLatest } from 'redux-saga/effects';
import type { BoardCard } from '../../lib/types';
import { api, errorMessage, redirectToLogin, SessionExpiredError, toError } from '../api/client';
import { isDocumentVisible, readCardQuery, windowEventsChannel } from '../events';
import { dialogOpened, dialogsClosed } from '../dialogs/slice';
import { selectOpenId } from '../dialogs/selectors';
import type { RequestMeta } from '../request';
import { vocabularyFailed, vocabularySucceeded, VOCABULARY_REQUESTED } from '../vocabulary/slice';
import {
  BOARD_ACTION_CONFIRMED,
  BOARD_ARCHIVE_CONFIRMED,
  BOARD_LIVE_SET,
  BOARD_MOVE_CONFIRMED,
  BOARD_REMOVE_CONFIRMED,
  BOARD_REQUESTED,
  BOARD_RESTORE_REQUESTED,
  BOARD_STARTED,
  BOARD_SUCCEEDED,
  DETAILS_SAVE_REQUESTED,
  DOCX_UPLOAD_REQUESTED,
  HISTORY_EDIT_REQUESTED,
  HISTORY_REMOVE_REQUESTED,
  INTERVIEW_ADD_REQUESTED,
  INTERVIEW_EDIT_REQUESTED,
  INTERVIEW_REMOVE_REQUESTED,
  boardErrorSet,
  boardFailed,
  boardLoading,
  boardNoteSet,
  boardRequested,
  boardSucceeded,
  type BoardActionConfirmedAction,
  type BoardArchiveConfirmedAction,
  type BoardLiveSetAction,
  type BoardMoveConfirmedAction,
  type BoardRemoveConfirmedAction,
  type BoardRequestedAction,
  type BoardRestoreRequestedAction,
  type BoardSucceededAction,
  type DetailsSaveRequestedAction,
  type DocxUploadRequestedAction,
  type HistoryEditRequestedAction,
  type HistoryRemoveRequestedAction,
  type InterviewAddRequestedAction,
  type InterviewEditRequestedAction,
  type InterviewRemoveRequestedAction,
} from './slice';

/** How often live mode re-reads the board (ms) - the same cadence as the old effect. */
export const LIVE_INTERVAL_MS = 5000;

export function* fetchVocabularySaga(): Generator<any, void, any> {
  try {
    const payload = yield call(api.getActions);
    yield put(vocabularySucceeded(payload.actions ?? []));
  } catch {
    // The board still works without suggestions: the Action field stays free text.
    yield put(vocabularyFailed());
  }
}

/**
 * One read. `silent` keeps the toolbar from flipping to `Loading…` on a poll; the
 * database remains the display, so a failure clears the cards exactly as the old
 * `refresh()` did.
 */
export function* fetchBoardSaga(
  action: Partial<BoardRequestedAction> = {},
): Generator<any, BoardCard[] | null, any> {
  if (!action.silent) yield put(boardLoading());
  try {
    const payload = yield call(api.getBoard);
    const cards = payload.cards ?? [];
    yield put(boardSucceeded(cards));
    return cards;
  } catch (cause) {
    if (cause instanceof SessionExpiredError) {
      yield call(redirectToLogin, '/');
      return null;
    }
    yield put(boardFailed(errorMessage(cause)));
    return null;
  }
}

/** The extension's `Scraped` link lands on `/?card=<job_id>`. */
export function* deepLinkSaga(action: BoardSucceededAction): Generator<any, void, any> {
  const openId = yield select(selectOpenId);
  if (openId) return;
  const requested = readCardQuery();
  if (requested && action.cards.some((card) => card.jobId === requested)) {
    yield put(dialogOpened(requested));
  }
}

/** One live-mode tick: a background tab has no reader, so it costs no query. */
export function* pollSaga(): Generator<any, never, any> {
  while (true) {
    yield delay(LIVE_INTERVAL_MS);
    if (isDocumentVisible()) yield put(boardRequested({ silent: true }));
  }
}

/** Live mode is a fork that the toggle starts and cancels - never a second interval. */
export function* liveWatcher(): Generator<any, void, any> {
  let task = yield fork(pollSaga);
  while (true) {
    const action: BoardLiveSetAction = yield take(BOARD_LIVE_SET);
    if (action.live && !task) task = yield fork(pollSaga);
    if (!action.live && task) {
      yield cancel(task);
      task = null;
    }
  }
}

/** `focus`/`visibilitychange`: a scrape in another tab shows up as soon as this one is read. */
export function* focusWatcher(): Generator<any, void, any> {
  const channel = yield call(windowEventsChannel);
  try {
    while (true) {
      yield take(channel);
      yield put(boardRequested({ silent: true }));
    }
  } finally {
    channel.close();
  }
}

/** The island mounted: read once, then keep live/focus effects running. */
export function* boardStartedSaga(): Generator<any, void, any> {
  yield all([call(fetchBoardSaga, { silent: false }), call(fetchVocabularySaga)]);
  yield fork(liveWatcher);
  yield fork(focusWatcher);
}

/**
 * The board-level write contract: POST, re-read the board and the vocabulary, and only then
 * report the failure - so the database is the display. `note` is the route's own explanation
 * (a queued cover letter, an artifact-purge command).
 */
export function* mutateSaga(send: () => Promise<unknown>): Generator<any, unknown, any> {
  yield put(boardNoteSet(null));
  let failure: string | null = null;
  let payload: unknown = null;
  try {
    payload = yield call(send);
  } catch (cause) {
    if (cause instanceof SessionExpiredError) {
      yield call(redirectToLogin, '/');
      return null;
    }
    failure = errorMessage(cause);
  }
  yield call(fetchBoardSaga, { silent: false });
  yield call(fetchVocabularySaga);
  if (failure) yield put(boardErrorSet(failure));
  return payload;
}

/** The route's note, when it has one. */
function* announceNote(payload: unknown): Generator<any, void, any> {
  const note = payload && typeof payload === 'object' ? (payload as { note?: unknown }).note : null;
  if (typeof note === 'string' && note) yield put(boardNoteSet(note));
}

/**
 * A card-scoped write (interview, history, details, docx). Unlike `mutateSaga` it reports the
 * failure to the caller, so the card's own control stays open with the message; it still
 * re-reads the board, because the database is the display.
 */
export function* cardWriteSaga(
  send: () => Promise<unknown>,
  meta?: RequestMeta,
): Generator<any, void, any> {
  try {
    const payload = yield call(send);
    yield call(fetchBoardSaga, { silent: false });
    meta?.resolve(payload);
  } catch (cause) {
    if (cause instanceof SessionExpiredError) {
      yield call(redirectToLogin, '/');
    }
    meta?.reject(toError(cause));
  }
}

export function* moveSaga(action: BoardMoveConfirmedAction): Generator<any, void, any> {
  yield put(dialogsClosed());
  const result = yield call(mutateSaga, () => api.move(action.request));
  yield call(announceNote, result);
}

export function* actionSaga(action: BoardActionConfirmedAction): Generator<any, void, any> {
  yield put(dialogsClosed());
  yield call(mutateSaga, () => api.recordAction(action.request));
}

export function* archiveSaga(action: BoardArchiveConfirmedAction): Generator<any, void, any> {
  yield put(dialogsClosed());
  yield call(mutateSaga, () => api.archive(action.request));
}

export function* restoreSaga(action: BoardRestoreRequestedAction): Generator<any, void, any> {
  yield call(mutateSaga, () => api.restore(action.jobId));
}

export function* removeSaga(action: BoardRemoveConfirmedAction): Generator<any, void, any> {
  yield put(dialogsClosed());
  const result = yield call(mutateSaga, () => api.remove(action.jobId));
  yield call(announceNote, result);
}

export function* interviewAddSaga(action: InterviewAddRequestedAction): Generator<any, void, any> {
  yield call(cardWriteSaga, () => api.addInterview(action.jobId, action.request), action.meta);
}

export function* interviewEditSaga(action: InterviewEditRequestedAction): Generator<any, void, any> {
  yield call(cardWriteSaga, () => api.editInterview(action.id, action.request), action.meta);
}

export function* interviewRemoveSaga(action: InterviewRemoveRequestedAction): Generator<any, void, any> {
  yield call(cardWriteSaga, () => api.removeInterview(action.id), action.meta);
}

export function* historyEditSaga(action: HistoryEditRequestedAction): Generator<any, void, any> {
  yield call(cardWriteSaga, () => api.editHistory(action.id, action.request), action.meta);
}

export function* historyRemoveSaga(action: HistoryRemoveRequestedAction): Generator<any, void, any> {
  yield call(cardWriteSaga, () => api.removeHistory(action.id), action.meta);
}

export function* detailsSaveSaga(action: DetailsSaveRequestedAction): Generator<any, void, any> {
  yield call(cardWriteSaga, () => api.saveDetails(action.request), action.meta);
}

export function* docxUploadSaga(action: DocxUploadRequestedAction): Generator<any, void, any> {
  yield call(cardWriteSaga, () => api.uploadDocx(action.jobId, action.file), action.meta);
}

export default function* boardSaga(): Generator<any, void, any> {
  yield takeLatest(BOARD_STARTED, boardStartedSaga);
  yield takeLatest(BOARD_REQUESTED, fetchBoardSaga);
  yield takeLatest(VOCABULARY_REQUESTED, fetchVocabularySaga);
  yield takeLatest(BOARD_SUCCEEDED, deepLinkSaga);
  yield takeLatest(BOARD_MOVE_CONFIRMED, moveSaga);
  yield takeLatest(BOARD_ACTION_CONFIRMED, actionSaga);
  yield takeLatest(BOARD_ARCHIVE_CONFIRMED, archiveSaga);
  yield takeLatest(BOARD_RESTORE_REQUESTED, restoreSaga);
  yield takeLatest(BOARD_REMOVE_CONFIRMED, removeSaga);
  yield takeLatest(INTERVIEW_ADD_REQUESTED, interviewAddSaga);
  yield takeLatest(INTERVIEW_EDIT_REQUESTED, interviewEditSaga);
  yield takeLatest(INTERVIEW_REMOVE_REQUESTED, interviewRemoveSaga);
  yield takeLatest(HISTORY_EDIT_REQUESTED, historyEditSaga);
  yield takeLatest(HISTORY_REMOVE_REQUESTED, historyRemoveSaga);
  yield takeLatest(DETAILS_SAVE_REQUESTED, detailsSaveSaga);
  yield takeLatest(DOCX_UPLOAD_REQUESTED, docxUploadSaga);
}