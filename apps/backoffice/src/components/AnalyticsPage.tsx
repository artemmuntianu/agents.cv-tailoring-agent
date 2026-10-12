import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from './AppShell';
import StageMixChart from './StageMixChart';
import { buildSeries, dayBuckets, resolveWindow, summarizeSeries } from '../lib/analytics';
import { DATE_RANGES, dateWindow, type DateRangeId } from '../lib/filters';
import type { BoardCard } from '../lib/types';

interface AnalyticsPageProps {
  session: { email: string; name: string | null; admin: boolean };
}

/**
 * `/analytics` - how many vacancies stood in each column, day by day.
 *
 * Same shape as `/processes`, and for the same reason: the panel, the header and the page's own
 * controls are the application's chrome, and a window over the board would hide them. The data is
 * the board's own `GET /api/board` - those cards already carry their `history`, and this page is a
 * *reading* of them (`lib/analytics.ts` reconstructs "which column was this card in on that day"
 * from the trail), so nothing new is stored and the chart can never disagree with the board.
 *
 * Read when the page opens and on demand, never polled: the board's 5s cadence answers a question
 * - "what changed?" - that a day-by-day diagram does not ask. Moving the range re-slices what is
 * already in memory, so changing it costs no request.
 */
export default function AnalyticsPage({ session }: AnalyticsPageProps) {
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The board toolbar's own range vocabulary, one implementation (`lib/filters.ts`). */
  const [range, setRange] = useState<DateRangeId>('last30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  /** Refused vacancies keep the column they dropped out of; the chart counts them by default. */
  const [includeArchived, setIncludeArchived] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/board');
      if (response.status === 401) {
        // The 8h session expired; the login page sends us back here afterwards.
        window.location.assign('/login?next=/analytics');
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
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const series = useMemo(() => {
    const bounds = resolveWindow(dateWindow({ range, from, to }), cards);
    return buildSeries(cards, dayBuckets(bounds.from, bounds.to), { includeArchived });
  }, [cards, range, from, to, includeArchived]);

  return (
    <AppShell
      active="analytics"
      title="Analytics"
      subtitle={`Vacancies per stage, day by day · ${summarizeSeries(series)}`}
      session={session}
      actions={
        <>
          <label className="flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700">
            <span aria-hidden className="text-slate-400">
              🗓
            </span>
            <span className="sr-only">Date range</span>
            <select
              value={range}
              onChange={(event) => setRange(event.target.value as DateRangeId)}
              className="bg-transparent text-sm text-slate-800 outline-none"
            >
              {DATE_RANGES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {range === 'custom' && (
            <span className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-600">
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                aria-label="From date"
                className="bg-transparent outline-none"
              />
              <span aria-hidden>→</span>
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                aria-label="To date"
                className="bg-transparent outline-none"
              />
            </span>
          )}

          <label className="flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            Include refused
          </label>

          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
          >
            {loading ? 'Loading…' : 'Reload'}
          </button>
        </>
      }
    >
      {error && (
        <p className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      {loading && cards.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          Loading…
        </p>
      ) : (
        <StageMixChart series={series} />
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
        One column per local day, one segment per stage, stacked bottom-to-top in board order:
        Scraped is the bottom segment, Offer the top. A segment&apos;s height is that stage&apos;s
        share of the board that day, so every column fills the axis and the six add up to 100% - and
        the number on a segment is that rounded share. A segment too thin to hold its number drops
        the label rather than shrinking it; hovering one reads it out in vacancies (and fades the
        other stages). A card is placed by its own history - the last column it was moved into on or
        before that day - so it appears in Scraped the day it was scraped and moves the day the
        operator moved it. Nothing here is stored: the chart is computed from the board&apos;s own
        cards, so it can never disagree with them. A range wider than 90 days is drawn as its newest
        90.
      </p>
    </AppShell>
  );
}
