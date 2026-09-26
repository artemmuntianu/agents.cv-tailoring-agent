import { useMemo, useState } from 'react';
import { sortVocabulary, type VocabularyKind } from '../lib/admin';
import type { BoardAction } from '../lib/types';

interface ActionVocabularyProps {
  actions: BoardAction[];
  kinds: { id: VocabularyKind; label: string; hint: string }[];
  busy: boolean;
  onAdd: (value: string, kind: VocabularyKind) => Promise<boolean>;
  onRename: (from: string, to: string) => Promise<boolean>;
  onDelete: (value: string) => Promise<boolean>;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * The editable Action vocabulary: add, reword, remove - plus the values that only history
 * knows, shown struck through and marked `retired` (no longer suggested, still filterable,
 * and `Add back` puts them in the vocabulary again).
 *
 * Deleting or renaming never rewrites `resume_history` or a card's refusal reason: the
 * audit trail keeps the words it was recorded with, which is why the note under the table
 * says so out loud.
 */
export default function ActionVocabulary({
  actions,
  kinds,
  busy,
  onAdd,
  onRename,
  onDelete,
}: ActionVocabularyProps) {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState({ value: '', kind: 'archive' as VocabularyKind });
  const [editing, setEditing] = useState<{ from: string; to: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const rows = useMemo(() => {
    const sorted = sortVocabulary(actions);
    const needle = query.trim().toLowerCase();
    return needle ? sorted.filter((action) => action.value.toLowerCase().includes(needle)) : sorted;
  }, [actions, query]);

  const untouched =
    editing !== null && editing.from.trim().toLowerCase() === editing.to.trim().toLowerCase();

  async function submitDraft(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !draft.value.trim()) return;
    const added = await onAdd(draft.value, draft.kind);
    if (added) setDraft({ value: '', kind: draft.kind });
  }

  async function submitRename() {
    if (!editing || busy || untouched) return;
    const renamed = await onRename(editing.from, editing.to);
    if (renamed) setEditing(null);
  }

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <form onSubmit={submitDraft} className="flex flex-1 flex-wrap items-center gap-2">
          <input
            value={draft.value}
            onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            placeholder="New wording…"
            aria-label="New action wording"
            className="min-w-48 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
          />
          <select
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as VocabularyKind })}
            aria-label="Which dialog offers it"
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800"
          >
            {kinds.map((kind) => (
              <option key={kind.id} value={kind.id}>
                {kind.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy || !draft.value.trim()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Add
          </button>
        </form>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter…"
          aria-label="Filter actions"
          className="w-40 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400"
        />
      </div>

      <table className="mt-3 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-400">
            <th className="py-1 font-medium">Wording</th>
            <th className="py-1 font-medium">Used in</th>
            <th className="py-1 font-medium">Uses</th>
            <th className="py-1 font-medium">Last used</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-3 text-center text-xs text-slate-400">
                nothing matches
              </td>
            </tr>
          )}
          {rows.map((action) => {
            const retired = action.catalogued === false;
            return (
              <tr
                key={action.value}
                className={`border-b border-slate-100 ${
                  retired ? 'text-slate-400' : 'text-slate-700'
                }`}
              >
                <td className="py-1.5 pr-2">
                  {editing?.from === action.value ? (
                    <span className="flex items-center gap-1">
                      <input
                        value={editing.to}
                        autoFocus
                        onChange={(event) =>
                          setEditing({ from: editing.from, to: event.target.value })
                        }
                        aria-label={`New wording for ${action.value}`}
                        className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
                      />
                      <button
                        type="button"
                        onClick={() => void submitRename()}
                        disabled={busy || untouched}
                        className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:bg-slate-300"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className={retired ? 'line-through' : ''}>{action.value}</span>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-[11px]">
                  {action.kind === 'archive' ? '⛔️ refusal' : '→ progress'}
                </td>
                <td className="py-1.5 pr-2 tabular-nums">{action.uses}</td>
                <td className="py-1.5 pr-2 text-[11px]">{formatDate(action.lastUsedAt)}</td>
                <td className="py-1.5 text-right">
                  {retired ? (
                    <span className="flex items-center justify-end gap-2">
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 ring-1 ring-amber-200">
                        retired
                      </span>
                      <button
                        type="button"
                        onClick={() => void onAdd(action.value, action.kind)}
                        disabled={busy}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        Add back
                      </button>
                    </span>
                  ) : confirming === action.value ? (
                    <span className="flex items-center justify-end gap-2">
                      <span className="text-[11px] text-rose-700">remove it?</span>
                      <button
                        type="button"
                        onClick={async () => {
                          await onDelete(action.value);
                          setConfirming(null);
                        }}
                        disabled={busy}
                        className="rounded-md bg-rose-600 px-2 py-1 text-xs font-medium text-white disabled:bg-slate-300"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing({ from: action.value, to: action.value })}
                        disabled={busy}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(action.value)}
                        disabled={busy}
                        className="rounded-md border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Renaming or deleting never rewrites history: cards already refused or moved keep the
        words they were recorded with, and such a value stays filterable - shown struck through
        as <em>retired</em>, and re-addable.
      </p>
    </>
  );
}