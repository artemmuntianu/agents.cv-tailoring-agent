import { STAGES } from '../lib/stages';
import type { StageId } from '../lib/types';

interface NavBarProps {
  counts: Record<StageId, number>;
  total: number;
  loading: boolean;
  live: boolean;
  session: { email: string; name: string | null };
  onReload: () => void;
  onSignOut: () => void;
}

const FUTURE: { label: string; note: string }[] = [
  { label: 'Vacancies', note: 'list + filters' },
  { label: 'Settings', note: 'actors, stages' },
];

/** Left nav panel. Only "Board" is implemented in the POC. */
export default function NavBar({ counts, total, loading, live, session, onReload, onSignOut }: NavBarProps) {
  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Backoffice</p>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">Job search board</h1>
        <p className="mt-1 text-[11px] text-slate-400">
          {session.name ? `${session.name} · ` : ''}
          {session.email}
        </p>
      </div>

      <div className="px-3 py-4">
        <a
          href="/"
          className="flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
        >
          <span aria-hidden>▦</span> Board
        </a>
        <ul className="mt-1 space-y-1">
          {FUTURE.map((item) => (
            <li key={item.label}>
              <span className="flex cursor-not-allowed items-center justify-between rounded-md px-3 py-2 text-sm text-slate-400">
                {item.label}
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                  {item.note}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="px-5 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Pipeline ({total})
        </p>
        <ul className="mt-2 space-y-1 text-sm">
          {STAGES.map((stage) => (
            <li key={stage.id} className="flex items-center justify-between text-slate-600">
              <span>{stage.label}</span>
              <span className="font-medium text-slate-900">{counts[stage.id]}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-auto border-t border-slate-200 p-4">
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
        >
          {loading ? 'Loading…' : 'Reload from database'}
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Sign out
        </button>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
          Cards move only by hand. Every move asks for the actor and a reason, and both are stored in
          the card's history in the same Postgres the worker writes to.
          {live
            ? ' Live mode re-reads the board every few seconds; worker status changes appear on their own.'
            : ' Live mode is paused: press Reload to see worker progress.'}
        </p>
      </div>
    </nav>
  );
}

