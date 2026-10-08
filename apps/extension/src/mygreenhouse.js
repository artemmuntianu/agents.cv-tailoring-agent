/**
 * Badge injector for my.greenhouse.io — the Greenhouse job-seeker portal
 * (https://my.greenhouse.io/jobs/search?…).
 *
 * This page is rendered client-side (Inertia/React), so tiles appear after the initial HTML
 * loads. A MutationObserver re-scans on every DOM change, mirroring the debounce strategy
 * used by `inject.js` for Djinni/DOU.
 *
 * DOM contract (verified against the live page 2026-10-08):
 *   div[data-provides="search-result"]   each job tile
 *   a[href]                              the first anchor inside the tile whose href matches
 *                                        /jobs/<board>/<numeric-id>; that number is the board job
 *                                        id, i.e. the `external_id` a board scrape stores
 *
 * The badge is an absolutely-positioned pill at the bottom-left of each tile. It reports
 * `Scraped` (green) when the backend knows this job id under source "greenhouse", or
 * `Not Scraped` (grey) otherwise. The position is deliberately separate from the site's own
 * bell-button (`absolute right-6 top-5`), which we must not touch.
 *
 * The status question carries an **explicit `source`** (`SOURCE` below): this host is deliberately
 * not one the `greenhouse` plugin claims (those are the three boards an operator scrapes and fills
 * on), so the host-derived slug `background.js::cardStatus` uses by default would be `other` and
 * every badge would be grey. The constant is pinned to the registry by a test.
 *
 * This script is a **classic content script** (no `import`/`export`). Every network call goes
 * through the service worker via `chrome.runtime.sendMessage`, because a `fetch` from a
 * content script is judged by the page's own CORS rules — same reason as `inject.js`.
 */
(() => {
  'use strict';

  const TILE_SELECTOR   = 'div[data-provides="search-result"]';
  const JOB_ID_RE       = /\/jobs\/[^/]+\/(\d+)/;
  const BADGE_ATTR      = 'data-cvt-badge';
  const RESCAN_DELAY_MS = 250;
  /**
   * The `resumes.source` the vacancies this page lists are stored under. The portal lists *board*
   * jobs, so the badge has to ask about that slug rather than about this page's own host - see the
   * header. `mygreenhouse.test.ts` asserts it resolves through `siteForSlug`, so a renamed slug
   * fails the suite instead of silently greying every badge.
   */
  const SOURCE          = 'greenhouse';

  /** job-id (string) -> true | false; absent while the query is in flight. */
  const statusCache = new Map();
  let scanTimer = null;
  let observer  = null;
  let scanning  = false;

  const log = (...args) => console.info('[cv-tailoring/mygreenhouse]', ...args);

  // --------------------------------------------------------------------------
  // Extension liveness (same guard as inject.js)
  // --------------------------------------------------------------------------
  function alive() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function send(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          resolve(response || { ok: false, error: 'no response from the extension' });
        });
      } catch (error) {
        resolve({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    });
  }

  // --------------------------------------------------------------------------
  // ID extraction
  // --------------------------------------------------------------------------
  function jobIdOf(tile) {
    // The *first matching* anchor, not simply the first one: a tile may lead with its company logo
    // (a `/companies/...` link), and giving up on that anchor would leave the tile un-badged.
    for (const link of Array.from(tile.querySelectorAll('a[href]'))) {
      const m = (link.getAttribute('href') || '').match(JOB_ID_RE);
      if (m) return m[1];
    }
    return '';
  }

  // --------------------------------------------------------------------------
  // Badge rendering
  // --------------------------------------------------------------------------
  const BADGE_STYLES = `
    .cvt-gh-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 9px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
      white-space: nowrap;
      pointer-events: none;
      position: absolute;
      bottom: 14px;
      left: 16px;
      z-index: 10;
    }
    .cvt-gh-badge--scraped {
      background: #d1fae5;
      color: #065f46;
      border: 1px solid #6ee7b7;
    }
    .cvt-gh-badge--not-scraped {
      background: #f3f4f6;
      color: #6b7280;
      border: 1px solid #d1d5db;
    }
    .cvt-gh-badge__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .cvt-gh-badge--scraped .cvt-gh-badge__dot     { background: #10b981; }
    .cvt-gh-badge--not-scraped .cvt-gh-badge__dot { background: #9ca3af; }
  `;

  function injectStyles() {
    if (document.getElementById('cvt-gh-badge-styles')) return;
    const style = document.createElement('style');
    style.id = 'cvt-gh-badge-styles';
    style.textContent = BADGE_STYLES;
    (document.head || document.documentElement).appendChild(style);
  }

  function renderBadge(tile, scraped) {
    let badge = tile.querySelector('[' + BADGE_ATTR + ']');
    if (!badge) {
      badge = document.createElement('span');
      badge.setAttribute(BADGE_ATTR, '');
      const dot   = document.createElement('span');
      dot.className = 'cvt-gh-badge__dot';
      const label = document.createElement('span');
      badge.appendChild(dot);
      badge.appendChild(label);
      // The tile itself has `position: relative` (class="relative …"), so this
      // absolute child lands inside it correctly.
      tile.appendChild(badge);
    }
    const label = badge.querySelector('span:last-child');
    if (scraped) {
      badge.className = 'cvt-gh-badge cvt-gh-badge--scraped';
      if (label) label.textContent = 'Scraped';
    } else {
      badge.className = 'cvt-gh-badge cvt-gh-badge--not-scraped';
      if (label) label.textContent = 'Not Scraped';
    }
  }

  // --------------------------------------------------------------------------
  // Status lookup (mirrors inject.js's askStatus)
  // --------------------------------------------------------------------------
  async function askStatus(externalIds) {
    // `source` is explicit: see SOURCE above - the portal's host is not a claimed board host, so the
    // worker would otherwise ask about the `other` id space and answer "not scraped" for everything.
    const response = await send({ type: 'cardStatus', externalIds, source: SOURCE });
    if (!response.ok) {
      if (response.error !== 'not signed in') log('status lookup failed', response.error);
      // Mark all as not-scraped so the badges still appear rather than staying blank.
      for (const id of externalIds) {
        if (!statusCache.has(id)) statusCache.set(id, false);
      }
      return;
    }

    const known = response.known || {};
    for (const id of externalIds) {
      statusCache.set(id, Boolean(known[id] && known[id].jobId));
    }
  }

  // --------------------------------------------------------------------------
  // Scan: stamp every tile that does not yet have a badge
  // --------------------------------------------------------------------------
  async function scan() {
    if (!alive()) {
      if (observer) observer.disconnect();
      return;
    }
    // Stamping a badge mutates the tile, which schedules another scan; two overlapping scans would
    // each query for the ids the other is already asking about. One at a time - the later scan finds
    // the answers in `statusCache`.
    if (scanning) return;
    scanning = true;

    try {
      injectStyles();

      const tiles   = Array.from(document.querySelectorAll(TILE_SELECTOR));
      const pending = [];

      for (const tile of tiles) {
        const id = jobIdOf(tile);
        if (!id) continue;

        if (statusCache.has(id)) {
          renderBadge(tile, statusCache.get(id));
        } else if (!pending.includes(id)) {
          pending.push(id);
        }
      }

      if (pending.length > 0) {
        await askStatus(pending);
        // Re-render now that we have answers.
        for (const tile of Array.from(document.querySelectorAll(TILE_SELECTOR))) {
          const id = jobIdOf(tile);
          if (id && statusCache.has(id)) renderBadge(tile, statusCache.get(id));
        }
      }
    } finally {
      scanning = false;
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, RESCAN_DELAY_MS);
  }

  // --------------------------------------------------------------------------
  // Bootstrap
  // --------------------------------------------------------------------------

  // The popup queues a whole page at once; pick that up so badges stay in sync.
  try {
    chrome.runtime.onMessage.addListener(message => {
      if (message && message.type === 'boardChanged') {
        statusCache.clear();   // invalidate; next scan re-queries
        scheduleScan();
      }
    });
  } catch (_) {
    // No listener in this context; badges still reflect the state at load.
  }

  scheduleScan();

  // Inertia replaces the tile list on filter/pagination changes; re-scan on mutations.
  const root = document.body || document.documentElement;
  if (root) {
    observer = new MutationObserver(scheduleScan);
    observer.observe(root, { childList: true, subtree: true });
  }
})();
