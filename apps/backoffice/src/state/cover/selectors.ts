import type { RootState } from '../store';

export const selectCover = (state: RootState) => state.cover;
export const selectCoverPayload = (state: RootState) => state.cover.payload;
export const selectCoverError = (state: RootState) => state.cover.error;
export const selectCoverLoading = (state: RootState) => state.cover.loading;
export const selectCoverAsking = (state: RootState) => state.cover.asking;