/**
 * Per-card `Scrape` buttons for a Djinni listing page, injected at load.
 *
 * A content script (declared in `manifest.json`), so this file is a **classic** script: no
 * imports and no exports, and it shares the page's isolated world with nothing else. Every
 * network call goes through the service worker (`cardStatus`, `scrapeCard`), because a `fetch`
 * from a content script is judged by the *page's* CORS rules.
 *
 * DOM contract (the card markup is documented in `extension/AGENTS.md`):
 *
 *   div[id^="job-item-"]   the vacancy card; `id` -> external_id
 *   [data-job-id]          the site's own hook (on `button.copy-link-item`) - used to find the
 *                          footer's action row, which is that element's parent
 *
 * The button is appended to that action row with `margin-left:auto`, i.e. the footer's right
 * bottom corner, and is re-injected after every htmx swap (the site replaces cards in place
 * when you favourite or hide one).
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

  function externalIdOf(card) {
    const fromId = (card.getAttribute('id') || '').replace(/^job-item-/, '').trim();
    if (fromId) return fromId;
    const hook = hookOf(card);
    return hook ? String(hook.getAttribute('data-job-id') || '').trim() : '';
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

  function buttonFor(card) {
    return card.querySelector('.' + BUTTON_CLASS);
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
    // The right bottom corner of the footer.
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

  function renderError(card, error) {
    const current = buttonFor(card);
    if (!current) return;
    const button = current.tagName === 'BUTTON' ? current : makeButton();
    if (button !== current) current.replaceWith(button);
    button.disabled = false;
    button.dataset.cvtState = 'error';
    button.textContent = 'Retry scrape';
    button.title = 'Failed: ' + friendlyError(error) + ' - click to try again';
  }

  /** The scraped state: a link to that vacancy's card in the backoffice. */
  function renderDone(card, jobId, gatewayUrl, hint) {
    const current = buttonFor(card);
    if (!current) return;

    const link = document.createElement('a');
    link.className = BUTTON_BASE + ' btn-link';
    link.href = String(gatewayUrl || gateway).replace(/\/+$/, '') + '/?card=' + encodeURIComponent(jobId);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Scraped';
    link.title = 'On the board - ' + hint + ' - open the card in the backoffice';
    link.dataset.cvtState = 'done';
    link.dataset.cvtExternalId = externalIdOf(card);
    link.style.marginLeft = 'auto';
    link.addEventListener('click', (event) => event.stopPropagation(), true);
    current.replaceWith(link);
  }

  /** Every card id currently on the page. */
  function cardIds() {
    const ids = [];
    for (const card of Array.from(document.querySelectorAll(CARD_SELECTOR))) {
      const externalId = externalIdOf(card);
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
    const ids = cardIds();
    if (ids.length > 0) await askStatus(ids);
  }

  /**
   * One click, one card.
   *
   * A card the board already has never costs a request - the button *is* the state - and a
   * card it does not have goes through the service worker, which extracts it with the very
   * scraper the popup uses and queues it as a batch of one.
   */
  async function onClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const element = event.currentTarget;
    const card = element.closest(CARD_SELECTOR);
    if (!card) return;

    const externalId = externalIdOf(card);
    if (!externalId) return;

    const already = known.get(externalId);
    if (already && already.jobId) {
      renderDone(card, already.jobId, gateway, statusHint(already));
      return;
    }

    renderBusy(element);
    const response = await send({ type: 'scrapeCard', externalId: externalId });
    if (!response.ok) {
      log('scrape failed for', externalId, response.error);
      renderError(card, response.error || 'scrape failed');
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

  /** Re-render every card whose vacancy the board now knows (one vacancy can be on the page twice). */
  function renderKnown() {
    for (const card of Array.from(document.querySelectorAll(CARD_SELECTOR))) {
      const entry = known.get(externalIdOf(card));
      if (entry && entry.jobId && buttonFor(card)) {
        renderDone(card, entry.jobId, gateway, statusHint(entry));
      }
    }
  }

  /** One lookup for every card the page just showed us that the board might already have. */
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

  /** Put a button on every card that does not have one yet. */
  function scan() {
    if (!alive()) {
      // The extension was reloaded/updated: this context can no longer talk to it, and the
      // observer would only spin.
      if (observer) observer.disconnect();
      return;
    }

    const unknown = [];
    for (const card of Array.from(document.querySelectorAll(CARD_SELECTOR))) {
      if (buttonFor(card)) continue;
      const externalId = externalIdOf(card);
      if (!externalId) continue;

      const row = actionRowOf(card);
      if (!row) continue;

      const button = makeButton();
      button.dataset.cvtExternalId = externalId;
      row.appendChild(button);

      const entry = known.get(externalId);
      if (entry && entry.jobId) renderDone(card, entry.jobId, gateway, statusHint(entry));
      else unknown.push(externalId);
    }

    if (unknown.length > 0) void askStatus(unknown);
  }

  /** htmx swaps cards in place (favourite/hide, infinite scroll), so re-scan - debounced. */
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
