import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelStateView, readCvModel, readFileSource, sourcePaths } from './sources';

describe('reading a source file', () => {
  it('reports a missing file as absent with its path, not as empty content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sources-'));
    const missing = readFileSource('x', join(dir, 'nope.json'));
    expect(missing.present).toBe(false);
    expect(missing.path).toContain('nope.json');
    expect(readCvModel(join(dir, 'nope.json')).model).toBeNull();
  });

  it('hands the model over as the parsed document, and says so when the JSON is broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sources-'));
    const path = join(dir, 'cv_data.json');
    const model = { summary: 'ok', professional_experience: [{ role: 'Lead' }] };
    writeFileSync(path, JSON.stringify(model));
    // The page renders this object with the shared tree (`components/JsonTree.tsx`), so the reader
    // hands over the model's own keys - a flattened second shape would be a duplicate of it.
    expect(readCvModel(path).model).toEqual(model);

    writeFileSync(path, '{oops');
    const broken = readCvModel(path);
    expect(broken.model).toBeNull();
    expect(broken.parseError).toBeTruthy();
  });
});

describe('the model rotation state', () => {
  it('reads the active model and who is resting, keeping unknown keys visible', () => {
    const view = modelStateView({
      active: 'gemini-3.5-flash-lite',
      quiesced: { 'gemini-3.1-flash-lite': '2026-10-02T00:00:00Z' },
      note: 'seeded',
    });
    expect(view.active).toBe('gemini-3.5-flash-lite');
    expect(view.quiesced).toEqual([
      { model: 'gemini-3.1-flash-lite', until: '2026-10-02T00:00:00Z' },
    ]);
    expect(view.lines).toEqual(['note: seeded']);
  });

  it('survives a shape it does not know', () => {
    expect(modelStateView({ something: 'else' }).active).toBeNull();
    expect(modelStateView({}).quiesced).toEqual([]);
  });
});

describe('where the sources live', () => {
  it('uses the worker\'s own file names, in the same root as the artifacts', () => {
    const paths = sourcePaths('/data');
    expect(paths.cvData).toBe(join('/data', 'cv_data.json'));
    expect(paths.masterCv).toBe(join('/data', 'input', 'cv.docx'));
    expect(paths.modelState).toBe(join('/data', 'model_state.json'));
  });
});
