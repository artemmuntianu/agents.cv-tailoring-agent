import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { artifactUrl, storedPathName } from './artifact-link';
import {
  artifactAvailability,
  contentTypeFor,
  deleteArtifact,
  isWorkerVolumeRoot,
  outputDir,
  resolveArtifact,
} from './artifacts';

const root = mkdtempSync(join(tmpdir(), 'cvt-artifacts-'));
mkdirSync(join(root, 'output'), { recursive: true });
writeFileSync(join(root, 'output', '848944.pdf'), '%PDF-1.4 test');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('artifact paths', () => {
  it('takes the file name out of the worker\'s storage path', () => {
    // This is exactly what apps/worker/utils/storage.py writes into resumes.pdf_url.
    expect(storedPathName('/data/output/848944.pdf')).toBe('848944.pdf');
    expect(storedPathName('C:\\data\\output\\cv_x.docx')).toBe('cv_x.docx');
    expect(storedPathName('')).toBeNull();
    expect(storedPathName(null)).toBeNull();
  });

  it('resolves a stored path against the local artifact root', () => {
    const found = resolveArtifact('/data/output/848944.pdf', join(root, 'output'));
    expect(found).toBe(join(root, 'output', '848944.pdf'));
  });

  it('returns null instead of a path when the file is not mirrored locally', () => {
    expect(resolveArtifact('/data/output/nope.pdf', join(root, 'output'))).toBeNull();
  });

  it('refuses anything that would escape the artifact root', () => {
    const dir = join(root, 'output');
    for (const hostile of [
      '/data/output/../../../etc/passwd',
      '../../../../windows/win.ini',
      '/etc/passwd',
      '..',
    ]) {
      const found = resolveArtifact(hostile, dir);
      expect(found === null || found.startsWith(dir), String(hostile)).toBe(true);
    }
  });

  it('knows the two content types the worker produces', () => {
    expect(contentTypeFor('848944.PDF')).toBe('application/pdf');
    expect(contentTypeFor('848944.docx')).toContain('wordprocessingml');
    expect(contentTypeFor('notes.txt')).toBe('application/octet-stream');
  });

  it('links through the route, never to the stored path', () => {
    expect(artifactUrl('11111111-2222-3333-4444-555555555555')).toBe(
      '/api/artifacts/11111111-2222-3333-4444-555555555555',
    );
    expect(artifactUrl('job 1', 'docx')).toBe('/api/artifacts/job%201?format=docx');
  });

  it('knows when the board is looking at the worker volume itself', () => {
    // In the cluster the board mounts the PVC at /data, so `OUTPUT_DIR` *is* the directory
    // the worker stored the path in; on a dev machine it is a mirror under the repo.
    expect(isWorkerVolumeRoot('/data/output/848944.pdf', '/data/output')).toBe(true);
    expect(isWorkerVolumeRoot('/data/output/848944.pdf', join(root, 'output'))).toBe(false);
    expect(isWorkerVolumeRoot(null, '/data/output')).toBe(false);
    // The default root is still the repo's own artifacts folder (config.py's layout).
    expect(outputDir().replace(/\\/g, '/')).toMatch(/artifacts\/output$/);
  });

  it('deletes the copy it can see, and reports whether that was the volume or a mirror', async () => {
    const dir = join(root, 'output');

    writeFileSync(join(dir, 'remove-me.pdf'), '%PDF-1.4 test');
    expect(await deleteArtifact('/data/output/remove-me.pdf', dir)).toBe('mirror-only');
    expect(resolveArtifact('/data/output/remove-me.pdf', dir)).toBeNull();

    writeFileSync(join(dir, 'same-root.pdf'), '%PDF-1.4 test');
    expect(await deleteArtifact(join(dir, 'same-root.pdf'), dir)).toBe('removed');

    expect(await deleteArtifact('/data/output/never-existed.pdf', dir)).toBe('absent');
    expect(await deleteArtifact('/data/output/../../etc/passwd', dir)).toBe('absent');
    expect(await deleteArtifact(null, dir)).toBe('absent');
  });

  it('tells the UI which documents it can serve right now', () => {
    const dir = join(root, 'output');
    writeFileSync(join(dir, '848944.pdf'), '%PDF-1.4 test');

    // The worker stored both, the mirror only holds the PDF (the DOCX bug of 2026-09-26).
    expect(artifactAvailability('/data/output/848944.pdf', '/data/output/848944.docx', dir)).toEqual({
      pdf: true,
      docx: false,
    });
    // A card the worker has not finished with has neither.
    expect(artifactAvailability(null, null, dir)).toEqual({ pdf: false, docx: false });
    // A path that walks out of the root is never served, so it is never "available".
    expect(artifactAvailability('/data/output/../../etc/passwd', null, dir).pdf).toBe(false);
  });
});

describe('the cluster volume as the host sees it (Docker Desktop + WSL)', () => {
  // `.\scripts\storage-files.ps1 -Action path` prints this path. Only Windows can mount the
  // Docker Desktop VM disk that way, so the block is platform-gated rather than pretending a
  // UNC path means something on Linux.
  const UNC = String.raw`\\wsl$\docker-desktop\mnt\docker-desktop-disk\data\k8s-pvs\cv-artifacts\pvc-1234\output`;
  const windows = it.runIf(process.platform === 'win32');

  windows('is the worker volume, so a removal deletes the real file and not a copy', () => {
    // The worker stored `/data/output/<file>`; through the UNC path the board reads the very
    // same bytes, so both documents of a card count as "on the worker's volume".
    expect(isWorkerVolumeRoot('/data/output/848944.pdf', UNC)).toBe(true);
    expect(isWorkerVolumeRoot('/data/output/848944.docx', UNC)).toBe(true);
    // A different directory inside the same volume is not that directory.
    expect(isWorkerVolumeRoot('/data/input/cv.docx', UNC)).toBe(false);
  });

  windows('keeps the traversal guard for a UNC root', () => {
    expect(resolveArtifact('../../etc/passwd', UNC)).toBeNull();
    expect(resolveArtifact('/data/output/../../../secret.txt', UNC)).toBeNull();
    expect(resolveArtifact(null, UNC)).toBeNull();
    // Nothing is mounted during a unit test, so a real name resolves to null, not a throw.
    expect(resolveArtifact('/data/output/848944.pdf', UNC)).toBeNull();
    expect(artifactAvailability('/data/output/848944.pdf', '/data/output/848944.docx', UNC)).toEqual({
      pdf: false,
      docx: false,
    });
  });
});
