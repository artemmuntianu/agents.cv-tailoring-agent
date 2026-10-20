import { createSelector } from 'reselect';
import type { BoardCard, StageId } from '../../lib/types';
import { selectCardMap } from '../board/selectors';
import type { RootState } from '../store';

export interface PendingMoveCard {
  card: BoardCard;
  to: StageId;
}

export const selectOpenId = (state: RootState) => state.dialogs.openId;

export const selectOpenCard = createSelector([selectCardMap, selectOpenId], (cards, openId) =>
  openId ? (cards[openId] ?? null) : null,
);

export const selectPendingMove = createSelector(
  [selectCardMap, (state: RootState) => state.dialogs.pendingMove],
  (cards, pending): PendingMoveCard | null => {
    if (!pending) return null;
    const card = cards[pending.jobId];
    return card ? { card, to: pending.to } : null;
  },
);

export const selectPendingActionCard = createSelector(
  [selectCardMap, (state: RootState) => state.dialogs.pendingAction],
  (cards, jobId) => (jobId ? (cards[jobId] ?? null) : null),
);

export const selectPendingArchiveCard = createSelector(
  [selectCardMap, (state: RootState) => state.dialogs.pendingArchive],
  (cards, jobId) => (jobId ? (cards[jobId] ?? null) : null),
);

export const selectPendingRemovalCard = createSelector(
  [selectCardMap, (state: RootState) => state.dialogs.pendingRemoval],
  (cards, jobId) => (jobId ? (cards[jobId] ?? null) : null),
);