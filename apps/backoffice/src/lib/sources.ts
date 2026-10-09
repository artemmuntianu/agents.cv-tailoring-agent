import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir } from './artifacts';

/**
 * The sources of truth a generated document is built from - read so they stop being invisible.
 *
 * The tailoring answer is built from three things: the master CV (`cv_data.json`, the structured
 * model the DOCX mutations target), the vacancy (`resumes.description_raw`, shown on the card) and
 * the operator's candidate facts (the `application_profile` row). The board only ever showed the
 * *output*; this module reads the two inputs that live on the artifact volume, plus the model
 * rotation state that decides which model wrote the last document.
 *
 * It reads and never writes, and it opens only the artifact root's own files. A file this machine
 * does not have is reported as absent with its path and the command that mirrors it - exactly like
 * an artifact link that is not mirrored yet - because "the dashboard cannot see it" must never look
 * like "it does not exist".
 */

export interface FileSource {
  /** What this file is, in the operator's words. */
  label: string;
  path: string;
  present: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface CvModelSource extends FileSource {
  /**
   * The parsed document, as the model's own keys - the page renders it with the shared JSON tree
   * (`components/JsonTree.tsx`, read-only), so it needs no second, flattened shape here.
   */
  model: Record<string, unknown> | null;
  parseError: string | null;
}

export interface ModelStateSource extends FileSource {
  active: string | null;
  quiesced: { model: string; until: string | null }[];
  /** The raw file, flattened: its shape belongs to `apps/worker/utils/model_state.py`, not to this page. */
  lines: string[];
  note: string | null;
}

/** Where the worker's inputs are on the machine this server runs on (same roots as the artifacts). */
export function sourcePaths(root: string = artifactsDir()) {
  return {
    cvData: join(root, 'cv_data.json'),
    masterCv: join(root, 'input', 'cv.docx'),
    modelState: join(root, 'model_state.json'),
  };
}

function describe(label: string, path: string): FileSource {
  try {
    const info = statSync(path);
    return {
      label,
      path,
      present: true,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
  } catch {
    return { label, path, present: false, sizeBytes: null, modifiedAt: null };
  }
}

export function readFileSource(label: string, path: string): FileSource {
  return describe(label, path);
}

/**
 * `cv_data.json` - the structured CV every replacement is checked against.
 *
 * Trap 11 lives here: a section that exists in the DOCX but not in this model never reaches the
 * prompt, which is exactly why this page shows the *model* rather than the document.
 */
export function readCvModel(path: string): CvModelSource {
  const base = describe('Master CV model (cv_data.json)', path);
  if (!base.present) {
    return { ...base, model: null, parseError: null };
  }
  try {
    const model = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return { ...base, model, parseError: null };
  } catch (error) {
    return {
      ...base,
      model: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * `model_state.json` - which model is live and which ones are resting on their quota.
 *
 * Read defensively: the file's shape belongs to the worker (`apps/worker/utils/model_state.py`), so anything
 * this page does not recognise is still shown, flattened, rather than hidden.
 */
export function readModelState(path: string): ModelStateSource {
  const base = describe('Model rotation state (model_state.json)', path);
  if (!base.present) return { ...base, active: null, quiesced: [], lines: [], note: null };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return { ...base, ...modelStateView(raw), note: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, active: null, quiesced: [], lines: [], note: `unreadable: ${message}` };
  }
}

/** The interesting half of that file, tolerant of a shape the worker may change. */
export function modelStateView(raw: Record<string, unknown>): {
  active: string | null;
  quiesced: { model: string; until: string | null }[];
  lines: string[];
} {
  const active =
    typeof raw.active === 'string'
      ? raw.active
      : typeof raw.current === 'string'
        ? raw.current
        : null;
  const resting = (raw.quiesced ?? raw.retired ?? {}) as Record<string, unknown>;
  const quiesced = Object.entries(resting).map(([model, until]) => ({
    model,
    until: until ? String(until) : null,
  }));
  const lines = Object.entries(raw)
    .filter(([key]) => !['active', 'current', 'quiesced', 'retired'].includes(key))
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  return { active, quiesced, lines };
}
