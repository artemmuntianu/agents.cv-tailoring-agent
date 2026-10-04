import { useId } from 'react';
import { rankActions } from '../lib/actions';
import type { BoardAction } from '../lib/types';

interface ActionComboboxProps {
  value: string;
  onChange: (value: string) => void;
  /** Which vocabulary to rank first: 'archive' (refusals) or 'move' (progress). */
  kind: BoardAction['kind'];
  /** The persisted catalogue (see `lib/actions.ts`), loaded with the board. */
  actions: BoardAction[];
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * The Action field: a free-text input with the persisted vocabulary behind it, i.e. a
 * dropdown you can also type into (`<input list>` + `<datalist>` - native keyboard and
 * screen-reader behaviour, no dependency).
 *
 * Every value it offers came from the database (`board_actions`), including the ones the
 * operator typed themselves - so the wording that worked last week is one keystroke away
 * this week, and the Filters dialog can filter by the very same values.
 */
export default function ActionCombobox({
  value,
  onChange,
  kind,
  actions,
  label = 'Action',
  placeholder = 'Select an action or type a new one (required)',
  autoFocus = false,
}: ActionComboboxProps) {
  const listId = useId();
  const suggestions = rankActions(actions, { kind });

  return (
    <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-500">
      {label}
      <input
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-900 placeholder:text-slate-400"
      />
      <datalist id={listId}>
        {suggestions.map((action) => (
          <option key={action.value} value={action.value}>
            {action.uses > 0 ? `used ${action.uses}×` : action.kind}
          </option>
        ))}
      </datalist>
    </label>
  );
}
