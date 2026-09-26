import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { artifactUrl, storedPathName } from './artifact-link';
import { contentTypeFor, outputDir, resolveArtifact } from './artifacts';

const root = mkdtempSync(join(tmpdir(), 'cvt-artifacts-'));
mkdirSync(join(root, 'output'), { recursive: true });
writeFileSync(join(root, 'output', '848944.pdf'), '%PDF-1.4 test');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('artifact paths', () => {
  it('takes the file name out of the worker\'s storage path', () => {
    // This is exactly what utils/storage.py writes into resumes.pdf_url.
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

  it('defaults the output dir to the repo\'s artifacts folder (config.py layout)', () => {
    expect(outputDir().replace(/\\/g, '/')).toMatch(/artifacts\/output$/);
  });
});
