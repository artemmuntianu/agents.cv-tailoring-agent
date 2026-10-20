import { useEffect, useMemo, useState } from 'react';
import AppShell from './AppShell';
import BoardToolbar from './BoardToolbar';
import KanbanBoard from './KanbanBoard';
import ReasonDialog from './ReasonDialog';
import RemoveDialog from './RemoveDialog';
import VacancyModal from './VacancyModal';
import { defaultArchiveAction, defaultMoveAction } from '../lib/actions';
import { countArchived, countByStage } from '../lib/board';
import { filterCards } from '../lib/filters';
import { missingFields, missingRequest } from '../lib/missing';
import { stageLabel } from '../lib/stages';
import type {
  ActionRequest,
  Actor,
  ArchiveRequest,
  DetailsRequest,
  HistoryEntryRequest,
  InterviewRequest,
  MoveRequest,
} from '../lib/types';
import IslandProvider from '../state/IslandProvider';
import { useAppDispatch, useAppSelector } from '../state/hooks';
import { errorMessage } from '../state/api/errors';
import { readCardQuery, useDocumentVisible } from '../state/browser';
import {
  useAddInterviewMutation,
  useArchiveMutation,
  useEditHistoryMutation,
  useEditInterviewMutation,
  useGetActionsQuery,
  useGetBoardQuery,
  useMoveMutation,
  useRecordActionMutation,
  useRemoveHistoryMutation,
  useRemoveInterviewMutation,
  useRemoveMutation,
  useRestoreMutation,
  useSaveDetailsMutation,
  useUploadDocxMutation,
} from '../state/api';
import {
  actionDialogRequested,
  archiveDialogRequested,
  dialogClosed,
  dialogOpened,
  dialogsClosed,
  moveDialogRequested,
  removeDialogRequested,
} from '../state/dialogs/slice';
import { filtersChanged, filtersReset } from '../state/filters/slice';

interface AppProps {
  session: { email: string; name: string | null; admin: boolean };
}

/**
 * Board root. The database is the single source of truth: every write is an RTK Query
 * mutation followed by an explicit board re-read, so what you see is what was persisted.
 * The query cache is a cache - never a second source of truth.
 */
function Board({ session }: AppProps) {
  const dispatch = useAppDispatch();
  const filters = useAppSelector((state) => state.filters);
  const dialogs = useAppSelector((state) => state.dialogs);
  const tabVisible = useDocumentVisible();

  const [live, setLive] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const board = useGetBoardQuery(undefined, {
    pollingInterval: live && tabVisible ? 5000 : 0,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });
  const actionsQuery = useGetActionsQuery();

  const [move] = useMoveMutation();
  const [recordAction] = useRecordActionMutation();
  const [archive] = useArchiveMutation();
  const [restoreCard] = useRestoreMutation();
  const [removeCard] = useRemoveMutation();
  const [addInterview] = useAddInterviewMutation();
  const [editInterview] = useEditInterviewMutation();
  const [removeInterview] = useRemoveInterviewMutation();
  const [editHistory] = useEditHistoryMutation();
  const [removeHistory] = useRemoveHistoryMutation();
  const [saveDetailsMutation] = useSaveDetailsMutation();
  const [uploadDocxFile] = useUploadDocxMutation();

  const cards = board.data ?? [];
  const actions = actionsQuery.data ?? [];
  const visible = useMemo(() => filterCards(cards, filters), [cards, filters]);
  const counts = useMemo(() => countByStage(visible), [visible]);
  const archivedCount = useMemo(() => countArchived(visible), [visible]);
  const error = writeError ?? (board.error ? errorMessage(board.error) : null);
  const loading = board.isLoading || reloading;

  const pendingMove = dialogs.pendingMove;
  const pending = useMemo(() => {
    if (!pendingMove) return null;
    const card = cards.find((item) => item.jobId === pendingMove.jobId);
    return card ? { card, to: pendingMove.to } : null;
  }, [cards, pendingMove]);
  const pendingAction = dialogs.pendingAction
    ? (cards.find((item) => item.jobId === dialogs.pendingAction) ?? null)
    : null;
  const pendingArchive = dialogs.pendingArchive
    ? (cards.find((item) => item.jobId === dialogs.pendingArchive) ?? null)
    : null;
  const pendingRemoval = dialogs.pendingRemoval
    ? (cards.find((item) => item.jobId === dialogs.pendingRemoval) ?? null)
    : null;
  const openCard = dialogs.openId
    ? (cards.find((item) => item.jobId === dialogs.openId) ?? null)
    : null;

  // The extension's `Scraped` link lands on `/?card=<job_id>`.
  useEffect(() => {
    if (dialogs.openId) return;
    const requested = readCardQuery();
    if (requested && cards.some((card) => card.jobId === requested)) {
      dispatch(dialogOpened(requested));
    }
  }, [cards, dialogs.openId, dispatch]);

  async function refresh() {
    await Promise.all([board.refetch(), actionsQuery.refetch()]);
  }

  async function reload() {
    setReloading(true);
    try {
      await refresh();
    } finally {
      setReloading(false);
    }
  }

  /** The board-level write contract: mutate, re-read both lists, then report. */
  async function boardWrite<T>(send: () => Promise<T>): Promise<T | null> {
    setNote(null);
    setWriteError(null);
    let payload: T | null = null;
    let failure: string | null = null;
    try {
      payload = await send();
    } catch (cause) {
      failure = errorMessage(cause);
    }
    await refresh();
    setWriteError(failure);
    const resultNote =
      payload && typeof payload === 'object' ? (payload as { note?: unknown }).note : null;
    if (typeof resultNote === 'string' && resultNote) setNote(resultNote);
    return payload;
  }

  /** A card-scoped write: the modal keeps the route's error, and success re-reads the board. */
  async function cardWrite(send: () => Promise<unknown>) {
    await send();
    await board.refetch();
  }

  async function uploadDocx(jobId: string, file: File) {
    await cardWrite(() => uploadDocxFile({ jobId, file }).unwrap());
  }

  async function confirmMove(
    actor: Actor,
    action: string,
    interview: InterviewRequest | null,
    missing: Record<string, string>,
  ) {
    if (!pending) return;
    const body: MoveRequest = {
      jobId: pending.card.jobId,
      to: pending.to,
      actor,
      action,
      ...missingRequest(missing),
    };
    dispatch(dialogsClosed());
    await boardWrite(() => move(interview ? { ...body, interview } : body).unwrap());
  }

  async function confirmAction(actor: Actor, action: string) {
    if (!pendingAction) return;
    const body: ActionRequest = { jobId: pendingAction.jobId, actor, action };
    dispatch(dialogsClosed());
    await boardWrite(() => recordAction(body).unwrap());
  }

  async function addInterviewLine(jobId: string, interview: InterviewRequest) {
    await cardWrite(() => addInterview({ jobId, request: interview }).unwrap());
  }

  async function editInterviewLine(id: number, interview: InterviewRequest) {
    await cardWrite(() => editInterview({ id, request: interview }).unwrap());
  }

  async function removeInterviewLine(id: number) {
    await cardWrite(() => removeInterview(id).unwrap());
  }

  async function editHistoryLine(id: number, line: HistoryEntryRequest) {
    await cardWrite(() => editHistory({ id, request: line }).unwrap());
  }

  async function removeHistoryLine(id: number) {
    await cardWrite(() => removeHistory(id).unwrap());
  }

  async function saveDetails(jobId: string, details: DetailsRequest) {
    await cardWrite(() => saveDetailsMutation({ ...details, jobId }).unwrap());
  }

  async function confirmArchive(actor: Actor, action: string) {
    if (!pendingArchive) return;
    const body: ArchiveRequest = { jobId: pendingArchive.jobId, actor, action };
    dispatch(dialogsClosed());
    await boardWrite(() => archive(body).unwrap());
  }

  async function restore(jobId: string) {
    await boardWrite(() => restoreCard(jobId).unwrap());
  }

  async function confirmRemove() {
    if (!pendingRemoval) return;
    dispatch(dialogsClosed());
    await boardWrite(() => removeCard(pendingRemoval.jobId).unwrap());
  }
  return (
    <AppShell
      active="board"
      title="Vacancy pipeline"
      subtitle="Drag a card to another column - it only moves once you confirm the reason."
      counts={counts}
      total={visible.length}
      archived={archivedCount}
      session={session}
      // The board is a fixed viewport: the toolbar and the columns scroll inside it, not the page.
      contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      actions={
        <>
          <button
            type="button"
            onClick={() => setLive((value) => !value)}
            aria-pressed={live}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
              live
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                : 'border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {live ? '● Live' : '○ Paused'}
          </button>
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {loading ? 'Loading…' : 'Reload'}
          </button>
        </>
      }
    >
      <BoardToolbar
        filters={filters}
        onChange={(next) => dispatch(filtersChanged(next))}
        onReset={() => dispatch(filtersReset())}
        actions={actions}
        shown={visible.length}
        total={cards.length}
      />

      {error && (
        <p className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      {note && (
        <p className="border-b border-emerald-200 bg-emerald-50 px-6 py-2 text-sm text-emerald-800">
          {note}
        </p>
      )}

      {!error && !loading && cards.length === 0 && (
        <p className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-800">
          No vacancies yet. Scrape a listing page with the Chrome extension
          (<code>apps/extension/</code>), or publish one with{' '}
          <code>.\scripts\send-test-job.ps1 -Smoke</code> - it will appear here, in{' '}
          <strong>Created</strong>.
        </p>
      )}

      {/* Filters can hide everything (the date window is on by default): say so, and
          make the way out one click, instead of showing an empty board. */}
      {!error && !loading && cards.length > 0 && visible.length === 0 && (
        <p className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-800">
          <span>
            No card matches the current filters ({cards.length} loaded - the date range and the
            Filters panel are hiding them).
          </span>
          <button
            type="button"
            onClick={() => dispatch(filtersReset())}
            className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            Show all cards
          </button>
        </p>
      )}

      <KanbanBoard
        cards={visible}
        onRequestMove={(card, to) => dispatch(moveDialogRequested(card.jobId, to))}
        onOpen={(jobId) => dispatch(dialogOpened(jobId))}
        onArchive={(jobId) => dispatch(archiveDialogRequested(jobId))}
        onRestore={(jobId) => void restore(jobId)}
        onRemove={(jobId) => dispatch(removeDialogRequested(jobId))}
      />

    {pending && (
      <ReasonDialog
        title="Move vacancy"
        subtitle={`${pending.card.title || pending.card.externalId} · ${pending.card.company}`}
        fromLabel={stageLabel(pending.card.stage)}
        toLabel={stageLabel(pending.to)}
        actions={actions}
        actionsKind="move"
        // The destination decides the default wording ("To Prepare", "To Applied",
        // ...): the common case is then one keystroke, and the trail reads the way it
        // always has.
        defaultAction={defaultMoveAction(pending.to)}
        // Empty for a card the scrape filled completely.
        missingFields={missingFields(pending.card)}
        confirmLabel="Proceed"
        // Entering Interviewing also collects the first interview; entering Prepare is what
        // queues tailoring - say so before it happens.
        interview={pending.to === 'interviewing'}
        warning={
          pending.to === 'prepare'
            ? 'Moving this card to Prepare queues the tailored CV for it: the worker will run Gemini on this vacancy.'
            : undefined
        }
        onProceed={confirmMove}
        onCancel={() => dispatch(dialogsClosed())}
      />
    )}

    {pendingAction && (
      <ReasonDialog
        title="➕ Add action"
        subtitle={`${pendingAction.title || pendingAction.externalId} · ${pendingAction.company}`}
        fromLabel={stageLabel(pendingAction.stage)}
        toLabel={`${stageLabel(pendingAction.stage)} · stays here`}
        actions={actions}
        actionsKind="move"
        confirmLabel="Record action"
        warning={
          'The card does not move. The action is recorded in its history and counts as ' +
          'activity, so the auto-archiver leaves this vacancy alone.'
        }
        onProceed={confirmAction}
        onCancel={() => dispatch(dialogsClosed())}
      />
    )}

    {pendingArchive && (
      <ReasonDialog
        title="⛔️ Archive vacancy"
        subtitle={`${pendingArchive.title || pendingArchive.externalId} · ${pendingArchive.company}`}
        fromLabel={stageLabel(pendingArchive.stage)}
        toLabel="Archived (stays in this column)"
        actionLabel="Action"
        actions={actions}
        actionsKind="archive"
        confirmLabel="⛔️ Archive"
        tone="danger"
        // The Actor stays the dialog's own default (**Candidate**, i.e. "you" - the
        // operator is the one recording the change). The reason defaults to "Not
        // Applicable" only where that is the only honest answer; every other column
        // starts empty.
        defaultAction={defaultArchiveAction(pendingArchive.stage)}
        onProceed={confirmArchive}
        onCancel={() => dispatch(dialogsClosed())}
      />
    )}

    {openCard && (
      <VacancyModal
        card={openCard}
        onClose={() => dispatch(dialogClosed())}
        onArchive={(jobId) => dispatch(archiveDialogRequested(jobId))}
        onRestore={(jobId) => {
          dispatch(dialogClosed());
          void restore(jobId);
        }}
        onRemove={(jobId) => dispatch(removeDialogRequested(jobId))}
        onAddAction={(jobId) => dispatch(actionDialogRequested(jobId))}
        onRequestMove={(card, to) => dispatch(moveDialogRequested(card.jobId, to))}
        onUploadDocx={uploadDocx}
        onAddInterview={addInterviewLine}
        onEditInterview={editInterviewLine}
        onRemoveInterview={removeInterviewLine}
        onEditHistory={editHistoryLine}
        onRemoveHistory={removeHistoryLine}
        onSaveDetails={saveDetails}
      />
    )}

    {pendingRemoval && (
      <RemoveDialog
        card={pendingRemoval}
        onConfirm={() => void confirmRemove()}
        onCancel={() => dispatch(dialogsClosed())}
      />
    )}
    </AppShell>
  );
}


export default function App({ session }: AppProps) {
  return (
    <IslandProvider>
      <Board session={session} />
    </IslandProvider>
  );
}