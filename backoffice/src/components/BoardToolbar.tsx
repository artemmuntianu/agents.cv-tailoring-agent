import { useState } from 'react';
import { DATE_RANGES, activeFilterCount, type BoardFilters } from '../lib/filters';
import type { BoardAction } from '../lib/types';
import FilterDialog from './FilterDialog';

interface BoardToolbarProps {
  filters: BoardFilters;
  onChange: (filters: BoardFilters) => void;
  onReset: () => void;
  /** The persisted Action vocabulary, for the Filters panel. */
  actions: BoardAction[];
  /** `showing N of M` in the panel; `total` is everything loaded. */
  shown: number;
  total: number;
}

/**
 * The top control bar: search, date range, and one Filters button (visibility,
 * columns, actions live in its panel).
 *
 * The bar always shows how much of the board is on screen and how many filters are off
 * their defaults - the date window defaults to a rolling 30 days, so a filter that
 * silently hid older cards would be a bug with no symptoms.
 */
export default function BoardToolbar({
  filters,
  onChange,
  onReset,
  actions,
  shown,
  total,
}: BoardToolbarProps) {
  const [open, setOpen] = useState(false);
  const active = activeFilterCount(filters);

  return (
    <div className="relative flex flex-wrap items-center gap-2 px-6 py-2">
      <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5">
        <span aria-hidden className="text-slate-400">
          🔍
        </span>
        <input
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
          placeholder="Search vacancies…"
          aria-label="Search vacancies"
          className="min-w-0 flex-1 text-sm text-slate-900 outline-none placeholder:text-slate-400"
        />
        {filters.query && (
          <button
            type="button"
            onClick={() => onChange({ ...filters, query: '' })}
            aria-label="Clear search"
            className="rounded px-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        )}
      </label>

      <label className="flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700">
        <span aria-hidden className="text-slate-400">
          🗓
        </span>
        <span className="sr-only">Date range</span>
        <select
          value={filters.range}
          onChange={(event) =>
            onChange({ ...filters, range: event.target.value as BoardFilters['range'] })
          }
          className="bg-transparent text-sm text-slate-800 outline-none"
        >
          {DATE_RANGES.map((range) => (
            <option key={range.id} value={range.id}>
              {range.label}
            </option>
          ))}
        </select>
      </label>

      {filters.range === 'custom' && (
        <span className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-600">
          <input
            type="date"
            value={filters.from}
            onChange={(event) => onChange({ ...filters, from: event.target.value })}
            aria-label="From date"
            className="bg-transparent outline-none"
          />
          <span aria-hidden>→</span>
          <input
            type="date"
            value={filters.to}
            onChange={(event) => onChange({ ...filters, to: event.target.value })}
            aria-label="To date"
            className="bg-transparent outline-none"
          />
        </span>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium ${
          active > 0
            ? 'border-slate-900 bg-slate-900 text-white'
            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
        }`}
      >
        <span aria-hidden>🎛</span>
        Filters
        {active > 0 && (
          <span className="rounded bg-white/20 px-1.5 text-[11px] font-semibold">{active}</span>
        )}
      </button>

      {open && (
        <FilterDialog
          filters={filters}
          onChange={onChange}
          onReset={onReset}
          onClose={() => setOpen(false)}
          actions={actions}
          shown={shown}
          total={total}
        />
      )}
    </div>
  );
}
