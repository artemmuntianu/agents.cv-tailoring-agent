/**
 * The application-form filler: the extension's DOM side.
 *
 * A **classic** content script (a second entry of the same `content_scripts` declaration), so it
 * has no imports - everything it needs lives inside this IIFE. It owns four jobs and nothing else:
 * the network, the planning and the Gemini round trip belong to the service worker
 * (`src/background.js`), because a `fetch` from a content script is judged by the *page's* CORS
 * rules.
 *
 *   pick      - HITL: the operator points at the form (and optionally at the two fields the
 *               extension fills itself). Nothing is guessed; the worker remembers the selector per
 *               host (`chrome.storage.local.formRecipes`).
 *   snapshot  - annotate every fillable control with a deterministic `data-cvt-id` (f1, f2, ... in
 *               DOM order), collect a compact field list, hand back the trimmed subtree. The worker
 *               posts that to the board, where it becomes a Gemini prompt. A control a script owns
 *               (`role="combobox"`) is reported as its own kind, never as a text field: it can only
 *               be *selected*, never typed into.
 *   apply     - take the plan that comes back (keyed by those ids) plus the documents the worker
 *               fetched, and write them into the page. It never submits anything.
 *   adapter   - per-site steps for widgets a plain `input[type=file]` cannot express (Djinni's CV
 *               picker is an htmx swap around a TomSelect `select`).
 *
 * Determinism matters: the same DOM must produce the same ids, because the plan is keyed by them
 * and the page may be re-rendered between the snapshot and the apply. The board also hashes the
 * snapshot, so a form that really changed is re-drafted instead of filled with stale answers.
 */
(() => {
  'use strict';

  const MARK = 'data-cvt-id';
  const PIN = 'data-cvt-pin';
  const UI = 'data-cvt-ui';
  // Controls the browser submits but a person never fills - plus the one type we never touch.
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password']);
  const MAX_FIELDS = 80;
  const MAX_HTML_CHARS = 180000;
  const RESUME_PIN = 'resume_file';
  const COVER_PIN = 'cover_letter';

  const log = (...args) => console.info('[cv-tailoring:form]', ...args);

  /** False once the extension is reloaded: the page keeps its old script context. */
  function alive() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          resolve(response || { ok: false, error: 'no response from the extension' });
        });
      } catch (error) {
        resolve({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    });
  }

  // --- small DOM helpers ---------------------------------------------------- //

  function oneLine(text, limit = 300) {
    return String(text == null ? '' : text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit);
  }

  function insideOurUi(element) {
    return Boolean(element.closest('[' + UI + ']'));
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  /** `<label for="...">`, the normal path. */
  function labelTextFor(element) {
    const id = element.getAttribute('id');
    if (id) {
      const label = document.querySelector('label[for="' + cssEscape(id) + '"]');
      if (label) return oneLine(label.textContent);
    }
    const wrapping = element.closest('label');
    return wrapping ? oneLine(wrapping.textContent) : '';
  }

  function kindOf(element) {
    const tag = element.tagName;
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return 'select';
    // A dropdown a script owns (react-select and friends) is an `<input>` that only looks like a
    // text field: typing into it shows a value the widget drops on its next render. Its own kind is
    // what tells the model to name an *option* rather than a value - the applier opens the widget
    // and clicks that label (`chooseCombobox`), which is the only way the choice becomes real.
    const role = (element.getAttribute('role') || '').toLowerCase();
    const popup = (element.getAttribute('aria-haspopup') || '').toLowerCase();
    if (role === 'combobox' || popup === 'listbox') return 'combobox';
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    return type === 'text' ? 'text' : type;
  }

  /**
   * TomSelect's *generated* control: the unnamed `<input>` it adds inside its own wrapper.
   *
   * The widget's real control is the `<select>` it hides, and that one stays annotated (it keeps
   * its `name`, and the applier writes into it). Only the search box the widget invented from its
   * own id - `#tomselect-1-ts-control`, which nobody submits - is excluded.
   */
  function widgetControl(element) {
    if (element.tagName !== 'INPUT') return false;
    if (element.getAttribute('name')) return false;
    return Boolean(element.closest('.ts-wrapper'));
  }

  function isFillable(element) {
    const tag = element.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
    if (insideOurUi(element)) return false;
    if (element.disabled || element.readOnly) return false;
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (SKIP_TYPES.has(type)) return false;
    // What identifies a control: `name` (the browser submits it) *or* `id` (a form a script
    // drives keeps the value in JS state - Greenhouse's `first_name`/`email`/`question_*` carry
    // no name at all, so keying on `name` alone left that whole form invisible).
    const named = Boolean(element.getAttribute('name'));
    const hasId = Boolean(element.getAttribute('id'));
    if (!named && !hasId && type !== 'file' && tag !== 'SELECT' && tag !== 'TEXTAREA') return false;
    if (widgetControl(element)) return false;
    // A widget's plumbing, not a field: a state mirror or a `required` marker the site keeps out
    // of the tab order (react-select renders one next to every dropdown). Only unnamed inputs are
    // judged this way - the hidden `<select>` behind a widget *is* fillable.
    if (!named && tag === 'INPUT') {
      if (element.getAttribute('aria-hidden') === 'true') return false;
      if (element.getAttribute('tabindex') === '-1') return false;
    }
    return true;
  }

  /**
   * Whether the page says this control must be filled.
   *
   * The `required` attribute is not the only way to say it: a React form marks it with
   * `aria-required` - on the input, or on the group around it (Greenhouse's upload group is
   * `role="group" aria-required="true"` while the file input itself carries nothing).
   */
  function isRequired(element) {
    if (element.required) return true;
    if (element.getAttribute('aria-required') === 'true') return true;
    const group = element.closest('[aria-required="true"]');
    if (!group) return false;
    return group.tagName === 'FIELDSET' || group.getAttribute('role') === 'group';
  }

  function optionsOf(element) {
    if (element.tagName !== 'SELECT') return [];
    return Array.from(element.options || [])
      .map((option) => oneLine(option.textContent, 200))
      .filter((text) => text && text !== '-');
  }

  /**
   * The question a control belongs to.
   *
   * `<label for>` first, then ARIA, a wrapping label, the placeholder, and finally the nearest
   * block's own label/text. The last paths are what the real Djinni form needs: its radio group
   * label points at an id that does not exist (`for="answer_boolean_3"` while the inputs are
   * `answer_boolean_3_yes` / `_no`), so the group question has to come from the container.
   */
  /** The text of the elements an `aria-labelledby`/`aria-describedby` id list points at. */
  function labelledByText(ids) {
    return oneLine(
      String(ids || '')
        .split(/\s+/)
        .map((id) => {
          const node = document.getElementById(id);
          return node ? node.textContent : '';
        })
        .join(' '),
    );
  }

  function questionFor(element) {
    // A group the site labelled itself outranks the control's own `<label for>`: that label is
    // often the wording of the *button* that opens the control (Greenhouse's upload group labels
    // its file input "Attach" and names the group "Resume/CV").
    const group = element.closest('[role="group"][aria-labelledby], fieldset[aria-labelledby]');
    const groupText = group ? labelledByText(group.getAttribute('aria-labelledby')) : '';
    if (groupText) return groupText;

    const explicit = labelTextFor(element);
    if (explicit) return explicit;

    const aria = oneLine(element.getAttribute('aria-label'));
    if (aria) return aria;

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const joined = labelledByText(labelledBy);
      if (joined) return joined;
    }

    const placeholder = oneLine(element.getAttribute('placeholder'));
    if (placeholder) return placeholder;

    const container = element.closest('div, fieldset, li, td, section');
    if (container) {
      const label = container.querySelector('label');
      if (label && !label.contains(element)) {
        const text = oneLine(label.textContent);
        if (text) return text;
      }
      const text = oneLine(container.textContent, 240);
      if (text) return text;
    }
    return '';
  }

  /** A stable path for the *picked* element (the root recipe and the two pins use it). */
  function cssPath(element) {
    if (!(element instanceof Element)) return '';
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 6) {
      const id = node.getAttribute('id');
      if (id && /^[A-Za-z][\w:-]*$/.test(id)) {
        parts.unshift('#' + id);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function describe(element) {
    return {
      selector: cssPath(element),
      tag: element.tagName.toLowerCase(),
      id: element.getAttribute('id') || '',
      className: oneLine(element.getAttribute('class') || '', 120),
    };
  }

  function countFillable(root) {
    if (!(root instanceof Element) && root !== document) return 0;
    return Array.from(root.querySelectorAll('input, textarea, select')).filter(isFillable).length;
  }

  function resolveRoot(selector) {
    if (!selector) return null;
    try {
      const node = document.querySelector(selector);
      return node instanceof Element ? node : null;
    } catch (error) {
      return null;
    }
  }

  // --- the picker (HITL) ---------------------------------------------------- //

  let picker = null;

  function buildOverlay() {
    const box = document.createElement('div');
    box.setAttribute(UI, 'outline');
    box.style.cssText =
      'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #0f172a;' +
      'background:rgba(15,23,42,0.06);border-radius:4px;';
    const badge = document.createElement('div');
    badge.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;background:#0f172a;color:#fff;' +
      'font:11px/1.4 system-ui,sans-serif;padding:2px 6px;border-radius:4px;max-width:60vw;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    const banner = document.createElement('div');
    banner.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;' +
      'background:#0f172a;color:#fff;font:12px/1.6 system-ui,sans-serif;padding:6px 12px;' +
      'text-align:center;';
    document.body.appendChild(box);
    document.body.appendChild(badge);
    document.body.appendChild(banner);
    return { box, badge, banner };
  }

  function stopPick() {
    if (!picker) return;
    if (picker.cleanup) picker.cleanup();
    [picker.box, picker.badge, picker.banner].forEach((node) => node && node.remove());
    picker = null;
  }

  /** Enter picker mode; resolves with the picked element's descriptor, or `cancelled`. */
  function startPick(kind) {
    stopPick();
    const { box, badge, banner } = buildOverlay();
    banner.textContent =
      kind === 'root'
        ? 'CV tailoring: click the application form (Esc to cancel)'
        : kind === RESUME_PIN
          ? 'CV tailoring: click where the tailored PDF goes (Esc to cancel)'
          : 'CV tailoring: click where the cover letter goes (Esc to cancel)';

    return new Promise((resolve) => {
      picker = { kind, box, badge, banner, resolve, hovered: null };

      const move = (event) => {
        const target = event.target;
        if (!picker || !(target instanceof Element) || insideOurUi(target)) return;
        picker.hovered = target;
        const rect = target.getBoundingClientRect();
        box.style.left = rect.left + 'px';
        box.style.top = rect.top + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
        badge.style.left = Math.max(4, rect.left) + 'px';
        badge.style.top = Math.max(4, rect.top - 20) + 'px';
        const path = cssPath(target);
        badge.textContent = path.length > 90 ? path.slice(0, 90) + '…' : path;
      };

      const click = (event) => {
        if (!picker || !picker.hovered) return;
        // The site must never see this click: the operator is aiming, not applying.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const picked = { ...describe(picker.hovered), fields: countFillable(picker.hovered) };
        stopPick();
        resolve({ ok: true, kind, picked });
      };

      const key = (event) => {
        if (event.key === 'Escape') {
          stopPick();
          resolve({ ok: false, error: 'cancelled' });
        }
      };

      picker.cleanup = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('keydown', key, true);
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', key, true);
    });
  }

  /** Pick and remember: the worker stores it per host, so the next round needs no picking. */
  async function pickAndStore(kind) {
    const result = await startPick(kind);
    if (!result.ok) return result;
    const stored = await send({ type: 'storeFormPick', kind, picked: result.picked });
    if (!stored.ok) return stored;
    if (kind !== 'root') {
      const target = resolveRoot(result.picked.selector);
      if (target) target.setAttribute(PIN, kind);
    }
    return { ok: true, kind, picked: result.picked, recipes: stored.recipes };
  }

  // --- the snapshot --------------------------------------------------------- //

  /** A radio/checkbox option's own text ("Так", "Ні"): the label, or the value as a fallback. */
  function optionLabelOf(control) {
    return labelTextFor(control) || oneLine(control.value, 120);
  }

  function isHidden(element) {
    try {
      return !(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    } catch (error) {
      return false;
    }
  }

  /**
   * Mint `data-cvt-id` on every fillable control of `root`, in **DOM order**.
   *
   * A radio/checkbox group (same `name`) is one field with N options: the plan answers the
   * *question*, and the applier picks the option - which is what a recruiter question actually
   * asks. Determinism is the contract: the same DOM yields the same ids, so a plan computed for a
   * snapshot still resolves after the page re-renders.
   */
  function annotate(root) {
    const scope = root instanceof Element ? root : document;
    Array.from(scope.querySelectorAll('[' + MARK + ']')).forEach((node) =>
      node.removeAttribute(MARK),
    );

    const records = new Map();
    const groups = new Map();
    const fields = [];

    for (const control of Array.from(scope.querySelectorAll('input, textarea, select'))) {
      if (!isFillable(control)) continue;
      const kind = kindOf(control);
      const name = control.getAttribute('name') || '';
      const grouped = (kind === 'radio' || kind === 'checkbox') && Boolean(name);

      if (grouped && groups.has(name)) {
        const id = groups.get(name);
        records.get(id).elements.push(control);
        records.get(id).field.options.push(optionLabelOf(control));
        records.get(id).field.required =
          records.get(id).field.required || isRequired(control);
        control.setAttribute(MARK, id);
        continue;
      }
      if (fields.length >= MAX_FIELDS) break;

      const id = 'f' + (fields.length + 1);
      control.setAttribute(MARK, id);
      const pinned = control.getAttribute(PIN) || '';
      const field = {
        id,
        kind,
        label: questionFor(control),
        name,
        placeholder: oneLine(control.getAttribute('placeholder')),
        required: isRequired(control),
        options: grouped ? [optionLabelOf(control)] : optionsOf(control),
        hidden: isHidden(control),
      };
      if (pinned) field.pin = pinned;
      fields.push(field);
      records.set(id, { field, elements: [control] });
      if (grouped) groups.set(name, id);
    }
    return { fields, records };
  }

  /** Mark the pinned fields (the two the extension fills itself) before annotating. */
  function markPins(pins) {
    document.querySelectorAll('[' + PIN + ']').forEach((node) => node.removeAttribute(PIN));
    Object.entries(pins || {}).forEach(([kind, selector]) => {
      const target = resolveRoot(selector);
      if (target) target.setAttribute(PIN, kind);
    });
  }

  /**
   * The form as the model sees it: the picked subtree, minus scripts/styles/SVG/our own overlay,
   * with interaction attributes dropped (they are noise, and `hx-*` is the site's own plumbing).
   * The `data-cvt-id` marks stay - they are what the plan is keyed on.
   */
  function trimmedHtml(root) {
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll('script, style, noscript, svg, link, meta, iframe, canvas')
      .forEach((node) => node.remove());
    clone.querySelectorAll('[' + UI + ']').forEach((node) => node.remove());
    clone.querySelectorAll('*').forEach((node) => {
      Array.from(node.attributes).forEach((attr) => {
        const noisy =
          attr.name === 'style' ||
          attr.name === 'autofocus' ||
          attr.name === 'tabindex' ||
          attr.name.startsWith('on') ||
          attr.name.startsWith('hx-') ||
          attr.name.startsWith('aria-controls');
        if (noisy) node.removeAttribute(attr.name);
      });
    });
    const html = clone.outerHTML || '';
    return html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  }

  // --- writing into the page ------------------------------------------------ //

  function highlight(element, ok) {
    try {
      element.style.outline = ok ? '2px solid #16a34a' : '2px solid #d97706';
    } catch (error) {
      /* a detached node is not worth failing over */
    }
  }

  /**
   * Set a value the way a *user* would: through the prototype's own setter and with bubbling
   * `input`/`change` events, so a framework-controlled field (htmx, Alpine, React on either site)
   * notices instead of overwriting the value on its next render.
   */
  function setValue(element, text) {
    const value = String(text == null ? '' : text);
    const proto =
      element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    highlight(element, true);
  }

  /** Choose an option of a select/radio/checkbox group by its visible label (or value). */
  function chooseOption(record, value) {
    const wanted = oneLine(value).toLowerCase();
    if (!wanted) return { ok: false, error: 'no option was named' };

    if (record.field.kind === 'select') {
      const select = record.elements[0];
      const option = Array.from(select.options || []).find(
        (item) =>
          oneLine(item.textContent).toLowerCase() === wanted ||
          oneLine(item.value).toLowerCase() === wanted,
      );
      if (!option) return { ok: false, error: 'no option matches ' + value };
      setValue(select, option.value);
      return { ok: true, option: oneLine(option.textContent) };
    }

    for (const control of record.elements) {
      const label = optionLabelOf(control).toLowerCase();
      const own = oneLine(control.value).toLowerCase();
      if (label === wanted || own === wanted) {
        if (control.tagName === 'INPUT' && control.type === 'radio') {
          control.click();
        } else {
          if (!control.checked) control.click();
        }
        highlight(control, true);
        return { ok: true, option: optionLabelOf(control) };
      }
    }
    return { ok: false, error: 'no option matches ' + value };
  }

  // --- JavaScript dropdowns (react-select and friends) ----------------------- //

  /**
   * A widget's dropdown can only be *selected*, never typed into - and its options cannot come from
   * the snapshot either, because react-select renders its list only while the menu is open. So the
   * label a candidate fact names is what drives it: open the widget, read what it just rendered,
   * click the matching option, and fall back to the widget's own search box for a long list - which
   * is exactly what a person does.
   */

  /** The clickable box of a dropdown: react-select's control, or the input's own container. */
  function comboboxControl(element) {
    return (
      element.closest(
        '[class*="select__control"], [class*="select-control"], [class*="combobox"], [class*="autocomplete"]',
      ) ||
      element.parentElement ||
      element
    );
  }

  /**
   * The options an open dropdown has rendered.
   *
   * Deliberately not filtered by visibility: a widget keeps a closed menu in the DOM and hides it
   * with CSS, and jsdom (where the tests run) reports *every* node as hidden - a visibility check
   * would find nothing at all. Only the a11y mirror react-select wraps in `aria-hidden` is dropped.
   */
  function comboboxOptions() {
    return Array.from(document.querySelectorAll('[role="option"]')).filter(
      (node) => !node.closest('[aria-hidden="true"]') && oneLine(node.textContent),
    );
  }

  /** Press a node the way a person does - every gesture a widget might be listening for. */
  function press(node) {
    if (!node) return;
    for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  /**
   * Open a dropdown and hand back the options it rendered.
   *
   * Which gesture opens it is the widget's business - react-select opens on a `mousedown` on its
   * control, others on focus, on a keystroke, or through their own toggle button - so the four ways
   * a person would try are tried in turn, and the first that makes a *new* option appear wins. A
   * widget none of them opens leaves the options that were already on the page (usually none), and
   * the caller reports that rather than typing into a box that would drop the text.
   */
  async function openCombobox(element) {
    const seen = new Set(comboboxOptions());
    const fresh = () => comboboxOptions().filter((node) => !seen.has(node));
    const control = comboboxControl(element);
    const toggle = Array.from(control.querySelectorAll('button, [class*="indicator"]')).find((node) =>
      /toggle|open|expand|arrow|select/i.test(
        (node.getAttribute('aria-label') || '') + ' ' + oneLine(node.className, 80),
      ),
    );
    const gestures = [
      () => press(element),
      () => press(control),
      () => press(toggle),
      () => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    ];
    for (const gesture of gestures) {
      if (fresh().length) return fresh();
      try {
        gesture();
        element.focus();
      } catch (error) {
        continue; // a gesture this page refuses is one to skip, not a run to fail
      }
      if (await waitFor(() => (fresh().length ? true : null), 400)) return fresh();
    }
    return comboboxOptions();
  }

  /** The option whose label matches the wanted text - exact first, then the looser readings. */
  function bestOption(options, value) {
    const needle = oneLine(value).toLowerCase();
    if (!needle) return null;
    const text = (node) => oneLine(node.textContent, 200).toLowerCase();
    return (
      options.find((node) => text(node) === needle) ||
      options.find((node) => text(node).startsWith(needle)) ||
      options.find((node) => text(node).includes(needle)) ||
      // The other direction, for a fact written as a sentence ("No sponsorship required" -> "No").
      options.find((node) => text(node).length > 1 && needle.includes(text(node))) ||
      null
    );
  }

  /** Type into the widget's search box: it is a filter, so the field is not marked as filled. */
  function typeInto(element, text) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(element, text);
    else element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Close a dropdown we opened but could not use, so the page is left as we found it. */
  function pressEscape(element) {
    try {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      element.blur();
    } catch (error) {
      /* an unwired node is not worth failing over */
    }
  }

  /** Choose an option of a JavaScript dropdown: open it, match the label, click it, verify it held. */
  async function chooseCombobox(record, value) {
    const element = record.elements[0];
    const wanted = oneLine(value);
    if (!wanted) return { ok: false, error: 'no option was named' };

    // A datalist-backed input is a combobox that is really a text field: typing *is* the answer.
    if (element.hasAttribute('list')) {
      setValue(element, wanted);
      return { ok: true, option: wanted };
    }

    const control = comboboxControl(element);
    let option = bestOption(await openCombobox(element), wanted);
    if (!option) {
      typeInto(element, wanted);
      option = await waitFor(() => bestOption(comboboxOptions(), wanted) || null, 1600);
    }
    if (!option) {
      pressEscape(element);
      return { ok: false, error: 'no option matches "' + wanted + '" - pick it yourself' };
    }

    const chosen = oneLine(option.textContent, 200);
    press(option);
    const kept = await waitFor(
      () =>
        oneLine(control.textContent, 240).toLowerCase().includes(chosen.toLowerCase())
          ? chosen
          : null,
      1200,
    );
    if (!kept) {
      return { ok: false, error: 'clicked "' + chosen + '" but the widget did not keep it' };
    }
    highlight(control, true);
    return { ok: true, option: chosen };
  }

  function fileFromBase64(base64, name, type) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], name || 'cv.pdf', { type: type || 'application/pdf' });
  }

  /**
   * Attach a document to a real `<input type=file>`.
   *
   * This is the one thing jsdom cannot do (it has no `DataTransfer`), which is why the manual
   * checklist in `apps/extension/README.md` covers it: in Chrome the assignment works, and the events
   * are what the site's own preview/listener reacts to.
   */
  function assignFile(element, base64, name) {
    const file = fileFromBase64(base64, name);
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.files = transfer.files;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    highlight(element, true);
    return file.name;
  }

  function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    return new Promise((resolve) => {
      const tick = () => {
        let value = null;
        try {
          value = predicate();
        } catch (error) {
          value = null;
        }
        if (value) return resolve(value);
        if (Date.now() > deadline) return resolve(null);
        window.setTimeout(tick, 150);
      };
      tick();
    });
  }

  // --- the per-site adapters ------------------------------------------------ //

  /**
   * Djinni's CV picker.
   *
   * There is no `input[type=file]` in that form: the resume is a TomSelect `<select>`, and the
   * only way to add the *tailored* document is the site's own "＋ Додати резюме" control, which
   * swaps `.js-cv-select-block` through htmx with an upload form. So: drive that control, fill the
   * file input it renders, submit the fragment, then wait for the option to appear. A per-site step
   * is exactly what an adapter is for - everything generic stays in `applyPlan`.
   */
  async function djinniResume(base64, name) {
    const block = document.querySelector('.js-cv-select-block');
    if (!block) return { ok: false, error: 'the CV block was not found on the page' };

    const wanted = String(name || '').toLowerCase();
    const already = Array.from(block.querySelectorAll('option')).find((option) =>
      String(option.textContent || '').toLowerCase().includes(wanted),
    );
    if (already) return { ok: true, option: oneLine(already.textContent), alreadyThere: true };

    const trigger =
      block.querySelector('a[hx-get*="cv_input"]') ||
      Array.from(block.querySelectorAll('a, button')).find((node) =>
        /резюме|додати|add/i.test(node.textContent || ''),
      );
    if (!trigger) return { ok: false, error: 'the site\'s "add a CV" control was not found' };
    trigger.click();

    const input = await waitFor(() => block.querySelector('input[type=file]'), 6000);
    if (!input) return { ok: false, error: 'no file input appeared after "add a CV"' };
    assignFile(input, base64, name);

    const submit = block.querySelector('button[type=submit], input[type=submit], form button');
    if (submit) submit.click();

    const option = await waitFor(
      () =>
        Array.from(block.querySelectorAll('option')).find((item) =>
          String(item.textContent || '').toLowerCase().includes(wanted),
        ),
      10000,
    );
    return option
      ? { ok: true, option: oneLine(option.textContent) }
      : {
          ok: true,
          warning:
            'the PDF was uploaded, but the new CV option was not visible yet - check the site',
        };
  }

  function adapterFor(host) {
    if (/djinni\.co$/i.test(String(host || ''))) return { resume: djinniResume };
    // Other sites (DOU included) render a plain <input type=file>, so the generic path applies.
    return null;
  }

  async function applyResume(record, instructions, report) {
    const label = record.field.label || 'the resume field';
    const file = instructions.file;
    if (!file || !file.base64) {
      report.skipped.push({ label, reason: 'no tailored PDF is available for this card' });
      return;
    }
    const input =
      record.elements.find((element) => element.tagName === 'INPUT' && element.type === 'file') ||
      (record.elements[0].closest('form, div') || document).querySelector('input[type=file]');
    if (input) {
      const name = assignFile(input, file.base64, file.name);
      report.filled.push({ label, what: 'attached ' + name });
      return;
    }
    const adapter = adapterFor(instructions.host);
    if (adapter) {
      const result = await adapter.resume(file.base64, file.name);
      if (result.ok) {
        report.filled.push({
          label,
          what: result.option ? 'attached as "' + result.option + '"' : 'uploaded the PDF',
        });
        if (result.warning) {
          report.note = report.note ? report.note + ' | ' + result.warning : result.warning;
        }
        return;
      }
      report.failed.push({ label, reason: result.error });
      return;
    }
    report.skipped.push({
      label,
      reason: 'this form has no file input the extension can fill - attach the PDF by hand',
    });
  }

  /**
   * Write a plan into the page.
   *
   * `instructions` is what the worker assembled: the plan's fields (keyed by the ids this script
   * minted), the cover letter text, the PDF bytes, the pins, and the note. Everything is applied
   * through `setValue`, `chooseOption`, `chooseCombobox` and `assignFile`, and the report that comes
   * back is what the popup shows. Nothing here ever submits, ticks a consent box, or touches a field
   * the operator already filled - the applier only writes what the plan named.
   */
  async function applyPlan(instructions) {
    const root = resolveRoot(instructions.root) || document;
    if (instructions.pins) markPins(instructions.pins);

    const { records } = annotate(root);
    const report = { filled: [], skipped: [], failed: [], note: oneLine(instructions.note, 500) };

    const applyOne = async (item) => {
      const label = item.label || item.id;
      const record = records.get(item.id);
      if (!record) {
        report.failed.push({ label, reason: 'that field is not on the page any more' });
        return;
      }
      const element = record.elements[0];

      // A JS dropdown looks like a text input and is not one: writing into it shows a value the
      // widget ignores on its next render. Only a *chosen option* is real there - so the applier
      // opens the widget and clicks the label the plan named.
      if (record.field.kind === 'combobox' && (item.action === 'answer' || item.action === 'select')) {
        if (item.action !== 'select') {
          report.skipped.push({
            label,
            reason: 'a JavaScript dropdown needs the option to click - nothing to type into it',
          });
          return;
        }
        const chosen = await chooseCombobox(record, item.value);
        if (chosen.ok) report.filled.push({ label, what: chosen.option });
        else report.failed.push({ label, reason: chosen.error });
        return;
      }

      if (item.action === 'answer') {
        setValue(element, item.value);
        report.filled.push({ label, what: oneLine(item.value, 140) });
        return;
      }
      if (item.action === 'select') {
        const chosen = chooseOption(record, item.value);
        if (chosen.ok) report.filled.push({ label, what: chosen.option });
        else report.failed.push({ label, reason: chosen.error });
        return;
      }
      if (item.action === 'cover_letter') {
        const letter = instructions.cover;
        if (!letter || !letter.text) {
          report.skipped.push({
            label,
            reason: 'no cover letter on the board yet (generate it there first)',
          });
          return;
        }
        setValue(element, letter.text);
        report.filled.push({
          label,
          what: 'the cover letter (' + letter.text.length + ' chars)',
        });
        return;
      }
      if (item.action === 'resume_file') {
        await applyResume(record, instructions, report);
        return;
      }
      report.skipped.push({ label, reason: item.reason || 'left to you' });
    };

    const handled = new Set();
    for (const item of instructions.fields || []) {
      handled.add(item.id);
      await applyOne(item);
    }
    // A pinned field is ours to fill even when the plan never mentioned it.
    for (const [id, record] of records) {
      if (handled.has(id) || !record.field.pin) continue;
      await applyOne({ id, action: record.field.pin, label: record.field.label });
    }

    return {
      ok: true,
      filled: report.filled,
      skipped: report.skipped,
      failed: report.failed,
      note: report.note,
    };
  }

  // --- the worker's call surface -------------------------------------------- //

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== 'cvtForm' || !alive()) return undefined;
      (async () => {
        try {
          if (message.action === 'pick') {
            sendResponse(await pickAndStore(message.kind));
          } else if (message.action === 'snapshot') {
            const root = resolveRoot(message.root);
            if (!root) {
              sendResponse({ ok: false, error: 'the picked form is not on this page' });
              return;
            }
            if (message.pins) markPins(message.pins);
            const { fields } = annotate(root);
            sendResponse({ ok: true, root: cssPath(root), html: trimmedHtml(root), fields });
          } else if (message.action === 'apply') {
            sendResponse(await applyPlan(message.instructions || {}));
          } else {
            sendResponse({ ok: false, error: 'unknown form action' });
          }
        } catch (error) {
          sendResponse({
            ok: false,
            error: error && error.message ? error.message : String(error),
          });
        }
      })();
      return true; // async response
    });
  } catch (error) {
    // No listener available in this context; the popup reports that instead.
  }

  log('form filler ready');
})();
