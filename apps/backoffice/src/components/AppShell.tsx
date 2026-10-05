import type { ReactNode } from 'react';
import NavBar, { type NavSection } from './NavBar';
import type { StageId } from '../lib/types';

interface AppShellProps {
  /** Which page this is - the panel highlights that item. Omitted by a page that is not in the panel. */
  active?: NavSection;
  title: string;
  subtitle: string;
  /** The page's own controls, right-aligned in the header (the board's Live/Reload, …). */
  actions?: ReactNode;
  session: { email: string; name: string | null; admin: boolean };
  /**
   * Board state for the panel's Pipeline summary. Only the board has it: `/processes` and
   * `/admin` are about something else, and reading the whole board to draw counters nobody
   * asked for would be a query per page view.
   */
  counts?: Record<StageId, number>;
  total?: number;
  archived?: number;
  /**
   * How the content region behaves. The default is a page that scrolls as a whole; the board
   * overrides it because it is a fixed viewport whose columns scroll individually.
   */
  contentClassName?: string;
  children: ReactNode;
}

/** The chrome every page shares, so `/`, `/processes` and `/admin` are the same shape. */
export default function AppShell({
  active,
  title,
  subtitle,
  actions,
  session,
  counts,
  total,
  archived,
  contentClassName = 'min-h-0 flex-1 overflow-auto p-6',
  children,
}: AppShellProps) {
  /**
   * Sign out for real: clear the cookie, then land on the login page. Body-less, but it still
   * needs the JSON content-type (Astro's `checkOrigin` refuses a non-GET without one).
   */
  async function signOut() {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }).catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-100 text-slate-900">
      <NavBar
        active={active}
        session={session}
        counts={counts}
        total={total}
        archived={archived}
        onSignOut={() => void signOut()}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-slate-900">{title}</h1>
            <p className="text-xs text-slate-500">{subtitle}</p>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>

        {/* The viewport is fixed and this region scrolls, so the panel and the header stay put. */}
        <div className={contentClassName}>{children}</div>
      </main>
    </div>
  );
}
