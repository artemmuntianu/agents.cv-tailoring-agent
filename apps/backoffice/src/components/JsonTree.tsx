import { useState } from 'react';
import { JsonEditor, JsonViewer } from 'json-edit-react';
import type { CustomTextDefinitions } from 'json-edit-react';
import 'json-edit-react/style.css';

/**
 * One JSON document of `/sources`, as a tree - the page's shared reading surface.
 *
 * The page used to print these documents as flattened lines, which is how a 1461-character answer
 * became one `<pre>` row and how `cv_data.json` arrived as five blocks of wall-of-text. A JSON
 * document deserves a JSON view: collapsible keys, values edited in place, one search box over keys
 * *and* values, and a copy button on every value.
 *
 * `readOnly` is the library's own **viewer**, not an editor with its controls suppressed - it renders
 * no edit, add or delete affordance at all. That is what the artifact files get: the board can read
 * the volume but never write it (`lib/sources.ts`), so an editable tree there would be a control with
 * nothing behind it.
 *
 * Decisions stay with the caller: the document, the save and what counts as a valid edit belong to
 * the owner of the data (`StandingAnswersEditor` over `lib/profile.ts`, `SourcesPage` for the model).
 * This component only picks the library's props and keeps them identical for both callers.
 */

export interface JsonTreeProps {
  data: Record<string, unknown>;
  /** The key the whole document hangs off - the file name or the row's own key. */
  rootName: string;
  /** The library's viewer: no edit, add, delete or drag control is rendered. */
  readOnly?: boolean;
  /** Required when `readOnly` is false - the editor is controlled, so the parent holds the document. */
  onChange?: (data: Record<string, unknown>) => void;
  searchPlaceholder?: string;
  /** How much of a value a row shows before the library offers "show more". */
  previewChars?: number;
  /** The editor's button tooltips; the caller words them for the document it owns. */
  customText?: CustomTextDefinitions;
}

/** What both modes take, so the two branches cannot drift apart. */
const SHARED = {
  searchFilter: 'all',
  minWidth: 280,
  maxWidth: '100%',
  baseFontSize: '0.75rem',
  showCollectionCount: true,
} as const;

export default function JsonTree({
  data,
  rootName,
  readOnly = false,
  onChange,
  searchPlaceholder = 'Find a key or a value',
  previewChars = 160,
  customText,
}: JsonTreeProps) {
  const [search, setSearch] = useState('');

  return (
    <div className="space-y-2">
      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={searchPlaceholder}
        className="w-64 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-900"
      />
      {readOnly ? (
        <JsonViewer
          {...SHARED}
          data={data}
          rootName={rootName}
          searchText={search}
          stringTruncateLength={previewChars}
        />
      ) : (
        <JsonEditor
          {...SHARED}
          data={data}
          rootName={rootName}
          searchText={search}
          stringTruncateLength={previewChars}
          setData={(next) => onChange?.(next)}
          allowDrag={false}
          allowTypeSelection={false}
          customText={customText}
        />
      )}
    </div>
  );
}
