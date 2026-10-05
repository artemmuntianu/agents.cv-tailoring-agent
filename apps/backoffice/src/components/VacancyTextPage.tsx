import { useCallback, useEffect, useState } from 'react';
import AppShell from './AppShell';
import { sourceLabel } from '../lib/cardMeta';

/**
 * `/vacancy/<job_id>` - **the parsed job description of one vacancy**, opened from the card's *Parsed
 * vacancy text* button.
 *
 * It answers one question by eye: did the reader produce sane text? The board shows a card, the prompt
 * is handed `resumes.description_raw`, and in between there was nowhere to look at what was actually
 * parsed. So this renders that row's text *verbatim* - whitespace and line breaks kept, nothing
 * re-flowed - beside the little that makes it judgeable: the site and id it came from, its link to the
 * posting, the board's own state, and how much text there is. A description that parses to a single
 * line looks perfectly healthy on a card and ruins a tailored CV, which is the failure this page
 * exists to catch.
 *
 * Read-only: it reads `GET /api/vacancies/text` and writes nothing.
 */

interface VacancyText {
  jobId: string;
  source: string;
  externalId: string;
  title: string;
  company: string;
  sourceUrl: string | null;
  status: string;
  stage: string;
  cvVersion: string;
  text: string | null;
  stats: { chars: number; lines: number; words: number };
}

interface VacancyTextPageProps {
  jobId: string;
  session: { email: string; name: string | null; admin: boolean };
}

/** One labelled fact in the header strip. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-sm break-words text-slate-800">{children}</dd>
    </div>
  );
}

export default function VacancyTextPage({ jobId, session }: VacancyTextPageProps) {
  const [vacancy, setVacancy] = useState<VacancyText | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/vacancies/text?job_id=${encodeURIComponent(jobId)}`);
      const body = (await response.json()) as {
        ok: boolean;
        vacancy?: VacancyText;
        error?: string;
      };
      if (!body.ok || !body.vacancy) {
        setVacancy(null);
        setError(body.error || `HTTP ${response.status}`);
        return;
      }
      setError('');
      setVacancy(body.vacancy);
    } catch (failure) {
      setVacancy(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell
      title={vacancy ? vacancy.title || 'Untitled vacancy' : 'Parsed vacancy text'}
      subtitle={
        vacancy
          ? `${sourceLabel(vacancy.source)} · ${vacancy.externalId} · ${vacancy.stats.chars} characters, ` +
            `${vacancy.stats.lines} lines, ${vacancy.stats.words} words`
          : `job_id ${jobId}`
      }
      session={session}
      actions={
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
        >
          {loading ? 'Loading…' : 'Reload'}
        </button>
      }
    >
      {error && <p className="mb-3 text-sm text-rose-700">{error}</p>}
      {!vacancy && !error && <p className="text-sm text-slate-500">Reading the vacancy…</p>}

      {vacancy && (
        <div className="space-y-3">
          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Fact label="Site">
                {sourceLabel(vacancy.source)}{' '}
                <span className="text-slate-400">({vacancy.source})</span>
              </Fact>
              <Fact label="Vacancy id">{vacancy.externalId}</Fact>
              <Fact label="Company">{vacancy.company || '-'}</Fact>
              <Fact label="Board state">
                {vacancy.stage} · {vacancy.status} · {vacancy.cvVersion}
              </Fact>
            </dl>
            <p className="mt-3 flex flex-wrap items-center gap-3 text-xs">
              {vacancy.sourceUrl ? (
                <a
                  href={vacancy.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
                >
                  Open the vacancy posting
                </a>
              ) : (
                <span className="text-slate-500">no source URL stored</span>
              )}
              <span className="text-slate-500">job_id {vacancy.jobId}</span>
            </p>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-4 py-2">
              <h2 className="text-sm font-semibold text-slate-900">Parsed job description</h2>
              <span className="text-[11px] text-slate-500">
                <code>resumes.description_raw</code> · what the tailoring prompt is given
              </span>
            </header>

            {vacancy.text ? (
              <pre className="max-h-[70vh] overflow-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-800">
                {vacancy.text}
              </pre>
            ) : (
              <p className="px-4 py-3 text-sm text-amber-800">
                No parsed text on this row. The column arrived on 2026-09-26, so a card scraped before
                that carries a description the board never stored - re-scrape the vacancy to fill it in.
              </p>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}
