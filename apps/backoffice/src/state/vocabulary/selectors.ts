import type { RootState } from '../store';

export const selectVocabulary = (state: RootState) => state.vocabulary;
export const selectActions = (state: RootState) => state.vocabulary.actions;
export const selectVocabularyLoading = (state: RootState) => state.vocabulary.loading;