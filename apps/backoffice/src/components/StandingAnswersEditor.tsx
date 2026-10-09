import { useMemo, useState } from 'react';
import type { CandidateProfile } from '../lib/candidateFacts';
import { MAX_ANSWERS } from '../lib/candidateFacts';
import { answerIssues, answerSummary, answersOf, savePayload } from '../lib/profile';
import JsonTree from './JsonTree';

/**
 * The recruiter Q&A set - the standing answers - as a tree: every question is a row, its answer is
 * edited in place, and a question can be added, reworded or removed.
 *
 * The tree is `JsonTree` - the same surface this page gives `cv_data.json` - and that is what makes
 * the set readable: the page used to `JSON.stringify` it into one line (a 1461-character answer among
 * 21 others), which was neither readable nor editable, and the facts form below deliberately leaves
 * the set alone. This component owns the wiring only: what a valid document is (`answerIssues`), what
 * a save sends (`savePayload`) and how the row reads (`answerSummary`, `answersOf`) are
 * `lib/profile.ts`, unit tested, so none of the rules live in this rendering layer - and which
 * controls the tree offers (add, rename, remove, with drag and type switching left off because an
 * answer is text) is `JsonTree`'s own decision.
 *
 * The page keys this editor by `facts.updatedAt`, so a reload after a save (or a Refresh that finds a
 * different row) remounts it with the stored set, while a Refresh that finds the same row leaves
 * unsaved work in place.
 */
export default function StandingAnswersEditor({
  profile,
  onSaved,
}: {
  profile: CandidateProfile | null;
  onSaved?: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => answersOf(profile));
  // Remounting the tree is how a revert also drops the search filter and the collapse state.
  const [treeKey, setTreeKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const summary = useMemo(() => answerSummary(answers), [answers]);
  const issues = useMemo(() => answerIssues(answers), [answers]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(savePayload(profile, answers)),
      });
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? 'the answers could not be saved');
      setSaved(new Date().toISOString().slice(0, 16).replace('T', ' '));
      setDirty(false);
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the answers could not be saved');
    } finally {
      setBusy(false);
    }
  }

  function revert() {
    setAnswers(answersOf(profile));
    setTreeKey((key) => key + 1);
    setDirty(false);
    setError(null);
    setSaved(null);
  }

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-600">
          <span className="font-medium">Standing answers</span> · {summary.count} of {MAX_ANSWERS}
          {summary.longest > 0 && ` · longest ${summary.longest} of ${summary.cap} chars`}
          {dirty && <span className="ml-2 text-amber-700">unsaved changes</span>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || issues.length > 0}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            {busy ? 'Saving…' : 'Save answers'}
          </button>
          <button
            type="button"
            onClick={revert}
            disabled={!dirty || busy}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            Revert
          </button>
        </div>
      </div>

      {saved && !dirty && <p className="text-xs text-emerald-700">Saved {saved}</p>}
      {error && <p className="text-sm text-rose-700">{error}</p>}

      <JsonTree
        key={treeKey}
        data={answers}
        rootName="standing_answers"
        onChange={(next) => {
          setAnswers(next);
          setDirty(true);
        }}
        searchPlaceholder="Find a question or an answer"
        customText={{
          TOOLTIP_ADD: () => 'Add a standing answer',
          TOOLTIP_EDIT: () => 'Edit this answer',
          TOOLTIP_DELETE: () => 'Remove this question and its answer',
          TOOLTIP_COPY: () => 'Copy the answer',
          DEFAULT_NEW_KEY: () => 'New question',
          EMPTY_STRING: () => 'An empty answer is dropped on save - remove the question instead',
          ERROR_KEY_EXISTS: () => 'A question with this wording already exists',
        }}
      />

      {issues.length > 0 && (
        <ul className="space-y-1 text-xs text-rose-700">
          {issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <span className="font-medium">{issue.path}</span>: {issue.message}
            </li>
          ))}
        </ul>
      )}
      {summary.count === 0 && (
        <p className="text-xs text-amber-800">
          {dirty
            ? 'Saving now clears every stored answer - that is how the row is emptied.'
            : 'No standing answers stored: the prompts then run with no recruiter answers at all. Add one above, or load a whole set with scripts/seed_profile.py.'}
        </p>
      )}
      {dirty && issues.length === 0 && summary.count > 0 && (
        <p className="text-xs text-slate-500">
          A save sends the whole set - a renamed or removed question really leaves the row - and only
          this editor writes it; the facts form below never touches these.
        </p>
      )}
      {!dirty && issues.length === 0 && summary.count > 0 && (
        <p className="text-xs text-slate-500">
          Click an answer to edit it, the pencil to reword its question, ➕ to add one. An answer is
          what the prompt shows after <code>STANDING ANSWER - &lt;question&gt;</code>.
        </p>
      )}
    </div>
  );
}
