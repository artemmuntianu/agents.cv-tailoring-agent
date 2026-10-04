/**
 * Isomorphic artifact helpers - no node builtins, because React islands import this.
 *
 * `resumes.pdf_url` / `resumes.docx_path` are the worker's **storage paths**
 * (`/data/output/848944.pdf` in the cluster), not URLs: linking one from the browser
 * resolves it against the board's own origin and 404s. Everything the UI links goes
 * through `artifactUrl()`, and the server-side resolution lives in `artifacts.ts`.
 */

/** Board-side link to one artifact - never the raw `pdf_url` from the row. */
export function artifactUrl(jobId: string, format: 'pdf' | 'docx' = 'pdf'): string {
  const base = `/api/artifacts/${encodeURIComponent(jobId)}`;
  return format === 'docx' ? `${base}?format=docx` : base;
}

/** Last path component of a stored artifact path (`/data/output/848944.pdf` -> `848944.pdf`). */
export function storedPathName(storedPath: string | null | undefined): string | null {
  if (!storedPath) return null;
  const parts = storedPath.trim().split(/[\\/]/);
  const name = parts[parts.length - 1] ?? '';
  if (!name || name === '.' || name === '..') return null;
  return name;
}
