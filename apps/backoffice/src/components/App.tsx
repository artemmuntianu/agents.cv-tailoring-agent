import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from './AppShell';
import BoardToolbar from './BoardToolbar';
import KanbanBoard from './KanbanBoard';
import ReasonDialog from './ReasonDialog';
import RemoveDialog from './RemoveDialog';
import VacancyModal from './VacancyModal';
import { defaultArchiveAction, defaultMoveAction } from '../lib/actions';
import { countArchived, countByStage } from '../lib/board';
import { DEFAULT_FILTERS, filterCards, type BoardFilters } from '../lib/filters';
import { missingFields, missingRequest } from '../lib/missing';
import { stageLabel } from '../lib/stages';
import type {
  ActionRequest,
  Actor,
  ArchiveRequest,
  BoardAction,
  BoardCard,
  DetailsRequest,
  HistoryEntryRequest,
  InterviewRequest,
  MoveRequest,
  StageId,
} from '../lib/types';

interface AppProps {
  session: { email: string; name: string | null; admin: boolean };
}

/** How often live mode re-reads the board (ms). */
const LIVE_INTERVAL_MS = 5000;

/**
 * Board root. The database is the single source of truth: every confirmed move is
 * POSTed and the board is then re-read, so what you see is what was persisted.
 *
 * Live mode polls instead of using SSE/WebSocket: the worker writes `resumes.status`
 * from another container, and a short read-only poll survives the `kubectl
 * port-forward` the board runs behind without a long-lived connection to drop.
 */
export default function App({ session }: AppProps) {
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [pending, setPending] = useState<{ card: BoardCard; to: StageId } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filters, setFilters] = useState<BoardFilters>(DEFAULT_FILTERS);
  /** The persisted Action vocabulary: dialog suggestions + filter options. */
  const [actions, setActions] = useState<BoardAction[]>([]);
  /** The card waiting for the refusal dialog's confirmation. */
  const [pendingArchive, setPendingArchive] = useState<BoardCard | null>(null);
  /** The card waiting for the *removal* confirmation (irreversible). */
  const [pendingRemoval, setPendingRemoval] = useState<BoardCard | null>(null);
  /** A one-line explanation of what an action did (e.g. artifacts queued for the sweep). */
  const [note, setNote] = useState<string | null>(null);
  /** The card waiting for the Add Action dialog: the Move dialog, with no column change. */
  const [pendingAction, setPendingAction] = useState<BoardCard | null>(null);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      const response = await fetch('/api/board');
      if (response.status === 401) {
        // The 8h session expired; the login page sends us back here afterwards.
        window.location.assign('/login?next=/');
        return;
      }
      const payload = (await response.json()) as {
        ok: boolean;
        cards?: BoardCard[];
        error?: string;
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setCards(payload.cards ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCards([]);
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, []);

  /**
   * The Action vocabulary (dialog combobox + Filters panel). Read with the board and
   * again after every confirmed change, so what the operator typed is offered at once.
   */
  const loadActions = useCallback(async () => {
    try {
      const response = await fetch('/api/board/actions');
      if (!response.ok) return;
      const payload = (await response.json()) as { ok: boolean; actions?: BoardAction[] };
      if (payload.ok) setActions(payload.actions ?? []);
    } catch {
      // The board still works without suggestions: the Action field stays free text.
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadActions();
  }, [refresh, loadActions]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      // A background tab has no reader; skip the query and the wake-up cost.
      if (document.visibilityState === 'visible') void refresh({ silent: true });
    }, LIVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [live, refresh]);

  useEffect(() => {
    // A scrape happens in another tab (the extension popup), so re-read the board the
    // moment this one is looked at again - no waiting for the next poll tick.
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refresh({ silent: true });
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    // The extension's `Scraped` link lands on `/?card=<job_id>`: open that vacancy as soon as
    // the board has it. The modal renders from `cards`, not from the filtered view, so it also
    // works when the current filters happen to hide the column.
    if (openId) return;
    const requested = new URLSearchParams(window.location.search).get('card');
    if (!requested) return;
    if (cards.some((card) => card.jobId === requested)) setOpenId(requested);
  }, [cards, openId]);

  /**
   * One confirmed change: POST, then re-read the board and the vocabulary. A refused
   * request sets the error *after* the re-read, because `refresh()` clears it (the DB is
   * the display, so the previous state comes back on screen either way). The route's JSON is
   * returned so a caller can surface its `note` (e.g. "artifacts queued for the sweep").
   */
  async function mutate(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    let failure: string | null = null;
    let payload: Record<string, unknown> | null = null;
    setNote(null);
    // An upload is the one body that is *not* JSON: `FormData` must go out untouched so the
    // browser writes the multipart boundary itself (`POST /api/board/docx/<id>`).
    const upload = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
      const response = await fetch(path, {
        method: 'POST',
        ...(upload ? {} : { headers: { 'content-type': 'application/json' } }),
        body: upload ? (body as FormData) : JSON.stringify(body),
      });
      const parsed = (await response.json()) as { ok: boolean; error?: string } & Record<
        string,
        unknown
      >;
      if (!response.ok || !parsed.ok) throw new Error(parsed.error ?? `HTTP ${response.status}`);
      payload = parsed;
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
    await refresh();
    await loadActions();
    if (failure) setError(failure);
    return payload;
  }

  /**
   * *Update docx*: the deliverable the operator edited by hand, uploaded as multipart.
   *
   * The route stores the bytes and asks `resumes.rerender` for a new PDF, so the board's own
   * artifact links point at the same pair as before - and the card payload (the 5s poll) is how
   * the modal shows the render landing.
   */
  async function uploadDocx(jobId: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    await mutate(`/api/board/docx/${encodeURIComponent(jobId)}`, form);
  }

  /**
   * The move confirmed. Entering Interviewing can carry a first interview, which the move route
   * inserts in the same transaction as the column change (so a card can never claim the column
   * without it) - an empty draft simply sends nothing. The Missing fields section rides along
   * the same way: whatever the operator typed for a field the scrape left empty is sent with the
   * move, and the move route is what stores it.
   */
  async function confirmMove(
    actor: Actor,
    action: string,
    interview: InterviewRequest | null,
    missing: Record<string, string>,
  ) {
    if (!pending) return;
    const request: MoveRequest = {
      jobId: pending.card.jobId,
      to: pending.to,
      actor,
      action,
      // The Missing fields values: only the ones that were actually typed.
      ...missingRequest(missing),
    };
    setPending(null);
    const result = await mutate(
      '/api/board/move',
      interview ? { ...request, interview } : request,
    );
    // Entering Prepare also queues the cover letter; the route says what happened to it.
    const explanation = typeof result?.note === 'string' ? result.note : null;
    if (explanation) setNote(explanation);
  }

  /**
   * The Add Action dialog confirmed: the Move dialog's actor + reason, with **no** column change.
   *
   * It records a history row and bumps the card's activity date - which is what keeps the
   * auto-archiver away from a card the operator is still working on. It goes to its own route,
   * because in Prepare a move into the current column would be a tailoring *retry*.
   */
  async function confirmAction(actor: Actor, action: string) {
    if (!pendingAction) return;
    const request: ActionRequest = { jobId: pendingAction.jobId, actor, action };
    setPendingAction(null);
    await mutate('/api/board/action', request);
  }

  /**
   * A card-scoped write (interview or details). Unlike the board-level mutations it reports its
   * failure to *its caller* - the card's own control stays open with the message - so it does not
   * go through `mutate`, which speaks through the toolbar's error line. It still re-reads the
   * board (the database is the display), and neither of these writes a history row: an interview
   * list is its own history and the detail fields are card attributes (invariant 28).
   */
  async function boardWrite(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ) {
    // The JSON content-type is sent even for a body-less DELETE: Astro's `checkOrigin`
    // middleware forbids a non-safe request that has *no* content-type and no matching
    // `Origin` (a browser always sends one, a script or a proxy may not) - see
    // `apps/backoffice/AGENTS.md`.
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as { ok: boolean; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    await refresh();
  }

  async function addInterview(jobId: string, interview: InterviewRequest) {
    await boardWrite('/api/board/interviews', 'POST', { jobId, ...interview });
  }

  async function editInterview(id: number, interview: InterviewRequest) {
    await boardWrite(`/api/board/interviews/${id}`, 'PATCH', interview);
  }

  async function removeInterview(id: number) {
    await boardWrite(`/api/board/interviews/${id}`, 'DELETE');
  }

  /**
   * The History section's two writes: correcting one audit line, and dropping one.
   *
   * Both go through `boardWrite` (so a refusal is reported in the dialog that caused it) and both
   * are deliberately *not* activity: no column change, no `resume_board.updated_at`, no
   * `board_actions` - fixing the record cannot buy a card another ten days from the sweep
   * (invariant 29).
   */
  async function editHistoryLine(id: number, line: HistoryEntryRequest) {
    await boardWrite(`/api/board/history/${id}`, 'PATCH', line);
  }

  async function removeHistoryLine(id: number) {
    await boardWrite(`/api/board/history/${id}`, 'DELETE');
  }

  /** The card's own detail fields: one write for the set, no column change, no history row. */
  async function saveDetails(jobId: string, details: DetailsRequest) {
    await boardWrite('/api/board/details', 'POST', { ...details, jobId });
  }

  /** The refusal dialog confirmed: the card is archived in place, with its reason. */
  async function confirmArchive(actor: Actor, action: string) {
    if (!pendingArchive) return;
    const request: ArchiveRequest = { jobId: pendingArchive.jobId, actor, action };
    setPendingArchive(null);
    await mutate('/api/board/archive', request);
  }

  /**
   * Restore is one click (the archived card's own button). The route records the actor
   * and the action, so an undo is still an audited change - it just does not need a
   * dialog.
   */
  async function restore(jobId: string) {
    await mutate('/api/board/restore', { jobId });
  }

  /**
   * Removal is the one action with no way back, so it happens only after the dialog and it
   * deliberately leaves the board *without* the card: the vacancy is forgotten, artifacts
   * included. Whatever the board could not delete itself is queued for the volume sweep, and
   * the route's note tells the operator to run it.
   */
  async function confirmRemove() {
    if (!pendingRemoval) return;
    const jobId = pendingRemoval.jobId;
    setPendingRemoval(null);
    const result = await mutate('/api/board/remove', { jobId });
    const explanation = typeof result?.note === 'string' ? result.note : null;
    if (explanation) setNote(explanation);
  }

  const visible = useMemo(() => filterCards(cards, filters), [cards, filters]);
  const counts = useMemo(() => countByStage(visible), [visible]);
  const archivedCount = useMemo(() => countArchived(visible), [visible]);
  const openCard = cards.find((card) => card.jobId === openId) ?? null;

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
            onClick={() => void refresh()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {loading ? 'Loading…' : 'Reload'}
          </button>
        </>
      }
    >
      <BoardToolbar
        filters={filters}
        onChange={setFilters}
        onReset={() => setFilters(DEFAULT_FILTERS)}
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
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            Show all cards
          </button>
        </p>
      )}

      <KanbanBoard
        cards={visible}
        onRequestMove={(card, to) => setPending({ card, to })}
        onOpen={setOpenId}
        onArchive={(jobId) =>
          setPendingArchive(cards.find((card) => card.jobId === jobId) ?? null)
        }
        onRestore={(jobId) => void restore(jobId)}
        onRemove={(jobId) =>
          setPendingRemoval(cards.find((card) => card.jobId === jobId) ?? null)
        }
        onAddAction={(jobId) =>
          setPendingAction(cards.find((card) => card.jobId === jobId) ?? null)
        }
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
        onCancel={() => setPending(null)}
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
        onCancel={() => setPendingAction(null)}
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
        onCancel={() => setPendingArchive(null)}
      />
    )}

    {openCard && (
      <VacancyModal
        card={openCard}
        onClose={() => setOpenId(null)}
        onArchive={(jobId) => {
          setOpenId(null);
          setPendingArchive(cards.find((card) => card.jobId === jobId) ?? null);
        }}
        onRestore={(jobId) => {
          setOpenId(null);
          void restore(jobId);
        }}
        onRemove={(jobId) => {
          setOpenId(null);
          setPendingRemoval(cards.find((card) => card.jobId === jobId) ?? null);
        }}
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
        onCancel={() => setPendingRemoval(null)}
      />
    )}
    </AppShell>
  );
}
