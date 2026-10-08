import { useId, useState, type FormEvent } from 'react';
import AppShell from './AppShell';
import {
  EMPTY_MANUAL_DRAFT,
  SOURCE_SUGGESTIONS,
  isSourceSlug,
  manualApplyDetails,
  manualBatchBody,
  normalizeSourceSlug,
  parseManualVacancy,
  type ManualVacancyDraft,
} from '../lib/manual';

interface NewVacancyPageProps {
  session: { email: string; name: string | null; admin: boolean };
}

/** What the last submit did, so the page can say it plainly rather than "it worked". */
type Outcome = { kind: 'created'; applyUrlWarning: string | null } | { kind: 'duplicate' };

const LABEL = 'mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500';
const INPUT =
  'mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-900 placeholder:text-slate-400';
const HINT = 'mt-1 block text-[11px] font-normal normal-case tracking-normal text-slate-400';

/**
 * `/new-vacancy` - the manual half of the intake: a vacancy the operator found themselves.
 *
 * A **page** rather than a board dialog for the same reason `/processes` is one: this is a wall of
 * text plus a handful of fields, and the board's chrome (the panel, the header, the operator's own
 * place in the app) should not vanish behind a modal while it is filled in.
 *
 * It posts to `POST /api/vacancies/batch` - **the gateway the Chrome extension uses** - with one
 * vacancy in the body (`lib/manual.ts`), so a hand-typed card is validated, de-duplicated and filed
 * by exactly the code a scraped one is. Nothing is queued: the card lands in **Scraped**, and the
 * operator's drag into Prepare is what spends Gemini, exactly as for a scrape.
 */
export default function NewVacancyPage({ session }: NewVacancyPageProps) {
  const [draft, setDraft] = useState<ManualVacancyDraft>(EMPTY_MANUAL_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // The Site field's suggestion list deserves its own id per instance (`ActionCombobox` does the
  // same), so two of these on one page could never share a datalist.
  const siteListId = useId();

  function edit<K extends keyof ManualVacancyDraft>(key: K, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setOutcome(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setOutcome(null);

    const parsed = parseManualVacancy(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/vacancies/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(manualBatchBody(parsed.value)),
      });
      if (response.status === 401) {
        // The 8h session expired; the login page sends us back here afterwards.
        window.location.assign('/login?next=/new-vacancy');
        return;
      }
      const payload = (await response.json()) as {
        ok: boolean;
        created?: number;
        duplicates?: number;
        jobIds?: string[];
        error?: string;
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);

      const jobId = payload.jobIds?.[0];
      if (!payload.created || !jobId) {
        setOutcome({ kind: 'duplicate' });
        return;
      }

      // The application URL is the card's own Details field, so it goes through that route - one
      // implementation of what an application URL is, and of its canonical form. A failure here is
      // reported rather than hidden: the card exists either way.
      let applyUrlWarning: string | null = null;
      const details = manualApplyDetails(jobId, parsed.value);
      if (details) {
        try {
          const saved = await fetch('/api/board/details', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(details),
          });
          const savedBody = (await saved.json()) as { ok: boolean; error?: string };
          if (!saved.ok || !savedBody.ok) throw new Error(savedBody.error ?? `HTTP ${saved.status}`);
        } catch (cause) {
          applyUrlWarning = cause instanceof Error ? cause.message : String(cause);
        }
      }

      setOutcome({ kind: 'created', applyUrlWarning });
      setDraft(EMPTY_MANUAL_DRAFT);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      active="new-vacancy"
      title="New vacancy"
      subtitle="Add a vacancy you found yourself - it lands in Scraped, and the drag into Prepare tailors it"
      session={session}
    >
      <div className="mx-auto max-w-2xl">
        {outcome?.kind === 'created' && (
          <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <p className="font-medium">Added to Scraped.</p>
            <p className="mt-0.5">
              Open the{' '}
              <a className="underline" href="/">
                board
              </a>{' '}
              and drag it into Prepare when you want its CV tailored.
            </p>
            {outcome.applyUrlWarning && (
              <p className="mt-1 text-[11px] text-amber-800">
                The card was created, but its application URL did not save (
                {outcome.applyUrlWarning}). Set it from the card&rsquo;s Details.
              </p>
            )}
          </div>
        )}

        {outcome?.kind === 'duplicate' && (
          <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            That posting is already on the board - nothing was created. A card is keyed on its
            posting URL, so one link cannot become two cards.
          </p>
        )}

        {error && (
          <p className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}

        <form onSubmit={submit} className="rounded-lg border border-slate-200 bg-white px-5 py-4">
          <p className="text-xs text-slate-500">
            Four fields are required: the title, the company, the description and the posting URL.
          </p>

          <label className={LABEL}>
            Job title *
            <input
              value={draft.title}
              onChange={(event) => edit('title', event.target.value)}
              placeholder="Software Engineer - Developer Experience"
              className={INPUT}
            />
          </label>

          <label className={LABEL}>
            Company *
            <input
              value={draft.company}
              onChange={(event) => edit('company', event.target.value)}
              placeholder="Dremio"
              className={INPUT}
            />
          </label>

          <label className={LABEL}>
            Job description *
            <textarea
              value={draft.descriptionRaw}
              onChange={(event) => edit('descriptionRaw', event.target.value)}
              rows={12}
              placeholder="Paste the whole posting - responsibilities, requirements, tech stack…"
              className={INPUT}
            />
            <span className={HINT}>
              The tailoring prompt reads this text; it is the one field a run cannot do without.
            </span>
          </label>

          <label className={LABEL}>
            Posting URL *
            <input
              type="url"
              value={draft.sourceUrl}
              onChange={(event) => edit('sourceUrl', event.target.value)}
              placeholder="https://job-boards.greenhouse.io/dremio/jobs/7822098003"
              className={INPUT}
            />
            <span className={HINT}>
              Where the vacancy is published. The card is keyed on it, so the same link cannot be
              added twice.
            </span>
          </label>

          <label className={LABEL}>
            Application URL
            <input
              type="url"
              value={draft.applyUrl}
              onChange={(event) => edit('applyUrl', event.target.value)}
              placeholder="https://job-boards.greenhouse.io/embed/job_app?for=dremio&token=…"
              className={INPUT}
            />
            <span className={HINT}>
              Only when Apply lands somewhere other than the posting (an ATS form). The extension&rsquo;s
              <em> Populate</em> matches this card by it on that page.
            </span>
          </label>

          <label className={LABEL}>
            Site
            <input
              list={siteListId}
              value={draft.source}
              onChange={(event) => edit('source', event.target.value)}
              placeholder="other"
              className={INPUT}
            />
            <datalist id={siteListId}>
              {SOURCE_SUGGESTIONS.map((suggestion) => (
                <option key={suggestion.slug} value={suggestion.slug}>
                  {suggestion.label}
                </option>
              ))}
            </datalist>
            {isSourceSlug(draft.source) ? (
              <span className={HINT}>
                Pick a site the board knows, or type your own slug (lower-case letters, digits and
                dashes). It is half of the card&rsquo;s identity. Leave it empty to file the card
                under <code>other</code>.
              </span>
            ) : (
              <span className="mt-1 block text-[11px] font-normal normal-case tracking-normal text-amber-700">
                &ldquo;{normalizeSourceSlug(draft.source)}&rdquo; is not a slug - use lower-case
                letters, digits and dashes only.
              </span>
            )}
          </label>

          <div className="mt-5 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                setDraft(EMPTY_MANUAL_DRAFT);
                setError(null);
                setOutcome(null);
              }}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Clear
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {busy ? 'Adding…' : 'Add to Scraped'}
            </button>
          </div>
        </form>

        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          A card added here carries an id derived from its posting URL, so the scrapers&rsquo; own
          de-dupe does not recognise it: scraping the same posting later can file a second card
          (remove it like any other). Nothing is queued until you drag the card into Prepare.
        </p>
      </div>
    </AppShell>
  );
}
