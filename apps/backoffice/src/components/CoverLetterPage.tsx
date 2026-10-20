import { useEffect, useState } from 'react';
import AppShell from './AppShell';
import { sourceLabel } from '../lib/cardMeta';
import {
  COVER_STATE_CHIP,
  coverActionLabel,
  coverBlockedReason,
  coverState,
  coverStateLabel,
} from '../lib/cover';
import IslandProvider from '../state/IslandProvider';
import { errorMessage } from '../state/api/errors';
import { useAskCoverMutation, useGetCoverQuery } from '../state/cover/api';

interface CoverLetterPageProps {
  jobId: string;
  session: { email: string; name: string | null; admin: boolean };
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '-';
}

const POLL_MS = 3000;
const DEADLINE_MS = 3 * 60 * 1000;

function CoverLetter({ jobId, session }: CoverLetterPageProps) {
  const [copied, setCopied] = useState(false);
  const [askError, setAskError] = useState('');
  const [polling, setPolling] = useState(true);
  const [expired, setExpired] = useState(false);
  const [deadlineKey, setDeadlineKey] = useState(0);

  const { data: payload = null, error: queryError, refetch } = useGetCoverQuery(jobId, {
    pollingInterval: polling && !expired ? POLL_MS : 0,
  });
  const [askCover, askState] = useAskCoverMutation();

  const state = coverState(payload);
  const vacancy = payload?.vacancy ?? null;
  const blocked = coverBlockedReason(vacancy ? vacancy.hasDescription : true);
  const asking = askState.isLoading;
  const error = askError || (queryError ? errorMessage(queryError) : '');

  // A page with no board has to carry the poll itself; it stops when the letter lands.
  useEffect(() => {
    setPolling(state === 'queued' || state === 'running');
  }, [state]);

  // Give up after three minutes even if the row says queued; the queue owns a stuck letter.
  useEffect(() => {
    setExpired(false);
    const timer = window.setTimeout(() => setExpired(true), DEADLINE_MS);
    return () => window.clearTimeout(timer);
  }, [jobId, deadlineKey]);

  function ask() {
    if (asking || blocked) return;
    setCopied(false);
    setAskError('');
    setExpired(false);
    setPolling(true);
    setDeadlineKey((value) => value + 1);
    void (async () => {
      try {
        await askCover(jobId).unwrap();
        await refetch();
      } catch (cause) {
        setAskError(errorMessage(cause));
      }
    })();
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


export default function CoverLetterPage(props: CoverLetterPageProps) {
  return (
    <IslandProvider>
      <CoverLetter {...props} />
    </IslandProvider>
  );
}