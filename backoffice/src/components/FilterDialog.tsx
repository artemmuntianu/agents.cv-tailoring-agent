import { useEffect, useRef } from 'react';
import { summarize, type BoardFilters } from '../lib/filters';
import { STAGES } from '../lib/stages';
import type { BoardAction, StageId } from '../lib/types';

interface FilterDialogProps {
  filters: BoardFilters;
  onChange: (filters: BoardFilters) => void;
  onReset: () => void;
  onClose: () => void;
  /** The persisted Action vocabulary - the same values the dialogs suggest. */
  actions: BoardAction[];
  /** `showing N of M` - the count that keeps a default window from hiding work. */
  shown: number;
  total: number;
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <span>
        <span className="block text-sm text-slate-800">{label}</span>
        <span className="block text-[11px] text-slate-500">{hint}</span>
      </span>
    </label>
  );
}

/**
 * The Filters panel: what the board shows, and the only place archived cards become
 * visible. Visibility, columns and actions all live here, so the bar above stays three
 * controls wide.
 *
 * It is a popover, not a modal - nothing here is destructive and every change applies
 * immediately - so Escape or a click outside just closes it.
 */
export default function FilterDialog({
  filters,
  onChange,
  onReset,
  onClose,
  actions,
  shown,
  total,
}: FilterDialogProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    // Deferred by a tick: the button that opened this panel is outside it, so its own
    // click would otherwise close the panel again immediately.
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onPointer), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [onClose]);

  const toggleStage = (stage: StageId) => {
    const stages = filters.stages.includes(stage)
      ? filters.stages.filter((item) => item !== stage)
      : [...filters.stages, stage];
    onChange({ ...filters, stages });
  };

  const toggleAction = (value: string) => {
    const selected = filters.actions.includes(value)
      ? filters.actions.filter((item) => item !== value)
      : [...filters.actions, value];
    onChange({ ...filters, actions: selected });
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Filters"
      className="absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-xl"
    >
      <header className="flex items-center justify-between px-2">
        <h2 className="text-sm font-semibold text-slate-900">Filters</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close filters"
          className="rounded px-1.5 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          ✕
        </button>
      </header>

      <section className="mt-2">
        <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Visibility
        </p>
        <Toggle
          label="Active vacancies"
          hint="applications still in play"
          checked={filters.showActive}
          onChange={(showActive) => onChange({ ...filters, showActive })}
        />
        <Toggle
          label="Archived (refused) vacancies"
          hint="shown muted, in the column where they stopped"
          checked={filters.showArchived}
          onChange={(showArchived) => onChange({ ...filters, showArchived })}
        />
      </section>

      <section className="mt-3">
        <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Stages
        </p>
        <div className="mt-1 flex flex-wrap gap-1 px-2">
          {STAGES.map((stage) => {
            const selected = filters.stages.includes(stage.id);
            return (
              <button
                key={stage.id}
                type="button"
                onClick={() => toggleStage(stage.id)}
                aria-pressed={selected}
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  selected
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {stage.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 px-2 text-[11px] text-slate-400">none selected = every column</p>
      </section>

      <section className="mt-3">
        <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Actions
        </p>
        <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200">
          {actions.length === 0 && (
            <p className="px-2 py-3 text-[11px] text-slate-400">
              No actions recorded yet - they appear here as you use them in a dialog.
            </p>
          )}
          {actions.map((action) => (
            <label
              key={action.value}
              className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={filters.actions.includes(action.value)}
                onChange={() => toggleAction(action.value)}
                className="h-3.5 w-3.5"
              />
              <span className="min-w-0 flex-1 truncate">{action.value}</span>
              <span className="text-[10px] uppercase tracking-wide text-slate-400">
                {action.kind === 'archive' ? '⛔️' : '→'} {action.uses}
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1 px-2 text-[11px] text-slate-400">matches any history entry of a card</p>
      </section>

      <footer className="mt-3 flex items-center justify-between border-t border-slate-100 px-2 pt-2">
        <span className="text-[11px] text-slate-500">{summarize(shown, total)}</span>
        <button
          type="button"
          onClick={onReset}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Reset
        </button>
      </footer>
    </div>
  );
}
