import { describe, expect, it, vi } from 'vitest';
import { startIsland } from './IslandProvider';
import { makeStore } from './store';

describe('startIsland', () => {
  it('dispatches the start action only after the saga is listening', () => {
    const store = makeStore();
    const order: string[] = [];
    vi.spyOn(store, 'runSaga').mockImplementation(() => {
      order.push('runSaga');
      return { cancel() {} } as never;
    });
    vi.spyOn(store, 'dispatch').mockImplementation((action: { type: string }) => {
      order.push(`dispatch:${action.type}`);
      return action;
    });

    startIsland(store, () => ({ type: 'test/start' }));

    expect(order).toEqual(['runSaga', 'dispatch:test/start']);
    vi.restoreAllMocks();
  });
});