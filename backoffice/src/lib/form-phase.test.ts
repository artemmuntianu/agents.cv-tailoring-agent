import { describe, expect, it } from 'vitest';
import { PHASE_STEPS, phaseLabel } from '../../../extension/src/form/phases.js';

/** A run that started at a fixed instant, `seconds` ago. */
const run = (step: string, seconds = 0, extra: Record<string, unknown> = {}) => ({
  step,
  startedAt: 1_000_000,
  at: 1_000_000,
  status: '',
  error: '',
  ...extra,
});
const at = (seconds: number) => 1_000_000 + seconds * 1000;

describe('the progress line the popup ticks through', () => {
  it('names the step the flow is in', () => {
    expect(phaseLabel(run('snapshot'), at(0))).toBe('Snapshotting the form…');
    expect(phaseLabel(run('board'), at(0))).toBe('Sending the snapshot to the board…');
    expect(phaseLabel(run('documents'), at(0))).toContain('cover letter and the tailored resume');
    expect(phaseLabel(run('applying'), at(0))).toBe('Filling the form…');
  });

  it("follows the board's own status while the draft is being written", () => {
    expect(phaseLabel(run('drafting', 3, { status: 'queued' }), at(3))).toContain(
      'waiting for a worker pod',
    );
    expect(phaseLabel(run('drafting', 3, { status: 'running' }), at(3))).toContain(
      'Drafting with Gemini',
    );
    // A status it does not know still says something honest instead of nothing.
    expect(phaseLabel(run('drafting', 3, { status: 'something-new' }), at(3))).toContain(
      'Waiting for the draft',
    );
  });

  it('appends the seconds the whole run has taken, from two seconds on', () => {
    expect(phaseLabel(run('drafting', 1, { status: 'running' }), at(1))).toBe('Drafting with Gemini…');
    expect(phaseLabel(run('drafting', 4, { status: 'running' }), at(4))).toBe(
      'Drafting with Gemini… (4s)',
    );
    // The clock belongs to the run, not the step: moving on does not reset it.
    expect(phaseLabel(run('applying', 23), at(23))).toBe('Filling the form… (23s)');
    expect(phaseLabel(run('done', 23), at(23))).toBe('Filled in 23s.');
  });

  it('reports a failure with its reason, and an idle worker as idle', () => {
    expect(phaseLabel(run('failed', 5, { error: 'the draft failed on the board' }), at(5))).toBe(
      'Populate failed: the draft failed on the board',
    );
    expect(phaseLabel(run('failed'), at(0))).toBe('Populate failed.');
    expect(phaseLabel(run('idle'), at(0))).toBe('Populate is not running.');
  });

  it('never throws, and has a label for every declared step', () => {
    expect(phaseLabel(null)).toBe('Populate is not running.');
    expect(phaseLabel(undefined)).toBe('Populate is not running.');
    expect(phaseLabel({ step: 'nonsense' })).toBe('Populate is not running.');
    expect(phaseLabel({})).toBe('Populate is not running.');

    // The list and the switch cannot drift apart without this failing.
    for (const [index, step] of PHASE_STEPS.entries()) {
      const label = phaseLabel(run(step, index), at(index));
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
