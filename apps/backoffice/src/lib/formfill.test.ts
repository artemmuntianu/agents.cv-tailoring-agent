import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';

/**
 * The application-form filler is a **classic content script** - no build step, no imports - so it is
 * tested the way the browser loads it: `window.eval(source)` inside a jsdom page whose fake `chrome`
 * runtime carries the two messages the popup and the worker send (`snapshot`, `apply`).
 *
 * Fixture: `fixtures/greenhouse-application-form.html`, the real `#application-form` copied out of a
 * live Greenhouse job page. That form broke the previous rules twice: **not one of its 17 controls
 * carries a `name`** (so an annotator keyed on `name` saw none of them), and four of them are
 * react-select comboboxes that look like text inputs and drop whatever is typed into them.
 *
 * jsdom performs no layout, so `field.hidden` is meaningless here (everything reports as hidden);
 * the assertions below deliberately never read it.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../../extension/src/formfill.js', import.meta.url)),
  'utf8',
);
const FORM = readFileSync(
  fileURLToPath(new URL('./fixtures/greenhouse-application-form.html', import.meta.url)),
  'utf8',
);
const PAGE_URL = 'https://job-boards.eu.greenhouse.io/growe/jobs/4987494101';

/** TomSelect's markup: the search box the widget generates, next to the `<select>` it hides. */
const TOMSELECT =
  '<form id="tom-form"><div class="ts-wrapper">' +
  '<select name="cv_id"><option value="1">CV 1</option></select>' +
  '<div class="ts-control"><input id="tomselect-1-ts-control" type="text" autocomplete="off"></div>' +
  '</div></form>';

/**
 * A react-select-shaped dropdown. The real widget renders its option list only while the menu is
 * open, so a saved page carries none - the listeners `wireDropdown` installs are what the widget
 * does on a `mousedown` (open the menu) and on an option's `click` (commit that label).
 */
const DROPDOWN =
  '<form id="rs-form"><div class="select__container"><label for="country">Country</label>' +
  '<div class="select__control" id="country-control">' +
  '<input class="select__input" id="country" role="combobox" aria-haspopup="listbox" type="text">' +
  '</div></div></form>';

const COUNTRIES = ['Portugal', 'Ukraine'];

/** Make `DROPDOWN` a working widget: open on mousedown, render the options, commit the clicked one. */
function wireDropdown(document: Document): void {
  const control = document.getElementById('country-control') as HTMLElement;
  control.addEventListener('mousedown', () => {
    if (control.querySelector('.select__menu')) return;
    const menu = document.createElement('div');
    menu.className = 'select__menu';
    for (const name of COUNTRIES) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = name;
      option.addEventListener('click', () => {
        const shown = document.createElement('div');
        shown.className = 'select__single-value';
        shown.textContent = name;
        control.appendChild(shown);
        menu.remove();
      });
      menu.appendChild(option);
    }
    control.appendChild(menu);
  });
}

/**
 * The letter field only exists once the operator pressed "Enter manually" on the site, and it
 * lands inside the Cover Letter group - so its label comes from the group, not from itself.
 */
const REVEALED = FORM.replace(
  '<label class="visually-hidden" for="cover_letter">Attach</label>',
  '<label class="visually-hidden" for="cover_letter">Attach</label>' +
    '<textarea id="cover_letter_text" aria-label="Cover Letter"></textarea>',
);

interface Field {
  id: string;
  kind: string;
  label: string;
  name: string;
  required: boolean;
  options: string[];
  hidden: boolean;
  pin?: string;
}

interface Snapshot {
  ok: boolean;
  root: string;
  html: string;
  fields: Field[];
}

interface Report {
  ok: boolean;
  filled: { label: string; what: string }[];
  skipped: { label: string; reason: string }[];
  failed: { label: string; reason: string }[];
  note: string;
}

type Listener = (message: unknown, sender: unknown, respond: (response: unknown) => void) => unknown;

/** A page with the content script already evaluated in it, and the worker's `cvtForm` channel. */
function filler(html: string) {
  const dom = new JSDOM(`<body>${html}</body>`, {
    url: PAGE_URL,
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const listeners: Listener[] = [];
  (dom.window as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage: (_message: unknown, callback: (response: unknown) => void) =>
        callback({ ok: true, recipes: {} }),
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
    },
  };
  dom.window.eval(SOURCE);

  const ask = <T>(message: unknown) =>
    new Promise<T>((resolve) => {
      listeners[0](message, null, resolve as (response: unknown) => void);
    });

  return {
    document: dom.window.document,
    snapshot: (root: string) => ask<Snapshot>({ type: 'cvtForm', action: 'snapshot', root }),
    apply: (instructions: unknown) =>
      ask<Report>({ type: 'cvtForm', action: 'apply', instructions }),
  };
}

describe('application form: reading it', () => {
  it('annotates every control of a form whose fields carry no `name` at all', async () => {
    const shot = await filler(FORM).snapshot('#application-form');

    expect(shot.ok).toBe(true);
    // 17 controls, 14 identities: the three nameless `aria-hidden` state mirrors are not fields.
    expect(shot.fields.map((field) => field.label)).toEqual([
      'First Name*',
      'Last Name*',
      'Email*',
      'Country',
      'Phone',
      'Resume/CV*',
      'Cover Letter',
      'Please add a link to your LinkedIn profile (if available).',
      'What is your current location?*',
      'What is your Ukrainian proficiency level?*',
      'What is your English proficiency level?*',
      'What is your salary expectation in USD Gross (before taxes)?*',
      'What is your preferred messenger? Please provide your ID/name*',
      'How did you hear about us?*',
    ]);
    // The id is a marker the plan resolves against, not the site's own.
    expect(shot.fields.map((field) => field.id)).toEqual(
      shot.fields.map((_, index) => `f${index + 1}`),
    );
  });

  it('tells a JavaScript dropdown from a text field, and a file field from both', async () => {
    const shot = await filler(FORM).snapshot('#application-form');

    expect(shot.fields.filter((field) => field.kind === 'combobox').map((f) => f.label)).toEqual([
      'Country',
      'What is your Ukrainian proficiency level?*',
      'What is your English proficiency level?*',
      'How did you hear about us?*',
    ]);
    expect(shot.fields.filter((field) => field.kind === 'file').map((f) => f.label)).toEqual([
      'Resume/CV*',
      'Cover Letter',
    ]);
    expect(shot.fields.filter((field) => field.kind === 'textarea')).toHaveLength(1);
    expect(shot.fields.filter((field) => field.kind === 'text')).toHaveLength(6);
    expect(shot.fields.filter((field) => field.kind === 'tel')).toHaveLength(1);
  });

  it('reads `aria-required` as required, on the control or on the group around it', async () => {
    const shot = await filler(FORM).snapshot('#application-form');
    const required = shot.fields.filter((field) => field.required).map((field) => field.label);

    expect(required).toContain('Email*');
    // Marked on the upload *group*, not on the file input itself.
    expect(required).toContain('Resume/CV*');
    // The two the page leaves optional stay optional.
    expect(required).not.toContain('Country');
    expect(required).not.toContain('Cover Letter');
  });

  it('mints the same ids on a second pass, so a plan still resolves after a re-render', async () => {
    const form = filler(FORM);
    const first = await form.snapshot('#application-form');
    const second = await form.snapshot('#application-form');

    expect(second.fields.map((field) => field.id)).toEqual(first.fields.map((field) => field.id));
    expect(second.fields.map((field) => field.label)).toEqual(first.fields.map((f) => f.label));
  });

  it('keeps the control a widget drives, and drops only the box the widget generated', async () => {
    const shot = await filler(TOMSELECT).snapshot('#tom-form');

    expect(shot.fields).toHaveLength(1);
    expect(shot.fields[0]).toMatchObject({ kind: 'select', name: 'cv_id', options: ['CV 1'] });
  });
});

describe('application form: filling it', () => {
  it('fills a text field, and refuses to type a value into a JavaScript dropdown', async () => {
    const form = filler(FORM);
    const shot = await form.snapshot('#application-form');
    const firstName = shot.fields.find((field) => field.label === 'First Name*');
    const country = shot.fields.find((field) => field.label === 'Country');

    const report = await form.apply({
      root: '#application-form',
      pins: {},
      fields: [
        { id: firstName?.id, action: 'answer', value: 'Ada Lovelace', label: firstName?.label },
        { id: country?.id, action: 'answer', value: 'Ukraine', label: country?.label },
      ],
    });

    expect(report.filled).toEqual([{ label: 'First Name*', what: 'Ada Lovelace' }]);
    expect(report.skipped).toEqual([
      {
        label: 'Country',
        reason: 'a JavaScript dropdown needs the option to click - nothing to type into it',
      },
    ]);
    expect(report.failed).toEqual([]);
    expect((form.document.getElementById('first_name') as HTMLInputElement).value).toBe(
      'Ada Lovelace',
    );
    // The widget's own input would have shown a value it drops on its next render.
    expect((form.document.getElementById('country') as HTMLInputElement).value).toBe('');
  });

  it('treats a pinned field as the extension own, and says so when the document is missing', async () => {
    const form = filler(FORM);
    const report = await form.apply({
      root: '#application-form',
      pins: { resume_file: '#resume' },
      fields: [],
    });

    expect(report.skipped).toEqual([
      { label: 'Resume/CV*', reason: 'no tailored PDF is available for this card' },
    ]);
  });

  it('writes the cover letter into the field the operator pinned after "Enter manually"', async () => {
    const form = filler(REVEALED);
    const report = await form.apply({
      root: '#application-form',
      pins: { cover_letter: '#cover_letter_text' },
      cover: { text: 'Dear Growe' },
      fields: [],
    });

    expect(report.filled).toEqual([{ label: 'Cover Letter', what: 'the cover letter (10 chars)' }]);
    expect((form.document.getElementById('cover_letter_text') as HTMLTextAreaElement).value).toBe(
      'Dear Growe',
    );
  });
});

describe('application form: driving a JavaScript dropdown', () => {
  it('opens the widget, matches the label and clicks that option', async () => {
    const form = filler(DROPDOWN);
    wireDropdown(form.document);
    const shot = await form.snapshot('#rs-form');
    const country = shot.fields.find((field) => field.label === 'Country');

    expect(country?.kind).toBe('combobox');
    const report = await form.apply({
      root: '#rs-form',
      pins: {},
      fields: [{ id: country?.id, action: 'select', value: 'Portugal', label: country?.label }],
    });

    expect(report.filled).toEqual([{ label: 'Country', what: 'Portugal' }]);
    expect(report.failed).toEqual([]);
    // What matters is the value the widget *committed*, not text typed into the box it ignores.
    expect(form.document.querySelector('.select__single-value')?.textContent).toBe('Portugal');
  }, 20000);

  it('reports an option the widget does not offer, and commits nothing', async () => {
    const form = filler(DROPDOWN);
    wireDropdown(form.document);
    const shot = await form.snapshot('#rs-form');
    const country = shot.fields.find((field) => field.label === 'Country');

    const report = await form.apply({
      root: '#rs-form',
      pins: {},
      fields: [{ id: country?.id, action: 'select', value: 'Atlantis', label: country?.label }],
    });

    expect(report.filled).toEqual([]);
    expect(report.failed).toEqual([
      { label: 'Country', reason: 'no option matches "Atlantis" - pick it yourself' },
    ]);
    // The search box may hold the filter text; the field itself is still the operator's to pick.
    expect(form.document.querySelector('.select__single-value')).toBeNull();
  }, 20000);
});

