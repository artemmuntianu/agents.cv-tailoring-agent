import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, activeFilterCount } from '../lib/filters';
import { makeStore } from './store';
import boardReducer, { boardFailed, boardSucceeded, initialBoardState } from './board/slice';
import { selectArchivedCount, selectCardById, selectColumnCounts, selectVisibleCards } from './board/selectors';
import filtersReducer, { toggleAction, toggleStage } from './filters/slice';
import dialogsReducer, { dialogOpened, initialDialogsState, moveDialogRequested } from './dialogs/slice';
import { selectOpenCard, selectPendingMove } from './dialogs/selectors';
import { card } from './board/fixtures';

function storeWith(cards = [card('a'), card('b')]) {
  const map: Record<string, ReturnType<typeof card>> = {};
  for (const item of cards) map[item.jobId] = item;
  return makeStore({
    board: { ...initialBoardState, cards: map, order: cards.map((item) => item.jobId), loading: false },
    filters: DEFAULT_FILTERS,
    dialogs: initialDialogsState,
  });
}

describe('the client store', () => {
  it('is one store per island', () => {
    expect(makeStore()).not.toBe(makeStore());
  });

  it('normalises cards and clears them when the read fails', () => {
    const loaded = boardReducer(initialBoardState, boardSucceeded([card('b'), card('a')]));
    expect(loaded.order).toEqual(['b', 'a']);
    expect(loaded.cards.b.title).toBe('Vacancy b');

    const failed = boardReducer(loaded, boardFailed('boom'));
    expect(failed.cards).toEqual({});
    expect(failed.error).toBe('boom');
  });

  it('filters and counts the visible cards', () => {
    const state = storeWith([card('a'), card('b', { archived: true, stage: 'prepare' })]).getState();

    expect(selectVisibleCards(state).map((item) => item.jobId)).toEqual(['a']);
    expect(selectColumnCounts(state).scraped).toBe(1);
    expect(selectArchivedCount(state)).toBe(0);
    expect(selectCardById(state, 'b')?.stage).toBe('prepare');
  });

  it('toggles the filter chips and reports the off-default count', () => {
    const staged = toggleStage(DEFAULT_FILTERS, 'prepare');
    const actioned = toggleAction(staged, 'To Prepare');

    expect(actioned.stages).toEqual(['prepare']);
    expect(actioned.actions).toEqual(['To Prepare']);
    expect(activeFilterCount(actioned)).toBe(2);
    expect(filtersReducer(DEFAULT_FILTERS, { type: 'filters/reset' })).toEqual(DEFAULT_FILTERS);
  });

  it('resolves a dialog to the card and closes the modal when a move starts', () => {
    const state = storeWith([card('a')]).getState();
    const opened = dialogsReducer(initialDialogsState, dialogOpened('a'));
    const moving = dialogsReducer(opened, moveDialogRequested('a', 'prepare'));

    expect(selectOpenCard({ ...state, dialogs: opened })?.jobId).toBe('a');
    expect(moving.openId).toBeNull();
    expect(selectPendingMove({ ...state, dialogs: moving })?.to).toBe('prepare');
  });
});