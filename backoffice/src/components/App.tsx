import { useCallback, useEffect, useMemo, useState } from 'react';
import KanbanBoard from './KanbanBoard';
import NavBar from './NavBar';
import ReasonDialog from './ReasonDialog';
import VacancyModal from './VacancyModal';
import { countByStage } from '../lib/board';
import { stageLabel } from '../lib/stages';
import type { Actor, BoardCard, MoveRequest, StageId } from '../lib/types';

interface AppProps {
  session: { email: string; name: string | null };
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      // A background tab has no reader; skip the query and the wake-up cost.
      if (document.visibilityState === 'visible') void refresh({ silent: true });
    }, LIVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [live, refresh]);

  async function confirm(actor: Actor, action: string) {
    if (!pending) return;
    const request: MoveRequest = { jobId: pending.card.jobId, to: pending.to, actor, action };
    setPending(null);
    try {
      const response = await fetch('/api/board/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      await refresh();
    } catch (cause) {
      // The card did not move: surface why, then re-read the DB as the truth.
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh();
    }
  }

  const counts = useMemo(() => countByStage(cards), [cards]);
  const openCard = cards.find((card) => card.jobId === openId) ?? null;

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-100 text-slate-900">
      <NavBar
        counts={counts}
        total={cards.length}
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

        {error && (
          <p className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}

        {!error && !loading && cards.length === 0 && (
          <p className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-800">
            No vacancies yet. Publish one with <code>.\scripts\send-test-job.ps1 -Smoke</code> and it
            will appear here, in <strong>Created</strong>.
          </p>
        )}

        <KanbanBoard
          cards={cards}
          onRequestMove={(card, to) => setPending({ card, to })}
          onOpen={setOpenId}
        />
      </main>

      {pending && (
        <ReasonDialog
          title="Move vacancy"
          subtitle={`${pending.card.title || pending.card.externalId} · ${pending.card.company}`}
          fromLabel={stageLabel(pending.card.stage)}
          toLabel={stageLabel(pending.to)}
          onProceed={confirm}
          onCancel={() => setPending(null)}
        />
      )}

      {openCard && <VacancyModal card={openCard} onClose={() => setOpenId(null)} />}
    </div>
  );
}
