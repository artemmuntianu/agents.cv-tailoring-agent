import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cvModelSections,
  modelStateView,
  readCvModel,
  readFileSource,
  sourcePaths,
} from './sources';

describe('the CV model as the page shows it', () => {
  it('keeps document order and skips what the model does not have', () => {
    const sections = cvModelSections({
      header: { name: 'Jane Doe', title: 'Senior Engineer' },
      summary: 'Twenty years of it.',
      skills: { Languages: 'Python', Empty: '   ' },
      professional_experience: [
        {
          role: 'Lead',
          company_info: 'Acme',
          context: 'Payments',
          dates: '2020 - 2024',
          highlights: ['Did things'],
        },
      ],
      personal_projects: [
        { heading: 'Project A', year: '2026', stack: 'Python', links: ['Repo: x'] },
      ],
    });
    expect(sections.map((section) => section.title)).toEqual([
      'Header',
      'Summary',
      'Relevant skills',
      'Professional experience (read-only context)',
      'Personal projects (read-only context)',
    ]);
    expect(sections[0].lines).toEqual(['NAME: Jane Doe', 'TITLE: Senior Engineer']);
    expect(sections[2].lines).toEqual(['Languages: Python']);
    expect(sections[3].lines).toEqual([
      'Lead - Acme',
      'Payments',
      '2020 - 2024',
      '• Did things',
    ]);
    expect(sections[4].lines).toEqual(['Project A', '2026', 'Tech Stack: Python', 'Repo: x']);
  });

  it('never invents a section for a model that is not there', () => {
    expect(cvModelSections(null)).toEqual([]);
    expect(cvModelSections({})).toEqual([]);
  });
});

describe('reading a source file', () => {
  it('reports a missing file as absent with its path, not as empty content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sources-'));
    const missing = readFileSource('x', join(dir, 'nope.json'));
    expect(missing.present).toBe(false);
    expect(missing.path).toContain('nope.json');
    expect(readCvModel(join(dir, 'nope.json')).sections).toEqual([]);
  });

  it('reads the model, and says so when the JSON is broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sources-'));
    const path = join(dir, 'cv_data.json');
    writeFileSync(path, JSON.stringify({ summary: 'ok' }));
    expect(readCvModel(path).sections.map((section) => section.title)).toEqual(['Summary']);

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
