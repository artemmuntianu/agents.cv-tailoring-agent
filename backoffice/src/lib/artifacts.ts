import { statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { storedPathName } from './artifact-link';

/**
 * Where the worker's artifacts are *on the machine this server runs on*.
 *
 * The variable names are the ones `config.py` reads, so the two sides cannot drift:
 * `ARTIFACTS_DIR` (default `artifacts/` in the repo; `/data` - the `cv-artifacts`
 * PVC - in the cluster) and `OUTPUT_DIR` (default `<ARTIFACTS_DIR>/output`).
 *
 * On a dev machine the cluster volume is a *foreign* filesystem, so there are two ways to
 * point the board at the worker's documents, and both are pure configuration:
 *
 *   1. `OUTPUT_DIR` = the cluster volume as the host sees it. Docker Desktop keeps its PVs on
 *      the VM disk, which Windows reaches through WSL
 *      (`\\wsl$\<distro>\mnt\docker-desktop-disk\data\k8s-pvs\<pvc>\output`).
 *      `.\scripts\storage-files.ps1 -Action path` prints that path ready to paste. Nothing is
 *      copied, and `isWorkerVolumeRoot` treats it as the real volume, so a removal deletes the
 *      worker's file.
 *   2. `OUTPUT_DIR` = a mirror under `artifacts\output`, refreshed with
 *      `.\scripts\storage-files.ps1 -Action download`.
 *
 * When a file is in neither place this module returns null and the route explains how to get
 * it, instead of pretending it does not exist.
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
  'point OUTPUT_DIR at the cluster volume (`.\\scripts\\storage-files.ps1 -Action path` prints ' +
  'the path Docker Desktop exposes it at), or mirror it with ' +
  '`.\\scripts\\storage-files.ps1 -Action download`.';

/**
 * True when the board's artifact root **is** the directory the worker stored the path in -
 * i.e. the board is looking at the real volume (in-cluster `ARTIFACTS_DIR=/data`, or on
 * Windows the Docker Desktop PV read straight from the VM disk), not at a copy of it. A
 * removal uses this to decide whether deleting the file here also deletes it where the worker
 * wrote it, or whether the path has to be queued for the volume sweep.
 */
export function isWorkerVolumeRoot(
  storedPath: string | null | undefined,
  dir: string = outputDir(),
): boolean {
  const name = storedPathName(storedPath);
  if (!name || !storedPath) return false;

  const root = resolve(dir);
  const storedDir = resolve(dirname(storedPath.trim()));
  if (root === storedDir) return true;
  // The same volume through a different window: with `OUTPUT_DIR=\\wsl$\<distro>\...\k8s-pvs\
  // <pvc>\output` the host reads the *cluster's* PV, while the worker's stored path stays
  // `/data/output/<file>`. Same bytes, so deleting here deletes there.
  return isClusterVolumePath(root) && basename(root).toLowerCase() === basename(storedDir).toLowerCase();
}

/**
 * A Docker Desktop PersistentVolume as the host sees it (the VM's disk, mounted into the
 * distro's filesystem). Cluster-specific on purpose: on any other cluster the path simply
 * does not exist, so nothing else matches it.
 */
function isClusterVolumePath(dir: string): boolean {
  return /[\\/](wsl\$|wsl\.localhost)[\\/]/i.test(dir) && /[\\/]k8s-pvs[\\/]/i.test(dir);
}

export type ArtifactRemoval = 'removed' | 'mirror-only' | 'absent';

/** Which of a card's two documents this board can actually serve right now. */
export interface ArtifactAvailability {
  pdf: boolean;
  docx: boolean;
}

/**
 * What the download route will manage to resolve for one card.
 *
 * The board only ever serves files under its artifact root, and that root is a *mirror* on a
 * dev machine - so a card can exist with a `pdf_url` whose file has not been mirrored yet
 * (`storage-files.ps1 -Action download`). The UI uses this to label the links instead of
 * offering a button that 404s.
 */
export function artifactAvailability(
  pdfUrl: string | null | undefined,
  docxPath: string | null | undefined,
  dir: string = outputDir(),
): ArtifactAvailability {
  return {
    pdf: resolveArtifact(pdfUrl, dir) !== null,
    docx: resolveArtifact(docxPath, dir) !== null,
  };
}

/**
 * Delete one artifact from **this** machine, as far as the board is allowed to.
 *
 * `removed`     - deleted under the artifact root, and that root is the worker's own
 *                 directory, so nothing is left anywhere
 * `mirror-only` - a local mirror copy was deleted; the cluster volume still holds the file
 *                 (the caller queues `storedPath` for `storage-files.ps1 -Action purge`)
 * `absent`      - nothing was here to delete (the caller queues it anyway: the volume may
 *                 still hold it, and `rm -f` there is idempotent)
 */
export async function deleteArtifact(
  storedPath: string | null | undefined,
  dir: string = outputDir(),
): Promise<ArtifactRemoval> {
  const onVolume = isWorkerVolumeRoot(storedPath, dir);
  const file = resolveArtifact(storedPath, dir);

  if (file) {
    try {
      await rm(file, { force: true });
      return onVolume ? 'removed' : 'mirror-only';
    } catch {
      // A read-only mount or a permission problem: report it as not deleted here, so the
      // volume sweep still gets the path.
      return 'absent';
    }
  }
  return 'absent';
}
