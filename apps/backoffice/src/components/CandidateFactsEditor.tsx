import { useState } from 'react';
import type { FormEvent } from 'react';

/**
 * The `application_profile` row as a form - the one editor the candidate facts have.
 *
 * They are per-operator data in Postgres, read by all three prompts, and until now the only way to
 * change them was `scripts/seed_profile.py` over a JSON file (`/sources` rendered them, nothing
 * wrote them). That is the wrong shape for the fact an application form asks for by name: a fact
 * the prompt *has* is a field the extension can fill, and a missing one is a field left to the
 * operator - so the surface for "the form asked for my phone" belongs beside the row it changes.
 *
 * `GET /api/profile` supplies the values *and* the key list (`facts`), so this component never
 * hardcodes a vocabulary that `apps/worker/utils/candidate.py` owns. The same call reports how many
 * standing answers the row carries: `PUT` replaces the facts wholesale - that is what makes an
 * emptied field a deletion rather than a blank - but it *merges* `standing_answers`, and this
 * component deliberately never sends that key, so a save here cannot wipe the recruiter answers.
 */

interface ProfilePayload {
  ok: boolean;
  profile: { facts: Record<string, string>; standing_answers: Record<string, string> } | null;
  facts: string[];
}

/** `full_name` -> `Full name`: the route owns the keys, this is only what the label reads. */
function labelFor(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default function CandidateFactsEditor({ onSaved }: { onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function edit() {
    setError(null);
    setSaved(null);
    try {
      const response = await fetch('/api/profile');
      const data = (await response.json()) as ProfilePayload;
      if (!response.ok || !data.ok) throw new Error('the stored facts could not be read');
      const stored = data.profile?.facts ?? {};
      setKeys(data.facts);
      setValues(Object.fromEntries(data.facts.map((key) => [key, stored[key] ?? ''])));
      setAnswers(Object.keys(data.profile?.standing_answers ?? {}).length);
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the stored facts could not be read');
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? 'the facts could not be saved');
      setSaved(new Date().toISOString().slice(0, 16).replace('T', ' '));
      setOpen(false);
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the facts could not be saved');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void edit()}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700"
        >
          Edit facts
        </button>
        {saved && <span className="text-xs text-emerald-700">Saved {saved}</span>}
        {error && <span className="text-xs text-rose-700">{error}</span>}
      </div>
    );
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {keys.map((key) => (
          <label key={key} className="text-xs text-slate-600">
            <span className="block font-medium">{labelFor(key)}</span>
            <input
              value={values[key] ?? ''}
              onChange={(event) => setValues({ ...values, [key]: event.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
            />
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        A fact the prompt has is a form field the extension can fill; a missing one is a field left
        to you. An emptied field is deleted rather than stored blank.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {busy ? 'Saving…' : 'Save facts'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700"
        >
          Cancel
        </button>
        <span className="text-xs text-slate-500">
          {answers > 0
            ? `${answers} standing answers are kept untouched - scripts/seed_profile.py is what changes those.`
            : 'No standing answers stored yet (scripts/seed_profile.py loads a whole set).'}
        </span>
      </div>
      {error && <p className="text-sm text-rose-700">{error}</p>}
    </form>
  );
}
