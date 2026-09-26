import { statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { storedPathName } from './artifact-link';

/**
 * Where the worker's artifacts are *on the machine this server runs on*.
 *
 * The variable names are the ones `config.py` reads, so the two sides cannot drift:
 * `ARTIFACTS_DIR` (default `artifacts/` in the repo; `/data` - the `cv-artifacts`
 * PVC - in the cluster) and `OUTPUT_DIR` (default `<ARTIFACTS_DIR>/output`).
 *
 * In dev the cluster volume is not here, so the operator mirrors it with
 * `.\scripts\storage-files.ps1 -Action download`, which writes exactly into
 * `artifacts\output\` - the default below. When a file is missing this module returns
 * null and the route explains how to get it, instead of pretending it does not exist.
 */
export function artifactsDir(): string {
  const explicit = process.env.ARTIFACTS_DIR?.trim();
  return explicit ? resolve(explicit) : resolve(process.cwd(), '..', 'artifacts');
}

export function outputDir(): string {
  const explicit = process.env.OUTPUT_DIR?.trim();
  return explicit ? resolve(explicit) : join(artifactsDir(), 'output');
}

/**
 * Absolute path of one artifact, or null when it is not on disk here.
 *
 * The stored value is untrusted: only its file name is used, and the result is
 * refused unless it still sits directly inside `dir`, so a crafted row cannot walk
 * out of the artifact root (`../../` or an absolute path).
 */
export function resolveArtifact(
  storedPath: string | null | undefined,
  dir: string = outputDir(),
): string | null {
  const name = storedPathName(storedPath);
  if (!name) return null;

  const root = resolve(dir);
  const candidate = resolve(root, name);
  if (candidate !== join(root, name) || !candidate.startsWith(root + sep)) return null;

  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

export function contentTypeFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return 'application/octet-stream';
}

/** What to tell the operator when the file is not on the board's machine yet. */
export const ARTIFACT_HINT =
  'run `.\\scripts\\storage-files.ps1 -Action download` to mirror the cluster volume into ' +
  '`artifacts\\output`, or point ARTIFACTS_DIR/OUTPUT_DIR at the volume.';
