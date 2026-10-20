import type { RootState } from '../store';

export const selectAdmin = (state: RootState) => state.admin;
export const selectAdminVocabulary = (state: RootState) => state.admin.vocabulary;
export const selectAdminLoading = (state: RootState) => state.admin.loading;
export const selectAdminBusy = (state: RootState) => state.admin.busy;
export const selectAdminError = (state: RootState) => state.admin.error;
export const selectAdminNote = (state: RootState) => state.admin.note;