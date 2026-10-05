/**
 * Per-card `Scrape` buttons for Indeed's job feed (`pt.indeed.com` and friends).
 *
 * A content script (declared in `manifest.json`), so this file is a **classic** script: no imports
 * and no exports. Every network call goes through the service worker (`cardStatus`, `scrapeCard`),
 * because a `fetch` from a content script is judged by the *page's* CORS rules.
 *
 * Why not `inject.js`: Indeed's feed is two panes. The cards on the left carry a snippet, and the
 * right pane holds the full text of whichever card is selected - **exactly one description exists
 * on the page at a time** (live page 2026-10-05: 12 cards, one `[data-testid="viewjob-main-content"]`).
 * So a card cannot be scraped where it stands: the button selects its card, waits for the pane, and
 * only then asks the worker to extract - `extractVacancies` reads the *selected* vacancy
 * (`extract.js::indeedSelectedJob`). Reading the cards instead would file a snippet as if it were a
 * job description, which is the one thing the batch contract exists to prevent.
 *
 * DOM contract (a copy of the live markup is `fixtures/indeed-feed.html`):
 *
 *   div.cardOutline                      the vacancy card; `a[data-jk]` inside carries the id
 *   div.cardOutline.vjs-highlight        the card the pane is showing
 *   .ctaContainer                        the card's own action row (save / not interested); its
 *                                        *parent* is the block the button's row is appended to, and
 *                                        unlike the row's labels that block is locale-independent
 *   [data-testid="viewjob-main-content"] the right pane - read by the *worker*, never here
 *
 * States are visible on the element as `data-cvt-state`: idle / busy / done / error, the vocabulary
 * `inject.js` also uses.
 *
 * Test hook: `document.documentElement.dataset.cvtIndeedDeadlineMs` shortens the pane wait, the way
 * a Python backend's `reset_*_cache()` shortens a pipeline. Production never sets it.
 */
(() => {
  'use strict';

  const CARD_SELECTOR = 'div.cardOutline';
  const SELECTED_SELECTOR = 'div.cardOutline.vjs-highlight';
  const ACTION_ROW_SELECTOR = '.ctaContainer';
  const JK_SELECTOR = 'a[data-jk]';
  const PANE_SELECTOR = '[data-testid="viewjob-main-content"]';
  /**
   * The pane's description container. This script only *waits* for it to have text; `extract.js` is
   * what reads it into a vacancy. The string is therefore shared between two files, and a test in
   * `indeed.test.ts` asserts they cannot drift apart.
   */
  const DESCRIPTION_SELECTOR = '.simple-job-description-html';
  const BUTTON_CLASS = 'cvt-scrape';
  const BUTTON_BASE = 'btn btn-sm ' + BUTTON_CLASS;
  /** The strip the button lives in - see `placeButton`. */
  const ROW_CLASS = 'cvt-scrape-row';
  const DEFAULT_GATEWAY = 'http://localhost:4321';
  const RESCAN_DELAY_MS = 200;
  /**
   * How long to wait for the pane, and how often to look.
   *
   * Generous on purpose: the pane's *data* and its *description HTML* arrive separately, and on the
   * live site the text can lag the selection by seconds (2026-10-05 - a 3s wait handed the worker an
   * empty pane, which surfaced as "that card is not on this page any more"). Nothing here is
   * latency-critical: this is one operator clicking one card.
   */
  const PANE_WAIT_MS = 15000;
  const POLL_INTERVAL_MS = 250;

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

  /** How long to wait for the pane: the constant, unless the test hook above overrides it. */
  function deadlineMs() {
    const root = document.documentElement;
    const override = root ? Number(root.dataset.cvtIndeedDeadlineMs) : NaN;
    return Number.isFinite(override) && override > 0 ? override : PANE_WAIT_MS;
  }

  function externalIdOf(card) {
    const link = card.querySelector(JK_SELECTOR);
    return link ? String(link.getAttribute('data-jk') || '').trim() : '';
  }

  /** The card for an id, re-resolved: Indeed re-renders its list in place when the pane changes. */
  function cardFor(externalId) {
    for (const card of Array.from(document.querySelectorAll(CARD_SELECTOR))) {
      if (externalIdOf(card) === externalId) return card;
    }
    return null;
  }

  function selectedId() {
    const selected = document.querySelector(SELECTED_SELECTOR);
    return selected ? externalIdOf(selected) : '';
  }

  /** The pane's own id, from the `fromjk` its company and apply links carry (it has no data-jk). */
  function paneId() {
    const pane = document.querySelector(PANE_SELECTOR);
    if (!pane) return '';
    const found = String(pane.innerHTML || '').match(/fromjk=([0-9a-f]{8,32})/i);
    return found ? found[1] : '';
  }

  /** The pane's rendered description, or '' while it is still loading. */
  function descriptionOf(pane) {
    if (!pane) return '';
    const node = pane.querySelector(DESCRIPTION_SELECTOR);
    return node ? String(node.textContent || '').trim() : '';
  }

  /**
   * Is the page's pane *ready to be read* for this vacancy?
   *
   * Two conditions, and both are needed:
   *
   * * **the pane must name the job itself** (`fromjk`). The highlighted card is only a fallback for
   *   a layout that renders no `fromjk`, because the highlight moves a beat before the pane's text
   *   does - wait on the card alone and the worker can be handed an id whose description is still
   *   the previous vacancy's.
   * * **the description must actually be rendered.** The pane's data and its HTML arrive separately,
   *   which is exactly what "Failed: that card is not on this page any more" was, live, on
   *   2026-10-05: the selection had landed, the text had not.
   */
  function paneReady(externalId) {
    const pane = document.querySelector(PANE_SELECTOR);
    if (!pane) return false;
    if (!descriptionOf(pane)) return false;
    const named = paneId();
    if (named) return named === externalId;
    return selectedId() === externalId;
  }

  /**
   * Put the page on this card, the way the operator's own click would - and *only* that.
   *
   * A synthetic event is dispatched instead of `element.click()`, because the card's link is
   * `target="_blank"` and a trusted click would open the posting. Two guards make sure nothing else
   * happens either, because the sweep runs this once per card (live 2026-10-05: "the autoscraper opens
   * vacancies"):
   *
   * * `preventDefault`, so the anchor's own `href`/`target` cannot act on the click;
   * * `window.open` muted for the duration of the dispatch, because Indeed's own handler - the one
   *   that *does* have to run, since it swaps the pane - is also free to open the posting, and unlike
   *   a default action that is not something `preventDefault` can stop.
   */
  function select(card) {
    const link = card.querySelector(JK_SELECTOR);
    if (!link) return;

    const opened = window.open;
    try {
      window.open = () => null;
    } catch (error) {
      // A window that refuses the override: the click still selects, it may just open a tab too.
    }

    try {
      link.addEventListener('click', (event) => event.preventDefault(), { once: true, capture: true });
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } finally {
      window.open = opened;
    }
  }

  /** Wait for the pane to be ready to read; false once the deadline passes. */
  function waitForPane(externalId) {
    if (paneReady(externalId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (paneReady(externalId)) return resolve(true);
        if (Date.now() - started >= deadlineMs()) return resolve(false);
        setTimeout(tick, POLL_INTERVAL_MS);
      };
      setTimeout(tick, POLL_INTERVAL_MS);
    });
  }

  /**
   * Select this vacancy's card and answer once its pane is readable.
   *
   * One click, one card - shared by this file's own button and by the sweep
   * (`indeed/sweep.js`, which walks the whole feed through the messages at the bottom). A card that
   * is already the one on screen is not clicked again, and the answer waits on the *pane*, never on
   * the click.
   */
  async function selectAndWait(externalId) {
    const card = cardFor(externalId);
    if (!card) return false;
    if (!paneReady(externalId)) select(card);
    return waitForPane(externalId);
  }

  /** Indeed ships no button stylesheet we may lean on, so the button styles itself. */
  function styleButton(node, kind) {
    // No `margin-left:auto`: the button is centred by its own row, not pushed to one end of Indeed's
    // icon row (`placeButton`).
    node.style.padding = '6px 12px';
    node.style.borderRadius = '8px';
    node.style.borderStyle = 'solid';
    node.style.borderWidth = '1px';
    node.style.font = '600 13px/1.2 "Indeed Sans", "Noto Sans", Helvetica, Arial, sans-serif';
    node.style.cursor = 'pointer';
    if (kind === 'done') {
      node.style.background = '#e4e2e0';
      node.style.borderColor = '#2d2d2d';
      node.style.color = '#2d2d2d';
      node.style.textDecoration = 'none';
      return;
    }
    node.style.background = '#2557a7';
    node.style.borderColor = '#2557a7';
    node.style.color = '#ffffff';
  }

  function buttonFor(card) {
    return card.querySelector('.' + BUTTON_CLASS);
  }

  /**
   * Put the button in its own strip: a full-width row, appended to the bottom of the card, with the
   * button centred in it.
   *
   * It used to be appended to `.ctaContainer` itself with `margin-left:auto`, which parked it at the
   * right end of Indeed's save / not-interested row - the far corner from where the card's text ends,
   * and one more icon to pick out of a row of icons (operator request 2026-10-05).
   *
   * The host is the block that *contains* the action row (`div.job_seen_beacon`: the info table, then
   * `.ctaContainer`, then an empty analytics placeholder), i.e. the card's own content block: the strip
   * then shares the card's padding and sits under Indeed's icons. **Appended**, never inserted, so it
   * is the last thing in that block - the bottom of the card, which is what a test asserts. The card
   * itself is the fallback for a variant that renders no action row at all, and the states are free to
   * swap the button for a link in place: they replace the *button*, so the layout stays this one.
   */
  function placeButton(card, button) {
    const row = document.createElement('div');
    row.className = ROW_CLASS;
    row.style.display = 'flex';
    row.style.justifyContent = 'center';
    row.style.alignItems = 'center';
    row.style.width = '100%';
    row.style.marginTop = '8px';
    row.appendChild(button);

    const actionRow = card.querySelector(ACTION_ROW_SELECTOR);
    const host = (actionRow && actionRow.parentElement) || card;
    host.appendChild(row);
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
    button.title =
      'Select this vacancy, read its description from the right pane and put it on the board';
    button.dataset.cvtState = 'idle';
    styleButton(button, 'idle');
    // Capture phase + stopPropagation: the card itself selects (and can open) the vacancy, and
    // scraping must not also do that by itself.
    button.addEventListener('click', onClick, true);
    return button;
  }

  function renderBusy(button) {
    button.disabled = true;
    button.dataset.cvtState = 'busy';
    button.textContent = 'Scraping…';
    button.title = 'Selecting the vacancy and waiting for the description…';
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
    styleButton(button, 'idle');
  }

  /** The scraped state: a link to that vacancy's card in the backoffice. */
  function renderDone(card, jobId, gatewayUrl, hint) {
    const current = buttonFor(card);
    if (!current) return;

    const link = document.createElement('a');
    link.className = BUTTON_BASE + ' btn-link';
    link.href =
      String(gatewayUrl || gateway).replace(/\/+$/, '') + '/?card=' + encodeURIComponent(jobId);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Scraped';
    link.title = 'On the board - ' + hint + ' - open the card in the backoffice';
    link.dataset.cvtState = 'done';
    link.dataset.cvtExternalId = externalIdOf(card);
    styleButton(link, 'done');
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

  /** One lookup for every card the page just showed us that the board might already have. */
  async function askStatus(externalIds) {
    const response = await send({ type: 'cardStatus', externalIds: externalIds });
    if (!response.ok) {
      // "not signed in" is the normal case before the popup signs in; the buttons stay `Scrape`.
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

  /** Re-render every card whose vacancy the board now knows. */
  function renderKnown() {
    for (const card of Array.from(document.querySelectorAll(CARD_SELECTOR))) {
      const entry = known.get(externalIdOf(card));
      if (entry && entry.jobId && buttonFor(card)) {
        renderDone(card, entry.jobId, gateway, statusHint(entry));
      }
    }
  }

  /**
   * One click, one vacancy: select the card, let the pane catch up, then let the worker extract.
   *
   * The order is the whole point. Asking the worker first would read whichever vacancy the pane
   * happened to be showing, which is a different one - so a pane that never shows this card is an
   * error, never a scrape of the wrong job.
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

    if (!(await selectAndWait(externalId))) {
      // Say what the pane was doing instead: "still showing another vacancy" and "showing nothing"
      // are different problems, and the operator is the one who can see which one it is.
      const pane = document.querySelector(PANE_SELECTOR);
      log(
        'the pane never became ready',
        externalId,
        'pane=' + (paneId() || 'none'),
        'text=' + descriptionOf(pane).length,
      );
      renderError(
        cardFor(externalId) || card,
        'the right pane never showed this description (' +
          Math.round(deadlineMs() / 1000) +
          's) - click the card, wait for its text to appear, then retry',
      );
      return;
    }

    const response = await send({ type: 'scrapeCard', externalId: externalId });
    const target = cardFor(externalId) || card;
    if (!response.ok) {
      log('scrape failed for', externalId, response.error);
      renderError(target, response.error || 'scrape failed');
      return;
    }
    if (!response.jobId) {
      renderError(target, 'the gateway did not return a card id');
      return;
    }

    const entry = { jobId: response.jobId, status: 'submitted', archived: false };
    known.set(externalId, entry);
    if (response.gateway) gateway = response.gateway;
    renderKnown();
    log('queued', externalId, response.jobId, response.note || '');
  }

  /** Put a button on every card that does not have one yet. */
  function scan() {
    if (!alive()) {
      // The extension was reloaded/updated: this context can no longer talk to it.
      if (observer) observer.disconnect();
      return;
    }

    const unknown = [];
    for (const card of Array.from(document.querySelectorAll(CARD_SELECTOR))) {
      if (buttonFor(card)) continue;
      const externalId = externalIdOf(card);
      if (!externalId) continue;

      const button = makeButton();
      button.dataset.cvtExternalId = externalId;
      placeButton(card, button);

      const entry = known.get(externalId);
      if (entry && entry.jobId) renderDone(card, entry.jobId, gateway, statusHint(entry));
      else unknown.push(externalId);
    }

    if (unknown.length > 0) void askStatus(unknown);
  }

  /** Indeed swaps the feed in place (selecting a card re-renders it), so re-scan - debounced. */
  function schedule() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, RESCAN_DELAY_MS);
  }

  // Two callers talk to this page: the worker walking the whole feed (`indeedCards` / `indeedSelect`
  // - `indeed/sweep.js`), and `background.js` telling every tab that the board changed.
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message) return undefined;

      if (message.type === 'boardChanged') {
        void askStatus(cardIds());
        return undefined;
      }

      if (message.type === 'indeedCards') {
        sendResponse({ ok: true, ids: cardIds() });
        return undefined;
      }

      if (message.type === 'indeedSelect') {
        // Answer only once this card's pane is readable: the worker reads the pane immediately
        // afterwards, and an early answer is exactly how a card ends up filed under another
        // vacancy's description.
        const externalId = String(message.externalId || '').trim();
        void selectAndWait(externalId).then((ready) => sendResponse({ ok: true, ready: ready }));
        return true; // ...so this listener keeps the port open for it
      }

      return undefined;
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
