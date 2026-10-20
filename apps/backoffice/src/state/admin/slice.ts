import type { VocabularyKind } from '../../lib/admin';
import type { BoardAction } from '../../lib/types';
import type { RequestMeta } from '../request';

export interface AdminVocabulary {
  actions: BoardAction[];
  actors: { value: string; hint: string }[];
  stages: { id: string; label: string; hint: string }[];
  subStates: { id: string; label: string }[];
}

export interface AdminState {
  vocabulary: AdminVocabulary | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  note: string | null;
}

export const initialAdminState: AdminState = {
  vocabulary: null,
  loading: true,
  busy: false,
  error: null,
  note: null,
};

export const ADMIN_LOAD_REQUESTED = 'admin/loadRequested';
export const ADMIN_LOADED = 'admin/loaded';
export const ADMIN_FAILED = 'admin/failed';
export const ADMIN_BUSY = 'admin/busy';
export const ADMIN_RESULT = 'admin/result';
export const ADMIN_ADD_REQUESTED = 'admin/addRequested';
export const ADMIN_RENAME_REQUESTED = 'admin/renameRequested';
export const ADMIN_REMOVE_REQUESTED = 'admin/removeRequested';

export interface AdminLoadRequestedAction { type: typeof ADMIN_LOAD_REQUESTED }
export interface AdminLoadedAction { type: typeof ADMIN_LOADED; vocabulary: AdminVocabulary }
export interface AdminFailedAction { type: typeof ADMIN_FAILED; error: string }
export interface AdminBusyAction { type: typeof ADMIN_BUSY; busy: boolean }
export interface AdminResultAction { type: typeof ADMIN_RESULT; error: string | null; note: string | null }
export interface AdminAddRequestedAction {
  type: typeof ADMIN_ADD_REQUESTED;
  value: string;
  kind: VocabularyKind;
  meta?: RequestMeta<boolean>;
}
export interface AdminRenameRequestedAction {
  type: typeof ADMIN_RENAME_REQUESTED;
  from: string;
  to: string;
  meta?: RequestMeta<boolean>;
}
export interface AdminRemoveRequestedAction {
  type: typeof ADMIN_REMOVE_REQUESTED;
  value: string;
  meta?: RequestMeta<boolean>;
}

export type AdminAction =
  | AdminLoadRequestedAction
  | AdminLoadedAction
  | AdminFailedAction
  | AdminBusyAction
  | AdminResultAction
  | AdminAddRequestedAction
  | AdminRenameRequestedAction
  | AdminRemoveRequestedAction;

export const adminLoadRequested = (): AdminLoadRequestedAction => ({ type: ADMIN_LOAD_REQUESTED });
export const adminLoaded = (vocabulary: AdminVocabulary): AdminLoadedAction => ({
  type: ADMIN_LOADED,
  vocabulary,
});
export const adminFailed = (error: string): AdminFailedAction => ({ type: ADMIN_FAILED, error });
export const adminBusy = (busy: boolean): AdminBusyAction => ({ type: ADMIN_BUSY, busy });
export const adminResult = (error: string | null, note: string | null): AdminResultAction => ({
  type: ADMIN_RESULT,
  error,
  note,
});
export const adminAddRequested = (
  value: string,
  kind: VocabularyKind,
  meta?: RequestMeta<boolean>,
): AdminAddRequestedAction => ({ type: ADMIN_ADD_REQUESTED, value, kind, meta });
export const adminRenameRequested = (
  from: string,
  to: string,
  meta?: RequestMeta<boolean>,
): AdminRenameRequestedAction => ({ type: ADMIN_RENAME_REQUESTED, from, to, meta });
export const adminRemoveRequested = (
  value: string,
  meta?: RequestMeta<boolean>,
): AdminRemoveRequestedAction => ({ type: ADMIN_REMOVE_REQUESTED, value, meta });

export default function adminReducer(state: AdminState = initialAdminState, action: AdminAction): AdminState {
  switch (action.type) {
    case ADMIN_LOADED:
      return { ...state, vocabulary: action.vocabulary, loading: false, error: null };
    case ADMIN_FAILED:
      return { ...state, loading: false, error: action.error };
    case ADMIN_BUSY:
      return { ...state, busy: action.busy };
    case ADMIN_RESULT:
      return { ...state, error: action.error, note: action.note };
    default:
      return state;
  }
}