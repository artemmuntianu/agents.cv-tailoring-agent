import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, activeFilterCount } from '../lib/filters';
import { errorMessage } from './api/errors';
import filtersReducer, { filtersReset, toggleAction, toggleStage } from './filters/slice';
import dialogsReducer, { dialogOpened, initialDialogsState, moveDialogRequested } from './dialogs/slice';

describe('the remaining UI state', () => {
  it('toggles the filter chips and reports the off-default count', () => {
    const staged = toggleStage(DEFAULT_FILTERS, 'prepare');
    const actioned = toggleAction(staged, 'To Prepare');

    expect(actioned.stages).toEqual(['prepare']);
    expect(actioned.actions).toEqual(['To Prepare']);
    expect(activeFilterCount(actioned)).toBe(2);
    expect(filtersReducer(actioned, filtersReset())).toEqual(DEFAULT_FILTERS);
  });

  it('closes the modal when a move dialog opens', () => {
    const opened = dialogsReducer(initialDialogsState, dialogOpened('a'));
    const moving = dialogsReducer(opened, moveDialogRequested('a', 'prepare'));

    expect(opened.openId).toBe('a');
    expect(moving.openId).toBeNull();
    expect(moving.pendingMove).toEqual({ jobId: 'a', to: 'prepare' });
  });
});

describe('errorMessage', () => {
  it('reads the route error and falls back to the status', () => {
    expect(errorMessage({ status: 409, data: { ok: false, error: 'already there' } })).toBe(
      'already there',
    );
    expect(errorMessage({ status: 500, data: 'boom' })).toBe('boom');
    expect(errorMessage({ status: 500, data: undefined })).toBe('HTTP 500');
    expect(errorMessage(new Error('offline'))).toBe('offline');
  });
});