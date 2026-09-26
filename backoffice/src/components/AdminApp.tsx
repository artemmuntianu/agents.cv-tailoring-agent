import { useCallback, useEffect, useState } from 'react';
import { VOCABULARY_KINDS, summarizeVocabulary } from '../lib/admin';
import type { BoardAction } from '../lib/types';
import ActionVocabulary from './ActionVocabulary';

interface Vocabulary {
  actions: BoardAction[];
  actors: { value: string; hint: string }[];
  stages: { id: string; label: string; hint: string }[];
  subStates: { id: string; label: string }[];
}

interface AdminAppProps {
  session: { email: string; name: string | null; admin: boolean };
}

/** Read-only rows for the three vocabularies that are fixed in code. */
function ReadOnlyTable({ rows }: { rows: { id: string; label: string; hint: string }[] }) {
  return (
    <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
      {rows.map((row) => (
        <li key={row.id} className="flex items-baseline justify-between gap-3 px-3 py-2">
          <span className="text-sm text-slate-800">{row.label}</span>
          <span className="text-[11px] text-slate-500">{row.hint}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * `/admin` - the vocabulary admin surface, and the only screen a non-admin cannot reach.
 *
 * It edits exactly one list: **Actions** (`board_actions`). The Actor, column and
 * sub-state vocabularies are rendered from the code that defines them, because changing
 * any of them means changing behaviour - the page says so instead of pretending a
 * checkbox could do it.
 */
export default function AdminApp({ session }: AdminAppProps) {
  const [vocabulary, setVocabulary] = useState<Vocabulary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/vocabulary');
      if (response.status === 401) {
        window.location.assign('/login?next=/admin');
        return;
      }
      const payload = (await response.json()) as {
        ok: boolean;
        actions?: BoardAction[];
        actors?: Vocabulary['actors'];
        stages?: Vocabulary['stages'];
        subStates?: Vocabulary['subStates'];
        error?: string;
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setVocabulary({
        actions: payload.actions ?? [],
        actors: payload.actors ?? [],
        stages: payload.stages ?? [],
        subStates: payload.subStates ?? [],
      });
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

  /** One write, then re-read: the database is the display here too. */
  async function mutate(
    method: 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
    query?: string,
    success?: string,
  ): Promise<boolean> {
    setBusy(true);
    let failure: string | null = null;
    try {
      const response = await fetch(`/api/admin/actions${query ?? ''}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
    await load();
    setBusy(false);
    setError(failure);
    setNote(failure ? null : (success ?? null));
    return failure === null;
  }

  const summary = vocabulary ? summarizeVocabulary(vocabulary.actions) : null;

  /** Sign out for real (the board island does the same): clear the cookie, then land. */
  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }


  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Vocabularies</h1>
          <p className="text-xs text-slate-500">
            {session.name ? `${session.name} · ` : ''}
            {session.email} · administrator
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Board
          </a>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-5">
        {error && (
          <p className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}
        {note && (
          <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {note}
          </p>
        )}

        {loading && !vocabulary && <p className="text-sm text-slate-500">Loading…</p>}

        {vocabulary && (
          <div className="space-y-6">
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">Actions</h2>
                  <p className="text-xs text-slate-500">
                    What the Archive and Move dialogs suggest, and what the board&rsquo;s Filters
                    panel offers. Typing a value in a dialog adds it here too.
                  </p>
                </div>
                {summary && (
                  <p className="text-[11px] text-slate-500">
                    {summary.total} live ({summary.refusals} refusal · {summary.progress} progress)
                    {summary.retired > 0 ? ` · ${summary.retired} retired` : ''}
                  </p>
                )}
              </div>

              <ActionVocabulary
                actions={vocabulary.actions}
                busy={busy}
                kinds={VOCABULARY_KINDS}
                onAdd={(value, kind) =>
                  mutate('POST', { value, kind }, undefined, `Added “${value}”.`)
                }
                onRename={(from, to) =>
                  mutate('PATCH', { from, to }, undefined, `“${from}” is now “${to}”.`)
                }
                onDelete={(value) =>
                  mutate(
                    'DELETE',
                    undefined,
                    `?value=${encodeURIComponent(value)}`,
                    `Removed “${value}”.`,
                  )
                }
              />
            </section>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-slate-900">Actors</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Fixed: <code>resume_history.actor</code> is a DB CHECK, and both dialogs read
                  this pair.
                </p>
                <ReadOnlyTable
                  rows={vocabulary.actors.map((actor) => ({
                    id: actor.value,
                    label: actor.value,
                    hint: actor.hint,
                  }))}
                />
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-slate-900">Columns</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Fixed: the board&rsquo;s shape (<code>isStageId</code>); archived is a state, never
                  a column.
                </p>
                <ReadOnlyTable
                  rows={vocabulary.stages.map((stage) => ({
                    id: stage.id,
                    label: stage.label,
                    hint: stage.hint,
                  }))}
                />
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-slate-900">Tailoring sub-states</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Derived: <code>tailoringFromStatus</code> maps the worker&rsquo;s own status onto
                  these.
                </p>
                <ReadOnlyTable
                  rows={vocabulary.subStates.map((state) => ({
                    id: state.id,
                    label: state.label,
                    hint: 'read-only',
                  }))}
                />
              </section>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
