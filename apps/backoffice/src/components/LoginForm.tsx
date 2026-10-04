import { useState } from 'react';

interface LoginFormProps {
  /** Where to go after a successful login (from `?next=`). */
  next: string;
}

/** The only auth surface: sign in with credentials an administrator provisioned. */
export default function LoginForm({ next }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      window.location.assign(next || '/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
      <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
      <p className="mt-0.5 text-xs text-slate-500">
        Accounts are created by the administrator - there is no signup.
      </p>

      <label className="mt-5 block text-xs font-medium uppercase tracking-wide text-slate-500">
        Email
        <input
          type="email"
          required
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-900"
        />
      </label>

      <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-500">
        Password
        <input
          type="password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-900"
        />
      </label>

      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="mt-5 w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
