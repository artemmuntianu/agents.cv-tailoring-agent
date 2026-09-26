import { useCallback, useEffect, useMemo, useState } from 'react';
import BoardToolbar from './BoardToolbar';
import KanbanBoard from './KanbanBoard';
import NavBar from './NavBar';
import ReasonDialog from './ReasonDialog';
import VacancyModal from './VacancyModal';
import { countArchived, countByStage } from '../lib/board';
import { DEFAULT_FILTERS, filterCards, type BoardFilters } from '../lib/filters';
import { stageLabel } from '../lib/stages';
import type {
  Actor,
  ArchiveRequest,
  BoardAction,
  BoardCard,
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

  /**
   * One confirmed change: POST, then re-read the board and the vocabulary. A refused
   * request sets the error *after* the re-read, because `refresh()` clears it (the DB is
   * the display, so the previous state comes back on screen either way).
   */
  async function mutate(path: string, body: unknown) {
    let failure: string | null = null;
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
    await refresh();
    await loadActions();
    if (failure) setError(failure);
  }

  async function confirmMove(actor: Actor, action: string) {
    if (!pending) return;
    const request: MoveRequest = { jobId: pending.card.jobId, to: pending.to, actor, action };
    setPending(null);
    await mutate('/api/board/move', request);
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

  const visible = useMemo(() => filterCards(cards, filters), [cards, filters]);
  const counts = useMemo(() => countByStage(visible), [visible]);
  const archivedCount = useMemo(() => countArchived(visible), [visible]);
  const openCard = cards.find((card) => card.jobId === openId) ?? null;

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-100 text-slate-900">
      <NavBar
        counts={counts}
        total={visible.length}
        archived={archivedCount}
        loading={loading}
        live={live}
        session={session}
        onReload={() => void refresh()}
        onSignOut={() => void signOut()}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <div>
            <h1 className="text-base font-semibold text-slate-900">Vacancy pipeline</h1>
            <p className="text-xs text-slate-500">
              Drag a card to another column - it only moves once you confirm the reason.
            </p>
          </div>
          <div className="flex items-center gap-2">
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
          </div>
        </header>

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

        {!error && !loading && cards.length === 0 && (
          <p className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-800">
            No vacancies yet. Scrape a listing page with the Chrome extension
            (<code>extension/</code>), or publish one with{' '}
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
        />
      </main>

      {pending && (
        <ReasonDialog
          title="Move vacancy"
          subtitle={`${pending.card.title || pending.card.externalId} · ${pending.card.company}`}
          fromLabel={stageLabel(pending.card.stage)}
          toLabel={stageLabel(pending.to)}
          actions={actions}
          actionsKind="move"
          confirmLabel="Proceed"
          onProceed={confirmMove}
          onCancel={() => setPending(null)}
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
          defaultActor="Company"
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
        />
      )}
    </div>
  );
}
