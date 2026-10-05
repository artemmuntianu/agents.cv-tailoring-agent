import { useCallback, useEffect, useState } from 'react';
import AppShell from './AppShell';
import { sourceLabel } from '../lib/cardMeta';
import {
  COVER_STATE_CHIP,
  coverActionLabel,
  coverBlockedReason,
  coverState,
  coverStateLabel,
} from '../lib/cover';
import type { CoverLetterState } from '../lib/types';

/**
 * `/cover/<job_id>` - **one vacancy's cover letter**: the text an application will send, and the
 * button that asks the worker for it.
 *
 * The letter used to live as a section of the card modal, where a two-hundred-word block sat between
 * the deliverable links and the interviews. Reading it is its own act, so it is its own page - and the
 * card keeps one link to it, which is where *Generate* went too: asking for a letter belongs beside
 * the letter, not beside the CV links.
 *
 * It is the letter's only reader **and** its only writer:
 *
 * * `GET /api/cover/<job_id>` returns the row (`status`/`text`/`model`/`error`/`updatedAt`) plus the
 *   `vacancy` block that says whose letter it is - the card's cards carry the letter, but the board
 *   ships a hundred of them, which is why a page asks for one;
 * * `POST /api/cover/<job_id>` is the ask - one Gemini call on `resumes.cover`, claimed in
 *   `resume_cover_letter` first so two clicks cannot queue two generations (`lib/coverRequest.ts`).
 *
 * The state machine is `lib/cover.ts`, unit tested; this file decides nothing about it. While the row
 * says `queued`/`running` the page polls itself - the board's 5s poll used to carry that, and a page
 * with no board has to carry it alone.
 */

const POLL_MS = 3000;
/** Give up watching after this: the queue is where a stuck letter is visible (`/processes`). */
const POLL_DEADLINE_MS = 3 * 60 * 1000;

interface CoverVacancy {
  jobId: string;
  source: string;
  externalId: string;
  title: string;
  company: string;
  sourceUrl: string | null;
  hasDescription: boolean;
}

interface CoverPayload extends CoverLetterState {
  vacancy: CoverVacancy | null;
}

interface CoverLetterPageProps {
  jobId: string;
  session: { email: string; name: string | null; admin: boolean };
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '-';
}

export default function CoverLetterPage({ jobId, session }: CoverLetterPageProps) {
  const [payload, setPayload] = useState<CoverPayload | null>(null);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/cover/${encodeURIComponent(jobId)}`);
      const body = (await response.json()) as { ok: boolean; error?: string } & CoverPayload;
      if (!body.ok) {
        setError(body.error || `HTTP ${response.status}`);
        return;
      }
      setError('');
      setPayload(body);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const state = coverState(payload);
  const vacancy = payload?.vacancy ?? null;
  const blocked = coverBlockedReason(vacancy ? vacancy.hasDescription : true);

  // While the worker has it, this page is the only thing that will notice it landing.
  useEffect(() => {
    if (state !== 'queued' && state !== 'running') return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > POLL_DEADLINE_MS) {
        clearInterval(timer);
        return;
      }
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [state, load]);

  /** One ask, then re-read: the row comes back `queued` and the poll above takes over. */
  async function ask() {
    if (asking || blocked) return;
    setAsking(true);
    setCopied(false);
    try {
      const response = await fetch(`/api/cover/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        // Body-less, but Astro's `checkOrigin` refuses a non-GET without a content-type.
        headers: { 'content-type': 'application/json' },
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!body.ok) setError(body.error || `HTTP ${response.status}`);
      else await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setAsking(false);
    }
  }

  async function copy() {
    const text = payload?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <AppShell
      title={vacancy ? vacancy.title || 'Untitled vacancy' : 'Cover letter'}
      subtitle={
        vacancy
          ? `${sourceLabel(vacancy.source)} · ${vacancy.externalId}` +
            (payload?.model ? ` · written by ${payload.model}` : '')
          : `job_id ${jobId}`
      }
      session={session}
      actions={
        <>
          {state === 'completed' && payload?.text && (
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {copied ? '✓ Copied' : 'Copy the letter'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void ask()}
            disabled={asking || state === 'running' || Boolean(blocked)}
            title={blocked ?? 'One Gemini call, on the resumes.cover queue'}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            {asking ? 'Asking…' : coverActionLabel(state)}
          </button>
        </>
      }
    >
      {error && <p className="mb-3 text-sm text-rose-700">{error}</p>}
      {!payload && !error && <p className="text-sm text-slate-500">Reading the letter…</p>}

      {payload && (
        <div className="space-y-3">
          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${COVER_STATE_CHIP[state]}`}>
                {coverStateLabel(state)}
              </span>
              <span className="text-[11px] text-slate-400">
                {state === 'completed' || state === 'failed'
                  ? `last written ${when(payload.updatedAt)}`
                  : 'resume_cover_letter'}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {state === 'completed'
                ? 'The text below is what an application sends, verbatim - the extension pastes it into the form and no model ever sees it again.'
                : 'A letter is written from the stored job description and the master CV, so it can only repeat what the CV already says.'}
            </p>
            {vacancy?.sourceUrl && (
              <p className="mt-2 flex flex-wrap gap-3 text-xs">
                <a
                  href={vacancy.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
                >
                  Open the vacancy posting
                </a>
                <a
                  href={`/vacancy/${encodeURIComponent(jobId)}`}
                  className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
                >
                  Parsed vacancy text
                </a>
              </p>
            )}
          </section>

          <section className="rounded-lg border border-slate-200 bg-white">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-4 py-2">
              <h2 className="text-sm font-semibold text-slate-900">Cover letter</h2>
              <span className="text-[11px] text-slate-500">
                <code>resume_cover_letter.text</code>
              </span>
            </header>

            {blocked ? (
              <p className="px-4 py-3 text-sm text-amber-800">{blocked}</p>
            ) : state === 'completed' && payload.text ? (
              <pre className="max-h-[70vh] overflow-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-800">
                {payload.text}
              </pre>
            ) : state === 'queued' || state === 'running' ? (
              <p className="px-4 py-3 text-sm text-slate-500">
                The cover-letter worker is on it - this page refreshes every few seconds.
              </p>
            ) : state === 'failed' ? (
              <p className="px-4 py-3 text-sm text-rose-700">
                {payload.error || 'the letter could not be written'}
              </p>
            ) : (
              <p className="px-4 py-3 text-sm text-slate-500">
                No cover letter yet - <strong>Generate</strong> asks the worker for one.
              </p>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}
