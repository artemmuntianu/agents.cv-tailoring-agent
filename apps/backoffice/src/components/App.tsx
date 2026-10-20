import AppShell from './AppShell';
import BoardToolbar from './BoardToolbar';
import KanbanBoard from './KanbanBoard';
import ReasonDialog from './ReasonDialog';
import RemoveDialog from './RemoveDialog';
import VacancyModal from './VacancyModal';
import { defaultArchiveAction, defaultMoveAction } from '../lib/actions';
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
import { request } from '../state/request';
import {
  actionConfirmed,
  archiveConfirmed,
  boardLiveSet,
  boardRequested,
  boardStarted,
  detailsSaveRequested,
  docxUploadRequested,
  historyEditRequested,
  historyRemoveRequested,
  interviewAddRequested,
  interviewEditRequested,
  interviewRemoveRequested,
  moveConfirmed,
  removeConfirmed,
  restoreRequested,
} from '../state/board/slice';
import {
  selectArchivedCount,
  selectBoardError,
  selectBoardLoading,
  selectBoardNote,
  selectCards,
  selectColumnCounts,
  selectLive,
  selectVisibleCards,
} from '../state/board/selectors';
import { filtersChanged, filtersReset } from '../state/filters/slice';
import { selectFilters } from '../state/filters/selectors';
import {
  actionDialogRequested,
  archiveDialogRequested,
  dialogClosed,
  dialogOpened,
  dialogsClosed,
  moveDialogRequested,
  removeDialogRequested,
} from '../state/dialogs/slice';
import {
  selectOpenCard,
  selectPendingActionCard,
  selectPendingArchiveCard,
  selectPendingMove,
  selectPendingRemovalCard,
} from '../state/dialogs/selectors';
import { selectActions } from '../state/vocabulary/selectors';

interface AppProps {
  session: { email: string; name: string | null; admin: boolean };
}

/**
 * Board root. The database is the single source of truth: every confirmed change is a saga
 * that POSTs, re-reads `/api/board` and only then reports the failure, so what you see is
 * what was persisted. The store is a cache of that read - never a second source of truth.
 */
function Board({ session }: AppProps) {
  const dispatch = useAppDispatch();
  const cards = useAppSelector(selectCards);
  const visible = useAppSelector(selectVisibleCards);
  const counts = useAppSelector(selectColumnCounts);
  const archivedCount = useAppSelector(selectArchivedCount);
  const loading = useAppSelector(selectBoardLoading);
  const error = useAppSelector(selectBoardError);
  const note = useAppSelector(selectBoardNote);
  const live = useAppSelector(selectLive);
  const filters = useAppSelector(selectFilters);
  const actions = useAppSelector(selectActions);

  const pending = useAppSelector(selectPendingMove);
  const pendingAction = useAppSelector(selectPendingActionCard);
  const pendingArchive = useAppSelector(selectPendingArchiveCard);
  const pendingRemoval = useAppSelector(selectPendingRemovalCard);
  const openCard = useAppSelector(selectOpenCard);



  /** *Update docx*: the card-scoped write whose dialog stays open on a refusal. */
  async function uploadDocx(jobId: string, file: File) {
    await request(dispatch, docxUploadRequested(jobId, file));
  }

  /** The move confirmed; the saga drops the dialog and reports the route's `note`. */
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
    dispatch(moveConfirmed(interview ? { ...body, interview } : body));
  }

  async function confirmAction(actor: Actor, action: string) {
    if (!pendingAction) return;
    const body: ActionRequest = { jobId: pendingAction.jobId, actor, action };
    dispatch(actionConfirmed(body));
  }

  async function addInterview(jobId: string, interview: InterviewRequest) {
    await request(dispatch, interviewAddRequested(jobId, interview));
  }

  async function editInterview(id: number, interview: InterviewRequest) {
    await request(dispatch, interviewEditRequested(id, interview));
  }

  async function removeInterview(id: number) {
    await request(dispatch, interviewRemoveRequested(id));
  }

  async function editHistoryLine(id: number, line: HistoryEntryRequest) {
    await request(dispatch, historyEditRequested(id, line));
  }

  async function removeHistoryLine(id: number) {
    await request(dispatch, historyRemoveRequested(id));
  }

  async function saveDetails(jobId: string, details: DetailsRequest) {
    await request(dispatch, detailsSaveRequested(jobId, { ...details, jobId }));
  }

  async function confirmArchive(actor: Actor, action: string) {
    if (!pendingArchive) return;
    const body: ArchiveRequest = { jobId: pendingArchive.jobId, actor, action };
    dispatch(archiveConfirmed(body));
  }

  function restore(jobId: string) {
    dispatch(restoreRequested(jobId));
  }

  async function confirmRemove() {
    if (!pendingRemoval) return;
    dispatch(removeConfirmed(pendingRemoval.jobId));
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
            onClick={() => dispatch(boardLiveSet(!live))}
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
            onClick={() => dispatch(boardRequested())}
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
        onRestore={(jobId) => dispatch(restoreRequested(jobId))}
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
          dispatch(restoreRequested(jobId));
        }}
        onRemove={(jobId) => dispatch(removeDialogRequested(jobId))}
        onAddAction={(jobId) => dispatch(actionDialogRequested(jobId))}
        onRequestMove={(card, to) => dispatch(moveDialogRequested(card.jobId, to))}
        onUploadDocx={uploadDocx}
        onAddInterview={addInterview}
        onEditInterview={editInterview}
        onRemoveInterview={removeInterview}
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
    <IslandProvider start={() => boardStarted()}>
      <Board session={session} />
    </IslandProvider>
  );
}