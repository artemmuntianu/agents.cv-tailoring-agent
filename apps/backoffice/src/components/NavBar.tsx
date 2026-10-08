import { useEffect, useState } from 'react';
import { STAGES } from '../lib/stages';
import type { StageId } from '../lib/types';

/**
 * The panel's links - the only routing it knows about. A page that is **not** in the panel (the
 * parsed vacancy text, one vacancy's cover letter - pages that need a vacancy to render at all)
 * simply does not pass `active`, and nothing is highlighted.
 */
export type NavSection = 'board' | 'new-vacancy' | 'sources' | 'processes' | 'vocabularies';

interface NavBarProps {
  /** Which of the four the page being rendered is; it decides the highlighted item. */
  active?: NavSection;
  session: { email: string; name: string | null; admin: boolean };
  /**
   * The Pipeline summary is **board** state: the board passes the counts of the cards its
   * toolbar is showing, and that is why the block is optional - a page with no board read
   * renders the panel without it instead of inventing numbers.
   */
  counts?: Record<StageId, number>;
  total?: number;
  /** Refused vacancies among the cards the counts were taken from. */
  archived?: number;
  onSignOut: () => void;
}

/** Where the collapsed preference is remembered - a view preference, never board state. */
const COLLAPSED_KEY = 'cvt.nav.collapsed';

const FUTURE: { label: string; note: string }[] = [{ label: 'Vacancies', note: 'list + filters' }];

/** One nav item's shape, in both widths (icons stay, the words go). */
function itemClass(collapsed: boolean, active = false): string {
  return [
    'flex w-full items-center gap-2 rounded-md text-sm',
    collapsed ? 'justify-center px-2 py-2' : 'justify-between px-3 py-2',
    active ? 'bg-slate-900 font-medium text-white' : 'text-slate-700 hover:bg-slate-100',
  ].join(' ');
}

/**
 * The left panel every page wears: the board, the hand-typed vacancy page, the internal jobs' run
 * log and (for an administrator) the vocabulary screen - one link highlighted per page.
 *
 * The `«` toggle collapses the panel to its icons, so a narrow screen gives the page almost all
 * of its width back; the choice is remembered in `localStorage` and read in an `effect` (never
 * during render), because the server-rendered shell and the first client render have to agree.
 */
export default function NavBar({
  active,
  session,
  counts,
  total,
  archived,
  onSignOut,
}: NavBarProps) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === 'true');
    } catch {
      // A blocked localStorage (private mode, a locked profile) is not worth a broken panel.
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        // Same: the preference is a convenience, not a requirement.
      }
      return next;
    });
  }

  return (
    <nav
      className={`flex shrink-0 flex-col border-r border-slate-200 bg-white transition-[width] duration-150 ${
        collapsed ? 'w-16' : 'w-64'
      }`}
    >
      <div
        className={`flex items-center border-b border-slate-200 ${
          collapsed ? 'flex-col gap-2 px-2 py-3' : 'justify-between gap-2 px-5 py-4'
        }`}
      >
        {collapsed ? (
          <span className="text-lg text-slate-900" title="CV tailoring backoffice" aria-hidden>
            ▦
          </span>
        ) : (
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Backoffice
            </p>
            <h1 className="mt-1 text-lg font-semibold text-slate-900">Job search board</h1>
            <p className="mt-1 truncate text-[11px] text-slate-400">
              {session.name ? `${session.name} · ` : ''}
              {session.email}
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand the navigation panel' : 'Collapse the navigation panel'}
          title={collapsed ? 'Expand the navigation panel' : 'Collapse the navigation panel'}
          className="rounded-md border border-slate-300 px-1.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50"
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <div className={collapsed ? 'px-2 py-3' : 'px-3 py-4'}>
        <a
          href="/"
          className={itemClass(collapsed, active === 'board')}
          title="Board"
          aria-current={active === 'board' ? 'page' : undefined}
        >
          <span aria-hidden>▦</span>
          {!collapsed && <span>Board</span>}
        </a>

        <ul className={collapsed ? 'mt-2 space-y-2' : 'mt-1 space-y-1'}>
          <li>
            <a
              href="/new-vacancy"
              className={itemClass(collapsed, active === 'new-vacancy')}
              title={collapsed ? 'New vacancy · manual entry' : undefined}
              aria-current={active === 'new-vacancy' ? 'page' : undefined}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden>➕</span>
                {!collapsed && <span>New vacancy</span>}
              </span>
              {!collapsed && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                  by hand
                </span>
              )}
            </a>
          </li>

          {session.admin && (
            <li>
              <a
                href="/admin"
                className={itemClass(collapsed, active === 'vocabularies')}
                title={collapsed ? 'Vocabularies (admin)' : undefined}
                aria-current={active === 'vocabularies' ? 'page' : undefined}
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden>⚙</span>
                  {!collapsed && <span>Vocabularies</span>}
                </span>
                {!collapsed && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                    admin
                  </span>
                )}
              </a>
            </li>
          )}

          <li>
            <a
              href="/processes"
              className={itemClass(collapsed, active === 'processes')}
              title={collapsed ? 'Processes · run log' : undefined}
              aria-current={active === 'processes' ? 'page' : undefined}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden>▤</span>
                {!collapsed && <span>Processes</span>}
              </span>
              {!collapsed && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                  run log
                </span>
              )}
            </a>
          </li>

          <li>
            <a
              href="/sources"
              className={itemClass(collapsed, active === 'sources')}
              title={collapsed ? 'Sources of truth' : undefined}
              aria-current={active === 'sources' ? 'page' : undefined}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden>🧭</span>
                {!collapsed && <span>Sources of truth</span>}
              </span>
              {!collapsed && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                  read-only
                </span>
              )}
            </a>
          </li>

          {/* Roadmap placeholders: they are words, not icons, so a collapsed panel drops them. */}
          {!collapsed &&
            FUTURE.map((item) => (
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

      {!collapsed && counts && total !== undefined && (
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
          {archived !== undefined && archived > 0 && (
            <p className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2 text-sm text-rose-600">
              <span>
                <span aria-hidden>⛔️</span> Refused
              </span>
              <span className="font-medium">{archived}</span>
            </p>
          )}
        </div>
      )}

      <div className={`mt-auto border-t border-slate-200 ${collapsed ? 'p-2' : 'p-4'}`}>
        <button
          type="button"
          onClick={onSignOut}
          title="Sign out"
          className={
            collapsed
              ? 'flex w-full items-center justify-center rounded-md px-2 py-2 text-sm text-slate-700 hover:bg-slate-100'
              : 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50'
          }
        >
          <span aria-hidden>⎋</span>
          {!collapsed && <span className="ml-2">Sign out</span>}
        </button>
      </div>
    </nav>
  );
}
