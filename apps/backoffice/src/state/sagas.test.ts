import { runSaga } from 'redux-saga';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, SessionExpiredError } from './api/client';
import { card } from './board/fixtures';
import { dialogsClosed } from './dialogs/slice';
import { vocabularySucceeded } from './vocabulary/slice';
import {
  boardErrorSet,
  boardFailed,
  boardLoading,
  boardNoteSet,
  boardRequested,
  boardSucceeded,
  moveConfirmed,
} from './board/slice';
import { LIVE_INTERVAL_MS, fetchBoardSaga, moveSaga, pollSaga } from './board/sagas';
import { COVER_POLL_MS, coverRequestedSaga } from './cover/sagas';
import { coverLoaded, coverRequested, type CoverPayload } from './cover/slice';
import { adminAddRequested, adminBusy, adminLoaded, adminResult, type AdminVocabulary } from './admin/slice';
import { addSaga } from './admin/sagas';

function sink(state: unknown = {}) {
  const dispatched: unknown[] = [];
  return { dispatched, dispatch: (action: unknown) => dispatched.push(action), getState: () => state };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('board reads', () => {
  it('loads the board and reports a failed read', async () => {
    const cards = [card('a')];
    vi.spyOn(api, 'getBoard').mockResolvedValueOnce({ ok: true, cards }).mockRejectedValueOnce(new Error('boom'));

    const loaded = sink();
    await runSaga(loaded, fetchBoardSaga, { silent: false }).toPromise();
    expect(loaded.dispatched).toEqual([boardLoading(), boardSucceeded(cards)]);

    const failed = sink();
    await runSaga(failed, fetchBoardSaga, { silent: false }).toPromise();
    expect(failed.dispatched).toEqual([boardLoading(), boardFailed('boom')]);
  });

  it('redirects instead of painting an error when the session expired', async () => {
    vi.spyOn(api, 'getBoard').mockRejectedValue(new SessionExpiredError());
    const events = sink();

    await runSaga(events, fetchBoardSaga, { silent: false }).toPromise();

    expect(events.dispatched).toEqual([boardLoading()]);
  });

  it('asks for a silent read on every live tick', async () => {
    vi.useFakeTimers();
    const events = sink();
    const task = runSaga(events, pollSaga);

    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS);

    expect(events.dispatched).toEqual([boardRequested({ silent: true })]);
    task.cancel();
  });
});

describe('the write contract', () => {
  it('POSTs, re-reads the board and the vocabulary, then reports the note', async () => {
    const order: string[] = [];
    vi.spyOn(api, 'move').mockImplementation(async () => {
      order.push('post');
      return { ok: true, note: 'Cover letter queued as well.' };
    });
    vi.spyOn(api, 'getBoard').mockImplementation(async () => {
      order.push('board');
      return { ok: true, cards: [card('a')] };
    });
    vi.spyOn(api, 'getActions').mockResolvedValue({ ok: true, actions: [] });
    const events = sink();

    await runSaga(
      events,
      moveSaga,
      moveConfirmed({ jobId: 'a', to: 'prepare', actor: 'Candidate', action: 'To Prepare' }),
    ).toPromise();

    expect(order).toEqual(['post', 'board']);
    expect(events.dispatched).toEqual([
      dialogsClosed(),
      boardNoteSet(null),
      boardLoading(),
      boardSucceeded([card('a')]),
      vocabularySucceeded([]),
      boardNoteSet('Cover letter queued as well.'),
    ]);
  });

  it('reports a refused write only after the re-read', async () => {
    vi.spyOn(api, 'move').mockRejectedValue(new Error('broker refused'));
    vi.spyOn(api, 'getBoard').mockResolvedValue({ ok: true, cards: [] });
    vi.spyOn(api, 'getActions').mockResolvedValue({ ok: true, actions: [] });
    const events = sink();

    await runSaga(
      events,
      moveSaga,
      moveConfirmed({ jobId: 'a', to: 'prepare', actor: 'Candidate', action: 'To Prepare' }),
    ).toPromise();

    expect(events.dispatched.at(-1)).toEqual(boardErrorSet('broker refused'));
  });
});

describe('the cover letter poll', () => {
  function letter(status: string, text: string | null = null): CoverPayload {
    return { status, text, error: null, model: null, updatedAt: null, vacancy: null };
  }

  it('polls while queued and stops when the letter lands', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getCover')
      .mockResolvedValueOnce({ ok: true, ...letter('queued') })
      .mockResolvedValueOnce({ ok: true, ...letter('completed', 'Dear team') });
    const events = sink();
    const task = runSaga(events, coverRequestedSaga, coverRequested('a'));

    await vi.advanceTimersByTimeAsync(COVER_POLL_MS);

    expect(api.getCover).toHaveBeenCalledTimes(2);
    expect(events.dispatched.at(-1)).toEqual(coverLoaded({ ok: true, ...letter('completed', 'Dear team') } as CoverPayload));
    task.cancel();
  });
});

describe('the admin write', () => {
  const vocabulary: AdminVocabulary = {
    actions: [],
    actors: [],
    stages: [],
    subStates: [],
  };

  it('writes, re-reads and resolves the caller true', async () => {
    const meta = { resolve: vi.fn(), reject: vi.fn() };
    vi.spyOn(api, 'adminAdd').mockResolvedValue({ ok: true });
    vi.spyOn(api, 'getAdminVocabulary').mockResolvedValue({ ok: true, ...vocabulary });
    const events = sink();

    await runSaga(events, addSaga, adminAddRequested('To Apply', 'move', meta)).toPromise();

    expect(events.dispatched).toEqual([
      adminBusy(true),
      adminLoaded(vocabulary),
      adminBusy(false),
      adminResult(null, 'Added “To Apply”.'),
    ]);
    expect(meta.resolve).toHaveBeenCalledWith(true);
  });
});