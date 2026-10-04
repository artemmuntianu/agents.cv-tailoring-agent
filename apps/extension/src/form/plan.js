/**
 * Plan plumbing: the pure half of the form filler.
 *
 * `background.js` owns the round trip (snapshot -> board -> Gemini -> plan) and `formfill.js` owns
 * the DOM; this module owns the two decisions that sit between them and are worth reading in one
 * place: how the operator's **pins** override the model, and how a run is summarised for the popup.
 * No DOM, no network, no `chrome.*` - if tests are ever wanted for this feature, they start here.
 */

export const COVER_PIN = 'cover_letter';
export const RESUME_PIN = 'resume_file';
export const PIN_ACTIONS = [COVER_PIN, RESUME_PIN];

/**
 * Merge the plan with the operator's pins.
 *
 * The rule is simple and deliberate: a pinned field is filled the way it was pinned, whatever the
 * model said (or did not say). Pinning is what makes the two fields that *must* be exactly right -
 * the generated cover letter and the tailored PDF - independent of inference; the model keeps the
 * creative part (the recruiter's questions).
 */
export function mergePlan(snapshotFields = [], planFields = [], pins = {}) {
  const pinned = new Map();
  for (const field of snapshotFields) {
    const action = field.pin || (pins[RESUME_PIN] && field.pin === RESUME_PIN ? RESUME_PIN : '');
    if (action && PIN_ACTIONS.includes(action)) pinned.set(field.id, action);
  }

  const merged = [];
  const seen = new Set();
  for (const item of planFields) {
    const forced = pinned.get(item.id);
    if (forced) {
      merged.push({ ...item, action: forced, value: '' });
      seen.add(item.id);
      continue;
    }
    merged.push(item);
    seen.add(item.id);
  }
  for (const [id, action] of pinned) {
    if (seen.has(id)) continue;
    const field = snapshotFields.find((item) => item.id === id) || {};
    merged.push({ id, action, value: '', label: field.label || '', kind: field.kind || '' });
  }
  return merged;
}

/** Strip the extension's own `pin` marker before the snapshot is sent anywhere. */
export function publicFields(snapshotFields = []) {
  return snapshotFields.map(({ pin, ...rest }) => rest);
}

/** True when the plan (or a pin) needs one of the two documents the board holds. */
export function neededDocuments(fields = [], pins = {}) {
  const actions = new Set(fields.map((item) => item.action));
  return {
    cover: actions.has(COVER_PIN) || Boolean(pins[COVER_PIN]),
    file: actions.has(RESUME_PIN) || Boolean(pins[RESUME_PIN]),
  };
}

/** The popup's report: what was written, what was left, and what went wrong. */
export function describeReport(result) {
  if (!result || !result.ok) return (result && result.error) || 'the fill did not run';
  const lines = [];
  if (result.filled && result.filled.length) {
    lines.push(`Filled ${result.filled.length}:`);
    for (const item of result.filled) lines.push(`  • ${item.label} → ${item.what}`);
  } else {
    lines.push('Nothing was filled.');
  }
  if (result.skipped && result.skipped.length) {
    lines.push(`Left to you (${result.skipped.length}):`);
    for (const item of result.skipped) lines.push(`  • ${item.label}: ${item.reason}`);
  }
  if (result.failed && result.failed.length) {
    lines.push(`Could not fill (${result.failed.length}):`);
    for (const item of result.failed) lines.push(`  • ${item.label}: ${item.reason}`);
  }
  if (result.note) lines.push(`Note: ${result.note}`);
  if (result.planStatus && result.planStatus !== 'completed') {
    lines.push(`(Draft status: ${result.planStatus})`);
  }
  lines.push('Check the form, then submit it yourself - Populate never submits.');
  return lines.join('\n');
}
