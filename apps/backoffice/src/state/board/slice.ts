import type {
  ActionRequest,
  ArchiveRequest,
  BoardCard,
  DetailsRequest,
  HistoryEntryRequest,
  InterviewRequest,
  MoveRequest,
} from '../../lib/types';
import type { RequestMeta } from '../request';

export interface BoardState {
  /** Normalised by `jobId`; `order` keeps the server's newest-first list. */
  cards: Record<string, BoardCard>;
  order: string[];
  loading: boolean;
  /** The toolbar's error line; a refused write sets it after the re-read. */
  error: string | null;
  /** The one-line explanation a route returned (a queued cover letter, a purge hint). */
  note: string | null;
  /** Live mode: the 5s poll runs while true. */
  live: boolean;
}

export const initialBoardState: BoardState = {
  cards: {},
  order: [],
  loading: true,
  error: null,
  note: null,
  live: true,
};

export const BOARD_STARTED = 'board/started';
export const BOARD_REQUESTED = 'board/requested';
export const BOARD_LOADING = 'board/loading';
export const BOARD_SUCCEEDED = 'board/succeeded';
export const BOARD_FAILED = 'board/failed';
export const BOARD_ERROR_SET = 'board/errorSet';
export const BOARD_NOTE_SET = 'board/noteSet';
export const BOARD_LIVE_SET = 'board/liveSet';

export interface BoardStartedAction {
  type: typeof BOARD_STARTED;
}
export interface BoardRequestedAction {
  type: typeof BOARD_REQUESTED;
  silent?: boolean;
}
export interface BoardLoadingAction {
  type: typeof BOARD_LOADING;
}
export interface BoardSucceededAction {
  type: typeof BOARD_SUCCEEDED;
  cards: BoardCard[];
}
export interface BoardFailedAction {
  type: typeof BOARD_FAILED;
  error: string;
}
export interface BoardErrorSetAction {
  type: typeof BOARD_ERROR_SET;
  error: string | null;
}
export interface BoardNoteSetAction {
  type: typeof BOARD_NOTE_SET;
  note: string | null;
}
export interface BoardLiveSetAction {
  type: typeof BOARD_LIVE_SET;
  live: boolean;
}

export type BoardAction =
  | BoardStartedAction
  | BoardRequestedAction
  | BoardLoadingAction
  | BoardSucceededAction
  | BoardFailedAction
  | BoardErrorSetAction
  | BoardNoteSetAction
  | BoardLiveSetAction;

export const boardStarted = (): BoardStartedAction => ({ type: BOARD_STARTED });
export const boardRequested = (options: { silent?: boolean } = {}): BoardRequestedAction => ({
  type: BOARD_REQUESTED,
  silent: options.silent,
});
export const boardLoading = (): BoardLoadingAction => ({ type: BOARD_LOADING });
export const boardSucceeded = (cards: BoardCard[]): BoardSucceededAction => ({
  type: BOARD_SUCCEEDED,
  cards,
});
export const boardFailed = (error: string): BoardFailedAction => ({ type: BOARD_FAILED, error });
export const boardErrorSet = (error: string | null): BoardErrorSetAction => ({
  type: BOARD_ERROR_SET,
  error,
});
export const boardNoteSet = (note: string | null): BoardNoteSetAction => ({
  type: BOARD_NOTE_SET,
  note,
});
export const boardLiveSet = (live: boolean): BoardLiveSetAction => ({ type: BOARD_LIVE_SET, live });

export const BOARD_MOVE_CONFIRMED = 'board/moveConfirmed';
export const BOARD_ACTION_CONFIRMED = 'board/actionConfirmed';
export const BOARD_ARCHIVE_CONFIRMED = 'board/archiveConfirmed';
export const BOARD_RESTORE_REQUESTED = 'board/restoreRequested';
export const BOARD_REMOVE_CONFIRMED = 'board/removeConfirmed';
export const INTERVIEW_ADD_REQUESTED = 'board/interviewAddRequested';
export const INTERVIEW_EDIT_REQUESTED = 'board/interviewEditRequested';
export const INTERVIEW_REMOVE_REQUESTED = 'board/interviewRemoveRequested';
export const HISTORY_EDIT_REQUESTED = 'board/historyEditRequested';
export const HISTORY_REMOVE_REQUESTED = 'board/historyRemoveRequested';
export const DETAILS_SAVE_REQUESTED = 'board/detailsSaveRequested';
export const DOCX_UPLOAD_REQUESTED = 'board/docxUploadRequested';

export interface BoardMoveConfirmedAction {
  type: typeof BOARD_MOVE_CONFIRMED;
  request: MoveRequest & { interview?: InterviewRequest };
}
export interface BoardActionConfirmedAction {
  type: typeof BOARD_ACTION_CONFIRMED;
  request: ActionRequest;
}
export interface BoardArchiveConfirmedAction {
  type: typeof BOARD_ARCHIVE_CONFIRMED;
  request: ArchiveRequest;
}
export interface BoardRestoreRequestedAction {
  type: typeof BOARD_RESTORE_REQUESTED;
  jobId: string;
}
export interface BoardRemoveConfirmedAction {
  type: typeof BOARD_REMOVE_CONFIRMED;
  jobId: string;
}
export interface InterviewAddRequestedAction {
  type: typeof INTERVIEW_ADD_REQUESTED;
  jobId: string;
  request: InterviewRequest;
  meta?: RequestMeta;
}
export interface InterviewEditRequestedAction {
  type: typeof INTERVIEW_EDIT_REQUESTED;
  id: number;
  request: InterviewRequest;
  meta?: RequestMeta;
}
export interface InterviewRemoveRequestedAction {
  type: typeof INTERVIEW_REMOVE_REQUESTED;
  id: number;
  meta?: RequestMeta;
}
export interface HistoryEditRequestedAction {
  type: typeof HISTORY_EDIT_REQUESTED;
  id: number;
  request: HistoryEntryRequest;
  meta?: RequestMeta;
}
export interface HistoryRemoveRequestedAction {
  type: typeof HISTORY_REMOVE_REQUESTED;
  id: number;
  meta?: RequestMeta;
}
export interface DetailsSaveRequestedAction {
  type: typeof DETAILS_SAVE_REQUESTED;
  jobId: string;
  request: DetailsRequest;
  meta?: RequestMeta;
}
export interface DocxUploadRequestedAction {
  type: typeof DOCX_UPLOAD_REQUESTED;
  jobId: string;
  file: File;
  meta?: RequestMeta;
}

export type BoardWriteAction =
  | BoardMoveConfirmedAction
  | BoardActionConfirmedAction
  | BoardArchiveConfirmedAction
  | BoardRestoreRequestedAction
  | BoardRemoveConfirmedAction
  | InterviewAddRequestedAction
  | InterviewEditRequestedAction
  | InterviewRemoveRequestedAction
  | HistoryEditRequestedAction
  | HistoryRemoveRequestedAction
  | DetailsSaveRequestedAction
  | DocxUploadRequestedAction;

export const moveConfirmed = (
  request: MoveRequest & { interview?: InterviewRequest },
): BoardMoveConfirmedAction => ({ type: BOARD_MOVE_CONFIRMED, request });
export const actionConfirmed = (request: ActionRequest): BoardActionConfirmedAction => ({
  type: BOARD_ACTION_CONFIRMED,
  request,
});
export const archiveConfirmed = (request: ArchiveRequest): BoardArchiveConfirmedAction => ({
  type: BOARD_ARCHIVE_CONFIRMED,
  request,
});
export const restoreRequested = (jobId: string): BoardRestoreRequestedAction => ({
  type: BOARD_RESTORE_REQUESTED,
  jobId,
});
export const removeConfirmed = (jobId: string): BoardRemoveConfirmedAction => ({
  type: BOARD_REMOVE_CONFIRMED,
  jobId,
});
export const interviewAddRequested = (
  jobId: string,
  request: InterviewRequest,
  meta?: RequestMeta,
): InterviewAddRequestedAction => ({ type: INTERVIEW_ADD_REQUESTED, jobId, request, meta });
export const interviewEditRequested = (
  id: number,
  request: InterviewRequest,
  meta?: RequestMeta,
): InterviewEditRequestedAction => ({ type: INTERVIEW_EDIT_REQUESTED, id, request, meta });
export const interviewRemoveRequested = (
  id: number,
  meta?: RequestMeta,
): InterviewRemoveRequestedAction => ({ type: INTERVIEW_REMOVE_REQUESTED, id, meta });
export const historyEditRequested = (
  id: number,
  request: HistoryEntryRequest,
  meta?: RequestMeta,
): HistoryEditRequestedAction => ({ type: HISTORY_EDIT_REQUESTED, id, request, meta });
export const historyRemoveRequested = (
  id: number,
  meta?: RequestMeta,
): HistoryRemoveRequestedAction => ({ type: HISTORY_REMOVE_REQUESTED, id, meta });
export const detailsSaveRequested = (
  jobId: string,
  request: DetailsRequest,
  meta?: RequestMeta,
): DetailsSaveRequestedAction => ({ type: DETAILS_SAVE_REQUESTED, jobId, request, meta });
export const docxUploadRequested = (
  jobId: string,
  file: File,
  meta?: RequestMeta,
): DocxUploadRequestedAction => ({ type: DOCX_UPLOAD_REQUESTED, jobId, file, meta });
export default function boardReducer(
  state: BoardState = initialBoardState,
  action: BoardAction,
): BoardState {
  switch (action.type) {
    case BOARD_LOADING:
      return { ...state, loading: true };
    case BOARD_SUCCEEDED: {
      const cards: Record<string, BoardCard> = {};
      const order: string[] = [];
      for (const card of action.cards) {
        cards[card.jobId] = card;
        order.push(card.jobId);
      }
      return { ...state, cards, order, loading: false, error: null };
    }
    case BOARD_FAILED:
      return { ...state, cards: {}, order: [], loading: false, error: action.error };
    case BOARD_ERROR_SET:
      return { ...state, error: action.error };
    case BOARD_NOTE_SET:
      return { ...state, note: action.note };
    case BOARD_LIVE_SET:
      return { ...state, live: action.live };
    default:
      return state;
  }
}