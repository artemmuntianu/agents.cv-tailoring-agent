import { createSelector } from 'reselect';
import { countArchived, countByStage } from '../../lib/board';
import { filterCards } from '../../lib/filters';
import type { BoardCard } from '../../lib/types';
import type { RootState } from '../store';

export const selectBoardState = (state: RootState) => state.board;
export const selectCardMap = (state: RootState) => state.board.cards;
export const selectCardOrder = (state: RootState) => state.board.order;
export const selectBoardLoading = (state: RootState) => state.board.loading;
export const selectBoardError = (state: RootState) => state.board.error;
export const selectBoardNote = (state: RootState) => state.board.note;
export const selectLive = (state: RootState) => state.board.live;
export const selectFilters = (state: RootState) => state.filters;

/** The server's newest-first order, resolved against the normalised map. */
export const selectCards = createSelector([selectCardMap, selectCardOrder], (cards, order) =>
  order.map((jobId) => cards[jobId]).filter((card): card is BoardCard => Boolean(card)),
);

export const selectVisibleCards = createSelector([selectCards, selectFilters], (cards, filters) =>
  filterCards(cards, filters),
);

export const selectColumnCounts = createSelector([selectVisibleCards], countByStage);
export const selectArchivedCount = createSelector([selectVisibleCards], countArchived);
export const selectCardCount = (state: RootState) => state.board.order.length;

export const selectCardById = (state: RootState, jobId: string | null): BoardCard | null =>
  jobId ? (state.board.cards[jobId] ?? null) : null;