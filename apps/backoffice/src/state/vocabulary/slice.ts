import type { BoardAction as BoardActionRow } from '../../lib/types';

export interface VocabularyState {
  actions: BoardActionRow[];
  loading: boolean;
}

export const initialVocabularyState: VocabularyState = { actions: [], loading: true };

export const VOCABULARY_REQUESTED = 'vocabulary/requested';
export const VOCABULARY_SUCCEEDED = 'vocabulary/succeeded';
export const VOCABULARY_FAILED = 'vocabulary/failed';

export interface VocabularyRequestedAction { type: typeof VOCABULARY_REQUESTED }
export interface VocabularySucceededAction {
  type: typeof VOCABULARY_SUCCEEDED;
  actions: BoardActionRow[];
}
export interface VocabularyFailedAction { type: typeof VOCABULARY_FAILED }

export type VocabularyAction =
  | VocabularyRequestedAction
  | VocabularySucceededAction
  | VocabularyFailedAction;

export const vocabularyRequested = (): VocabularyRequestedAction => ({ type: VOCABULARY_REQUESTED });
export const vocabularySucceeded = (actions: BoardActionRow[]): VocabularySucceededAction => ({
  type: VOCABULARY_SUCCEEDED,
  actions,
});
export const vocabularyFailed = (): VocabularyFailedAction => ({ type: VOCABULARY_FAILED });

export default function vocabularyReducer(
  state: VocabularyState = initialVocabularyState,
  action: VocabularyAction,
): VocabularyState {
  switch (action.type) {
    case VOCABULARY_SUCCEEDED:
      return { actions: action.actions, loading: false };
    case VOCABULARY_FAILED:
      return { ...state, loading: false };
    default:
      return state;
  }
}