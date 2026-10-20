import type { StageId } from '../../lib/types';

export interface PendingMove {
  jobId: string;
  to: StageId;
}

export interface DialogsState {
  /** The vacancy modal's card. */
  openId: string | null;
  pendingMove: PendingMove | null;
  /** The Add Action dialog's card (a move dialog with no column change). */
  pendingAction: string | null;
  pendingArchive: string | null;
  pendingRemoval: string | null;
}

export const initialDialogsState: DialogsState = {
  openId: null,
  pendingMove: null,
  pendingAction: null,
  pendingArchive: null,
  pendingRemoval: null,
};

export const DIALOG_OPENED = 'dialogs/opened';
export const DIALOG_CLOSED = 'dialogs/closed';
export const MOVE_DIALOG_REQUESTED = 'dialogs/moveRequested';
export const ACTION_DIALOG_REQUESTED = 'dialogs/actionRequested';
export const ARCHIVE_DIALOG_REQUESTED = 'dialogs/archiveRequested';
export const REMOVE_DIALOG_REQUESTED = 'dialogs/removeRequested';
export const DIALOGS_CLOSED = 'dialogs/allClosed';

export interface DialogOpenedAction { type: typeof DIALOG_OPENED; jobId: string }
export interface DialogClosedAction { type: typeof DIALOG_CLOSED }
export interface MoveDialogRequestedAction { type: typeof MOVE_DIALOG_REQUESTED; jobId: string; to: StageId }
export interface ActionDialogRequestedAction { type: typeof ACTION_DIALOG_REQUESTED; jobId: string }
export interface ArchiveDialogRequestedAction { type: typeof ARCHIVE_DIALOG_REQUESTED; jobId: string }
export interface RemoveDialogRequestedAction { type: typeof REMOVE_DIALOG_REQUESTED; jobId: string }
export interface DialogsClosedAction { type: typeof DIALOGS_CLOSED }

export type DialogsAction =
  | DialogOpenedAction
  | DialogClosedAction
  | MoveDialogRequestedAction
  | ActionDialogRequestedAction
  | ArchiveDialogRequestedAction
  | RemoveDialogRequestedAction
  | DialogsClosedAction;

export const dialogOpened = (jobId: string): DialogOpenedAction => ({ type: DIALOG_OPENED, jobId });
export const dialogClosed = (): DialogClosedAction => ({ type: DIALOG_CLOSED });
export const moveDialogRequested = (jobId: string, to: StageId): MoveDialogRequestedAction => ({
  type: MOVE_DIALOG_REQUESTED,
  jobId,
  to,
});
export const actionDialogRequested = (jobId: string): ActionDialogRequestedAction => ({
  type: ACTION_DIALOG_REQUESTED,
  jobId,
});
export const archiveDialogRequested = (jobId: string): ArchiveDialogRequestedAction => ({
  type: ARCHIVE_DIALOG_REQUESTED,
  jobId,
});
export const removeDialogRequested = (jobId: string): RemoveDialogRequestedAction => ({
  type: REMOVE_DIALOG_REQUESTED,
  jobId,
});
export const dialogsClosed = (): DialogsClosedAction => ({ type: DIALOGS_CLOSED });

export default function dialogsReducer(
  state: DialogsState = initialDialogsState,
  action: DialogsAction,
): DialogsState {
  switch (action.type) {
    case DIALOG_OPENED:
      return { ...state, openId: action.jobId };
    case DIALOG_CLOSED:
      return { ...state, openId: null };
    case MOVE_DIALOG_REQUESTED:
      return { ...state, openId: null, pendingMove: { jobId: action.jobId, to: action.to } };
    case ACTION_DIALOG_REQUESTED:
      return { ...state, openId: null, pendingAction: action.jobId };
    case ARCHIVE_DIALOG_REQUESTED:
      return { ...state, openId: null, pendingArchive: action.jobId };
    case REMOVE_DIALOG_REQUESTED:
      return { ...state, openId: null, pendingRemoval: action.jobId };
    case DIALOGS_CLOSED:
      return { ...initialDialogsState };
    default:
      return state;
  }
}