/**
 * The `Scrape` / `Scraped` control, on the vacancy itself.
 *
 * A content script (declared in `manifest.json`), so this file is a **classic** script: no
 * imports and no exports, and it shares the page's isolated world with nothing else. Every
 * network call goes through the service worker (`cardStatus`, `scrapeCard`), because a `fetch`
 * from a content script is judged by the *page's* CORS rules.
 *
 * Two page shapes, one control - what a button belongs to here is the **unit**:
 *
 *   a listing card   Djinni and DOU: `div[id^="job-item-"]`, one vacancy each, the `id` is the
 *                    external_id, and the site's own `[data-job-id]` hook (on
 *                    `button.copy-link-item`) finds the footer's action row.
 *   the job page     a board whose listing is a feed rather than cards (Greenhouse): the whole
 *                    page *is* one vacancy, its id is in the URL, and there is no footer to sit
 *                    in - so the button goes next to the page's own `h1`.
 *
 * DOM contract (the card markup is documented in `apps/extension/AGENTS.md`):
 *
 *   div[id^="job-item-"]                    a card; `id` -> external_id
 *   [data-job-id]                           the card's own hook; its parent is the action row
 *   #application-form, .job__description    a board page that *is* one vacancy - `JOB_PAGE.marker`
 *                                           (`sites/plans.js`), the one selector copied into this
 *                                           file, because a manifest content script cannot import
 *                                           the registry and the *reading* stays in `extract.js`;
 *                                           `inject.test.ts` fails if the two ever drift
 *   /jobs/<digits> in the URL               that vacancy's id - a bare board carries the markup,
 *                                           names no job, and gets no button at all
 *
 * The button is appended with `margin-left:auto` into the action row, or inserted after the title
 * on a job page, and both are re-injected after a swap of the block they sit in.
 *
 * States are visible on the element as `data-cvt-state`:
 *
 *   idle  -> a green `Scrape` button
 *   busy  -> the same button, disabled, `Scraping…`
 *   done  -> `Scraped`, a link to `<gateway>/?card=<job_id>` (that vacancy in the backoffice)
 *   error -> `Retry scrape`, with the reason in the tooltip and the console
 */
(() => {
  'use strict';

  const CARD_SELECTOR = 'div[id^="job-item-"]';
  /**
   * A board page that renders no cards, because the whole page *is* one vacancy. The gate is the
   * platform's own marker **plus** an id in the URL: a bare board carries the markup but names no job,
   * and a career site whose page this scraper cannot read (Teamtailor, `buttons: 'none'`) carries no
   * marker at all - neither gets a button, and `scrapeCard` would refuse both, so a button there could
   * only ever offer a click that fails.
   *
   * A copy of `JOB_PAGE.marker` (`sites/plans.js`) on purpose - see the header - and the *only*
   * selector in this file that is not a card's: it decides where a button goes, never what a vacancy
   * says.
   */
  const JOB_PAGE_SELECTOR = '#application-form, .job__description';
  /** The URL shape `JOB_PAGE.urlId` is scraped with: the vacancy's own id. */
  const JOB_ID_IN_URL = /\/jobs\/(\d+)(?:\/|$)/;
  // The site's own hook for "this card's vacancy id": its copy-link button. Preferred over a
  // bare `[data-job-id]`, which some card variants put on other elements; the footer block is
  // the last resort.
  const HOOK_SELECTOR = '.copy-link-item[data-job-id]';
  const ANY_HOOK_SELECTOR = '[data-job-id]';
  const BUTTON_CLASS = 'cvt-scrape';
  const BUTTON_BASE = 'btn btn-sm ' + BUTTON_CLASS;
  const DEFAULT_GATEWAY = 'http://localhost:4321';
  const RESCAN_DELAY_MS = 200;

  /** external_id -> { jobId, status, archived }, learned from the gateway. */
  const known = new Map();
  let gateway = DEFAULT_GATEWAY;
  let scanTimer = null;
  let observer = null;

  const log = (...args) => console.info('[cv-tailoring]', ...args);

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

  /** Is this unit one of the listing cards? (A page unit is `documentElement`.) */
  function isCard(unit) {
    return Boolean(unit && unit.matches && unit.matches(CARD_SELECTOR));
  }

  /** The vacancy id this page's own URL names, or '' when it names none. */
  function jobPageId() {
    try {
      const match = (window.location.pathname + window.location.search).match(JOB_ID_IN_URL);
      return match ? match[1] : '';
    } catch (error) {
      return '';
    }
  }

  /**
   * The page as a unit - `documentElement`, so it is a real element that can be matched and handed
   * around like a card - when this page is one vacancy's own page, else null. Both halves are needed:
   * the marker says the page renders a vacancy, the URL says *which* one it is.
   */
  function pageUnit() {
    if (!jobPageId()) return null;
    return document.querySelector(JOB_PAGE_SELECTOR) ? document.documentElement : null;
  }

  /**
   * Every unit this page has a control for: its cards, or the page itself when the board renders none.
   * Never both - a page unit exists only where there is no card to click.
   */
  function units() {
    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
    if (cards.length > 0) return cards;
    const page = pageUnit();
    return page ? [page] : [];
  }

  /** The unit a button belongs to: its card, else the page when the page is one vacancy. */
  function unitOf(element) {
    const card = element && element.closest ? element.closest(CARD_SELECTOR) : null;
    return card || pageUnit();
  }

  /** The vacancy a unit stands for: a card carries its own, a job page has it in the URL. */
  function externalIdOf(unit) {
    if (!isCard(unit)) return jobPageId();

    const fromId = (unit.getAttribute('id') || '')
      .replace(/^job-item-/, '')
      .replace(/^job-post-/, '')
      .trim();
    if (fromId && /^\d+$/.test(fromId)) return fromId;

    const dataId = (
      unit.getAttribute('data-job-post-id') ||
      unit.getAttribute('data-job-id') ||
      ''
    ).trim();
    if (dataId) return dataId;

    const hook = hookOf(unit);
    if (hook) {
      const hookId = String(
        hook.getAttribute('data-job-post-id') ||
        hook.getAttribute('data-job-id') ||
        ''
      ).trim();
      if (hookId) return hookId;
    }

    const link = unit.querySelector('a[href]');
    if (link) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/(?:job_post_id=|\/jobs\/|id=)(\d+)/i);
      if (match) return match[1];
    }

    return fromId || '';
  }

  function hookOf(card) {
    return card.querySelector(HOOK_SELECTOR) || card.querySelector(ANY_HOOK_SELECTOR);
  }

  /**
   * The footer row the site's own actions live in (bookmark / hide / copy link). That row is
   * the parent of the copy-link button - the one element here the site itself keys on, since
   * its analytics reads it - with the footer block as a fallback.
   */
  function actionRowOf(card) {
    const hook = hookOf(card);
    if (hook && hook.parentElement) return hook.parentElement;
    const footer = card.querySelector('div.d-flex.flex-column.gap-1');
    if (footer && footer.lastElementChild) return footer.lastElementChild;
    if (footer) return footer;
    return card;
  }

  /**
   * The control this unit already has, if any. A page unit's sits beside the title, and a page unit
   * exists only where there are no cards - so there is never more than one to find there.
   */
  function buttonFor(unit) {
    if (isCard(unit)) return unit.querySelector('.' + BUTTON_CLASS);
    const title = document.querySelector('h1');
    const parent = (title && title.parentElement) || document.querySelector(JOB_PAGE_SELECTOR);
    return parent ? parent.querySelector('.' + BUTTON_CLASS) : null;
  }

  /**
   * Put a fresh button where its unit has room for one: the action row a card's own actions live in, or
   * - on a page that *is* one vacancy - right after the job title, with the marker block as the fallback
   * for a layout that renders no `h1`. `false` means no room, and the unit is skipped rather than given
   * a container of our own.
   */
  function mount(unit, button) {
    if (isCard(unit)) {
      const row = actionRowOf(unit);
      if (!row) return false;
      row.appendChild(button);
      return true;
    }

    // The action row's `margin-left:auto` would do nothing here (the title block is not a flex row),
    // so the button gets a little air of its own instead.
    const title = document.querySelector('h1');
    if (title && title.parentElement) {
      button.style.marginLeft = '12px';
      title.parentElement.insertBefore(button, title.nextSibling);
      return true;
    }
    const block = document.querySelector(JOB_PAGE_SELECTOR);
    if (!block) return false;
    button.style.marginLeft = '12px';
    block.insertBefore(button, block.firstChild);
    return true;
  }

  /** Human wording for a card the board already has (goes into the link's tooltip). */
  function statusHint(entry) {
    const status = String((entry && entry.status) || 'submitted');
    if (entry && entry.archived) return 'refused';
    if (status === 'completed' || status === 'skipped') return 'tailored';
    if (status === 'failed' || status === 'rate_limited' || status === 'dead_lettered') {
      return 'tailoring failed';
    }
    return 'tailoring in progress';
  }

  function makeButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_BASE + ' btn-success';
    button.textContent = 'Scrape';
    button.title = 'Tailor the CV for this vacancy and put it on the board';
    button.dataset.cvtState = 'idle';
    button.style.marginLeft = 'auto';
    // Capture phase + stopPropagation: the card itself opens the vacancy on any click, and
    // scraping must not also open a tab.
    button.addEventListener('click', onClick, true);
    return button;
  }

  function renderBusy(button) {
    button.disabled = true;
    button.dataset.cvtState = 'busy';
    button.textContent = 'Scraping…';
  }

  /** Chrome's API errors are accurate but terse; the permission one has a known fix. */
  function friendlyError(error) {
    const text = String(error || '');
    if (/Cannot access contents of the page|must request permission/i.test(text)) {
      return 'permission missing - reload the extension on chrome://extensions';
    }
    return text;
  }

  function renderError(unit, error) {
    const current = buttonFor(unit);
    if (!current) return;
    const button = current.tagName === 'BUTTON' ? current : makeButton();
    if (button !== current) current.replaceWith(button);
    button.disabled = false;
    button.dataset.cvtState = 'error';
    button.textContent = 'Retry scrape';
    button.title = 'Failed: ' + friendlyError(error) + ' - click to try again';
  }

  /** The scraped state: a link to that vacancy's card in the backoffice. */
  function renderDone(unit, jobId, gatewayUrl, hint) {
    const current = buttonFor(unit);
    if (!current) return;

    const link = document.createElement('a');
    link.className = BUTTON_BASE + ' btn-link';
    link.href = String(gatewayUrl || gateway).replace(/\/+$/, '') + '/?card=' + encodeURIComponent(jobId);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Scraped';
    link.title = 'On the board - ' + hint + ' - open the card in the backoffice';
    link.dataset.cvtState = 'done';
    link.dataset.cvtExternalId = externalIdOf(unit);
    link.style.marginLeft = isCard(unit) ? 'auto' : '12px';
    link.addEventListener('click', (event) => event.stopPropagation(), true);
    current.replaceWith(link);
  }

  /** Every vacancy id this page's controls cover. */
  function unitIds() {
    const ids = [];
    for (const unit of units()) {
      const externalId = externalIdOf(unit);
      if (externalId) ids.push(externalId);
    }
    return ids;
  }

  /**
   * The popup can queue the whole page in one batch while these buttons are showing, so the
   * worker tells us when the board changed; otherwise a card would keep offering `Scrape`
   * although it is already queued.
   */
  async function refreshKnown() {
    const ids = unitIds();
    if (ids.length > 0) await askStatus(ids);
  }

  /**
   * One click, one unit.
   *
   * A vacancy the board already has never costs a request - the button *is* the state - and one it
   * does not have goes through the service worker, which extracts it with the very scraper the popup
   * uses and queues it as a batch of one (`extract.js` does the reading; this file only says which
   * vacancy, and which unit the answer belongs to).
   */
  async function onClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const element = event.currentTarget;
    const unit = unitOf(element);
    if (!unit) return;

    const externalId = externalIdOf(unit);
    if (!externalId) return;

    const already = known.get(externalId);
    if (already && already.jobId) {
      renderDone(unit, already.jobId, gateway, statusHint(already));
      return;
    }

    renderBusy(element);
    const response = await send({ type: 'scrapeCard', externalId: externalId });
    if (!response.ok) {
      log('scrape failed for', externalId, response.error);
      renderError(unit, response.error || 'scrape failed');
      return;
    }

    if (!response.jobId) {
      renderError(card, 'the gateway did not return a card id');
      return;
    }

    const entry = { jobId: response.jobId, status: 'submitted', archived: false };
    known.set(externalId, entry);
    if (response.gateway) gateway = response.gateway;
    renderKnown();
    log('queued', externalId, response.jobId, response.note || '');
  }

  /** Re-render every unit whose vacancy the board now knows (one vacancy can be on a page twice). */
  function renderKnown() {
    for (const unit of units()) {
      const entry = known.get(externalIdOf(unit));
      if (entry && entry.jobId && buttonFor(unit)) {
        renderDone(unit, entry.jobId, gateway, statusHint(entry));
      }
    }
  }

  /** One lookup for every vacancy the page just showed us that the board might already have. */
  async function askStatus(externalIds) {
    const response = await send({ type: 'cardStatus', externalIds: externalIds });
    if (!response.ok) {
      // "not signed in" is the normal case before the popup signs in; the buttons simply stay
      // as `Scrape` until then.
      if (response.error !== 'not signed in') log('status lookup failed', response.error);
      return;
    }
    if (response.gateway) gateway = response.gateway;

    for (const externalId of Object.keys(response.known || {})) {
      const entry = response.known[externalId];
      if (entry && entry.jobId) known.set(externalId, entry);
    }

    renderKnown();
  }

  /** Put a button on every unit that does not have one yet. */
  function scan() {
    if (!alive()) {
      // The extension was reloaded/updated: this context can no longer talk to it, and the
      // observer would only spin.
      if (observer) observer.disconnect();
      return;
    }

    const unknown = [];
    for (const unit of units()) {
      if (buttonFor(unit)) continue;
      const externalId = externalIdOf(unit);
      if (!externalId) continue;

      const button = makeButton();
      button.dataset.cvtExternalId = externalId;
      if (!mount(unit, button)) continue;

      const entry = known.get(externalId);
      if (entry && entry.jobId) renderDone(unit, entry.jobId, gateway, statusHint(entry));
      else unknown.push(externalId);
    }

    if (unknown.length > 0) void askStatus(unknown);
  }

  /** htmx/React swap a card or a job title in place, so re-scan - debounced. */
  function schedule() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, RESCAN_DELAY_MS);
  }

  // The popup queues a whole page in one batch; pick that up so its buttons agree with it.
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'boardChanged') void refreshKnown();
    });
  } catch (error) {
    // No listener available in this context; the buttons still reflect the state on load.
  }

  scan();

  const root = document.body || document.documentElement;
  if (root) {
    observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
  }
})();
