import { useCallback, useEffect, useState } from 'react';
import AppShell from './AppShell';
import CandidateFactsEditor from './CandidateFactsEditor';
import type { CandidateProfile } from '../lib/candidate';
import type { CvModelSource, FileSource, ModelStateSource } from '../lib/sources';

/**
 * `/sources` - **what the generated CV and cover letter are built from**.
 *
 * The board shows the output; the inputs behind it were invisible: the master CV model
 * (`cv_data.json`), the master document it is checked against (`input/cv.docx`), the operator's
 * candidate facts (the `application_profile` row) and the model rotation state that decides which
 * model wrote the last document. The vacancy itself (`resumes.description_raw`) is the fourth input
 * and stays on the card, where it belongs.
 *
 * Read-only except for one row: the three *files* are only ever rendered - the route reads, and a
 * source that is not on this machine is reported with its path and the command that mirrors it
 * rather than shown as empty - while the candidate facts are operator data in Postgres and have an
 * editor of their own (`CandidateFactsEditor`, over `PUT /api/profile`).
 */

interface FactsSource {
  present: boolean;
  updatedAt: string | null;
  profile: CandidateProfile | null;
}

interface SourcesPayload {
  cvModel: CvModelSource;
  masterCv: FileSource;
  modelState: ModelStateSource;
  facts: FactsSource;
}

interface SourcesPageProps {
  session: { email: string; name: string | null; admin: boolean };
}

function bytes(value: number | null): string {
  if (value === null) return '-';
  return value < 1024 ? `${value} B` : `${Math.round(value / 1024)} KB`;
}

function when(value: string | null): string {
  return value ? value.replace('T', ' ').slice(0, 16) : '-';
}

/** One source: its file, its state, and what reads it. */
function Block({
  title,
  consumers,
  children,
}: {
  title: string;
  consumers: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <span className="text-[11px] text-slate-500">read by: {consumers}</span>
      </div>
      <div className="mt-3 space-y-2 text-sm text-slate-700">{children}</div>
    </section>
  );
}

function FileLine({ file, extra }: { file: FileSource; extra?: string }) {
  return (
    <p className="text-xs text-slate-500">
      {file.present ? (
        <>
          <code className="rounded bg-slate-100 px-1 py-0.5">{file.path}</code> ·{' '}
          {bytes(file.sizeBytes)} · modified {when(file.modifiedAt)}
          {extra ? ` · ${extra}` : ''}
        </>
      ) : (
        <>
          <strong className="text-amber-800">not on this machine</strong> -{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5">{file.path}</code>. Mirror the volume
          with <code>.\scripts\storage-files.ps1 -Action download</code>.
        </>
      )}
    </p>
  );
}

function Pre({ lines }: { lines: string[] }) {
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs text-slate-800">
      {lines.join('\n')}
    </pre>
  );
}

export default function SourcesPage({ session }: SourcesPageProps) {
  const [sources, setSources] = useState<SourcesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/sources');
      if (response.status === 401) {
        window.location.assign('/login?next=/sources');
        return;
      }
      const payload = (await response.json()) as {
        ok: boolean;
        sources?: SourcesPayload;
        error?: string;
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setSources(payload.sources ?? null);
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

  const facts = sources?.facts;

  return (
    <AppShell
      active="sources"
      title="Sources of truth"
      subtitle="What the generated CV and cover letter are built from - the files are read-only, the candidate facts are editable"
      session={session}
      actions={
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      }
    >
      {error && <p className="mb-3 text-sm text-rose-700">{error}</p>}
      {!sources && !error && <p className="text-sm text-slate-500">Reading the sources…</p>}

      {sources && (
        <div className="space-y-3">
          <Block
            title="Master CV model - cv_data.json"
            consumers="tailoring prompt · cover letter · the DOCX mutations"
          >
            <FileLine file={sources.cvModel} />
            {sources.cvModel.parseError && (
              <p className="text-sm text-rose-700">Unreadable: {sources.cvModel.parseError}</p>
            )}
            {sources.cvModel.sections.map((section) => (
              <div key={section.title}>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {section.title}
                </p>
                <Pre lines={section.lines} />
              </div>
            ))}
            <p className="text-xs text-slate-500">
              A section that exists in the document but not in this model never reaches the prompt
              (the JSON ⊆ DOCX rule), which is why the model - not the document - is what every
              replacement is checked against.
            </p>
          </Block>

          <Block
            title="Master CV document - input/cv.docx"
            consumers="the mutation target of every run"
          >
            <FileLine
              file={sources.masterCv}
              extra="binary: this page shows the model above, not this file's text"
            />
          </Block>

          <Block
            title="Candidate facts - application_profile row"
            consumers="tailoring prompt · cover letter · application-form draft"
          >
            {!facts?.present && (
              <p className="text-sm text-amber-800">
                No facts stored for this account yet: the three prompts run with an empty facts
                block, so nothing the CV text does not state can be surfaced. Fill them in below -
                or load a whole answer set with <code>scripts/seed_profile.py</code>.
              </p>
            )}
            {facts?.present && (
              <>
                <p className="text-xs text-slate-500">Stored {when(facts.updatedAt)}</p>
                <Pre
                  lines={Object.entries(facts.profile ?? {}).map(
                    ([key, value]) =>
                      `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`,
                  )}
                />
                <p className="text-xs text-slate-500">
                  Ground truth about the candidate, never document text: a prompt may surface a fact
                  the CV omits, and no prompt may write contacts, salary, availability or work
                  format into the CV or a letter.
                </p>
              </>
            )}
            <CandidateFactsEditor onSaved={() => void load()} />
          </Block>

          <Block
            title="Model rotation - model_state.json"
            consumers="every model call (the per-model daily quota)"
          >
            <FileLine file={sources.modelState} />
            {sources.modelState.note && (
              <p className="text-sm text-rose-700">{sources.modelState.note}</p>
            )}
            <p className="text-xs text-slate-500">
              Active:{' '}
              <strong>
                {sources.modelState.active ?? "unknown (the worker's ladder decides per task)"}
              </strong>
            </p>
            {sources.modelState.quiesced.length > 0 && (
              <Pre
                lines={sources.modelState.quiesced.map(
                  (entry) => `${entry.model} → quiet until ${when(entry.until)}`,
                )}
              />
            )}
            {sources.modelState.lines.length > 0 && <Pre lines={sources.modelState.lines} />}
          </Block>
        </div>
      )}
    </AppShell>
  );
}

