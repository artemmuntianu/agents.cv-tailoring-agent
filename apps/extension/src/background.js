/**
 * MV3 service worker - the extension's only network client.
 *
 * The popup closes as soon as it loses focus, so the fetch must not live there: the
 * popup scrapes, sends the payload here, and this worker performs the authenticated
 * POST and keeps the session token in `chrome.storage.local`.
 *
 * The injected per-card buttons (`src/inject.js`) use the same two helpers, plus
 * `scrapeCard`, which re-uses `extractVacancies` from here instead of carrying a second copy
 * of the DOM contract.
 */
import { extractVacancies } from './extract.js';
import { createFormWorker } from './form/worker.js';
import { createSweepWorker } from './indeed/sweep.js';
import { boardKeyForUrl, siteForPage, siteForUrl, vacancyIdFromUrl } from './sites/index.js';

const DEFAULT_GATEWAY = 'http://localhost:4321';

/**
 * The form-filler flow lives in `form/worker.js`; it borrows this worker's helpers, so both halves of
 * the extension agree on the session, on how a page matches a board card, and on the two registry
 * facts a page carries: which part of its URL is its vacancy id, and which **job board** it belongs
 * to (the key a picked form is remembered under - `sites/<site>.js`, never a rule in the flow).
 */
const formWorker = createFormWorker({
  settings,
  cardStatus,
  cardForUrl,
  vacancyIdFromUrl,
  boardKeyForUrl,
});
/**
 * "Queue every vacancy on this Indeed feed" is its own flow, like the form filler:
 * `indeed/sweep.js` walks the page's cards through the content script and publishes the result. It is
 * handed `publish` so the token and the gateway stay this file's business, and `knownIds` so it can
 * leave alone the cards the board already has.
 */
const sweepWorker = createSweepWorker({
  publish,
  /**
   * Which of these vacancies the board already has. The sweep skips them - the same rule a per-card
   * button follows on a `Scraped` card - because selecting one would flicker the feed through a
   * vacancy nobody needs and publishing it would only return as a duplicate.
   *
   * A lookup that fails is "we know nothing" (`new Set()`), so a board that is down degrades the walk
   * to visiting everything instead of refusing to run; the publish that follows reports the real
   * problem.
   */
  knownIds: async (externalIds, tabUrl) => {
    try {
      const status = await cardStatus({ externalIds: externalIds }, tabUrl);
      if (!status || !status.ok) return new Set();
      return new Set(Object.keys(status.known || {}));
    } catch (error) {
      // The store or the network refused: walk everything and let the publish report the real
      // problem, rather than turning a failed *lookup* into a failed sweep.
      return new Set();
    }
  },
});
const POLL_INTERVAL_MS = 2500;
const POLL_DEADLINE_MS = 120000;

/**
 * The site slug the gateway stores as `resumes.source` (part of the worker's business key: two sites
 * number their vacancies independently, so the number alone is ambiguous).
 *
 * Which slug, and which strategy a page is read with, is the **registry's** decision (`sites/index.js`)
 * - one plugin owns a host, its slug and its readers. This asks the lenient question on purpose: an
 * unlisted host still gets a stable slug (`other`), so scraping a site nobody has written a plugin for
 * never files it under a site that has one.
 */
function sourceForUrl(url) {
  return siteForPage(url).slug;
}

async function settings() {
  const stored = await chrome.storage.local.get(['gateway', 'token', 'user']);
  return {
    gateway: String(stored.gateway || DEFAULT_GATEWAY).replace(/\/+$/, ''),
    token: stored.token || '',
    user: stored.user || '',
  };
}

async function signIn(message) {
  const gateway = String(message.gateway || DEFAULT_GATEWAY).replace(/\/+$/, '');
  const response = await fetch(`${gateway}/api/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: message.email, password: message.password }),
  });
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || !body.ok) return { ok: false, error: body.error || `HTTP ${response.status}` };

  await chrome.storage.local.set({ gateway: gateway, token: body.token, user: body.user });
  return { ok: true, gateway: gateway, user: body.user };
}

async function publish(payload, tabUrl) {
  const { gateway, token } = await settings();
  if (!token) return { ok: false, error: 'not signed in' };

  const response = await fetch(`${gateway}/api/vacancies/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    // The site is a property of the *page*, not of a card: one request, one source.
    body: JSON.stringify({ ...payload, source: sourceForUrl(tabUrl) }),
  });
  const body = await response
    .json()
    .catch(() => ({ ok: false, error: `HTTP ${response.status}` }));

  // A stale token is a normal case (8h TTL): forget it so the popup asks again.
  if (response.status === 401) await chrome.storage.local.remove(['token', 'user']);
  return body;
}

/**
 * "Is this vacancy already on the board?" for the injected per-card buttons. One request for
 * the whole page (the content script sends every id it found), and the answer carries the
 * `jobId` the `Scraped` link points at.
 */
async function cardStatus(message, tabUrl) {
  const { gateway, token } = await settings();
  if (!token) return { ok: false, error: 'not signed in' };

  const ids = (Array.isArray(message.externalIds) ? message.externalIds : [])
    .map((id) => String(id).trim())
    .filter(Boolean);
  if (ids.length === 0) return { ok: false, error: 'externalIds is required' };

  // The lookup is per site: "do I already have DOU 374708?" is a different question from
  // "do I already have djinni 374708?".
  //
  // A caller may name the source itself, and the MyGreenhouse badge does: its page lists *board*
  // jobs but its own host is not one the registry claims, so the host-derived answer would be
  // `other` and no badge would ever be green. Everything else omits `source` and keeps asking by
  // host, exactly as before.
  const source = String(message.source || '').trim() || sourceForUrl(tabUrl);
  const response = await fetch(
    `${gateway}/api/vacancies/status?external_ids=${encodeURIComponent(ids.join(','))}` +
      `&source=${encodeURIComponent(source)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = await response
    .json()
    .catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (response.status === 401) await chrome.storage.local.remove(['token', 'user']);
  return { ...body, gateway };
}

/**
 * "Which card is this page?" - asked by the form filler with the URL of the page it is standing
 * on, and answered from the cards' own application URLs (`resume_board.apply_url`).
 *
 * The per-card lookup above cannot answer this one: a DOU or Djinni card whose Apply button opens
 * the employer's ATS posting keeps `source`/`external_id` of the *site it was scraped from*, so
 * nothing on that board is keyed on the ATS vacancy number. `null` is a normal answer - it means
 * no card has been linked to this page yet.
 */
async function cardForUrl(pageUrl) {
  const { gateway, token } = await settings();
  if (!token) return { ok: false, error: 'not signed in' };

  const wanted = String(pageUrl || '').trim();
  if (!wanted) return { ok: false, error: 'no page url' };

  const response = await fetch(
    `${gateway}/api/vacancies/link?url=${encodeURIComponent(wanted)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = await response
    .json()
    .catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (response.status === 401) await chrome.storage.local.remove(['token', 'user']);
  return { ...body, gateway };
}

/**
 * Scrape one card, on the button's click.
 *
 * The extraction stays in `extract.js` - the single source of truth the popup also uses - by
 * *injecting* it into the tab the button was clicked in and picking the card out of the
 * result. That keeps the content script free of a second copy of the DOM contract.
 */
async function scrapeCard(message, tabId, tabUrl) {
  if (!tabId) return { ok: false, error: 'no tab to scrape' };

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: extractVacancies,
    // `null` root = the tab's document; the cap is the page size, not the batch size. The plan is the
    // *strategy* this page is read with, chosen by host - the injected function cannot see the
    // registry, so the worker hands it over (`sites/index.js`).
    args: [null, { max: 200, plan: siteForPage(tabUrl).plan }],
  });
  const result = (injection && injection.result) || { vacancies: [] };
  const wanted = String(message.externalId || '').trim();
  const vacancy = (result.vacancies || []).find((item) => item.external_id === wanted);
  if (!vacancy) {
    // An Indeed page reads as "recognised but nothing to read" while its pane is still filling, and
    // that is a different problem from a card that has disappeared - say which one it was.
    if (result.mode === 'pane') {
      return {
        ok: false,
        error:
          'Indeed is still filling the right pane for this vacancy - wait for its description, then retry',
      };
    }
    return { ok: false, error: 'that card is not on this page any more - reload and retry' };
  }

  const published = await publish({ vacancies: [vacancy] }, tabUrl);
  if (!published.ok) return published;

  // Newly queued: the endpoint answers with the job id. Already known (a race with another
  // tab, or a card that was scraped between the lookup and the click): ask again.
  let jobId = Array.isArray(published.jobIds) ? published.jobIds[0] : '';
  if (!jobId) {
    const status = await cardStatus({ externalIds: [wanted] }, tabUrl);
    jobId = (status.known && status.known[wanted] && status.known[wanted].jobId) || '';
  }
  const { gateway } = await settings();
  return { ...published, jobId: jobId, gateway: gateway };
}

/**
 * "Queue every vacancy on this Indeed feed."
 *
 * The *worker* walks the page - the popup closes the moment it loses focus, and a dozen cards take
 * tens of seconds - so this only starts the walk; the popup then polls `{ type: 'scrapeProgress' }`.
 * A page whose content script does not answer is not an Indeed feed at all, and the popup falls back
 * to its one-shot card read.
 */
async function scrapePage(tabId, tabUrl) {
  if (!tabId) return { ok: false, notPage: true };

  // Only a strategy that needs a walk has one (`sweep: true` - Indeed, today); every other site is the
  // popup's one-shot read, and this never even asks the tab.
  const site = siteForUrl(tabUrl);
  if (!site || !site.sweep) return { ok: false, notPage: true };

  const ids = await sweepWorker.cardIds(tabId);
  if (!ids || ids.length === 0) return { ok: false, notPage: true };

  if (!sweepWorker.progress().running) {
    void sweepWorker.run(tabId, tabUrl).then((result) => {
      // The page's own buttons agree with the sweep once it is done, exactly as they do after a
      // batch publish.
      if (result && result.ok && result.created > 0) void notifyTabs();
    });
  }
  // Already walking? The popup should follow that one rather than start a second.
  return { ok: true, total: ids.length };
}

/**
 * Tell any open listing page that the board changed, so the injected per-card buttons stop
 * offering `Scrape` for a vacancy the popup just queued in bulk. Best-effort: a tab without
 * the content script (an older page, another site) rejects, which is not an error.
 */
/** The active tab's URL, for messages that arrive without a sender tab (the popup). */
/**
 * The tab the popup is acting on.
 *
 * The picker and the fill need the *active* tab, and a popup message carries no `sender.tab` (only
 * a message from a page does), so it has to be looked up. `activeTabUrl()` below answers the
 * narrower "which URL?" question the card-status lookup asks.
 */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return (tab && tab.url) || '';
  } catch {
    return '';
  }
}

async function notifyTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'boardChanged' }).catch(() => {});
    }
  } catch {
    // Losing the notification only means a stale button until the next reload.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // The content script's tab, or the popup's active tab: both carry the page URL that
      // decides the site slug.
      const tabUrl = (sender && sender.tab && sender.tab.url) || (await activeTabUrl());
      if (message && message.type === 'status') {
        sendResponse({ ok: true, ...(await settings()) });
      } else if (message && message.type === 'signIn') {
        sendResponse(await signIn(message));
      } else if (message && message.type === 'signOut') {
        await chrome.storage.local.remove(['token', 'user']);
        sendResponse({ ok: true });
      } else if (message && message.type === 'publish') {
        const result = await publish(message.payload, tabUrl);
        if (result && result.ok && result.created > 0) await notifyTabs();
        sendResponse(result);
      } else if (message && message.type === 'storeFormPick') {
        // The page's form filler picked something: remember it per host.
        sendResponse(await formWorker.storeFormPick(message.kind, message.picked, tabUrl));
      } else if (message && message.type === 'phase') {
        // The popup's ticker while a fill runs: one step, and how long the run has taken.
        sendResponse({ ok: true, phase: formWorker.phase() });
      } else if (message && message.type === 'formRecipe') {
        // This host's own pick, else its job board's saved default (`source` says which).
        sendResponse({ ok: true, ...(await formWorker.recipeFor(tabUrl)) });
      } else if (message && message.type === 'saveFormDefaults') {
        // The popup's *Save as default*: copy this host's pick to the whole job board.
        sendResponse(await formWorker.saveFormDefaults(tabUrl));
      } else if (message && message.type === 'clearFormRecipe') {
        sendResponse(await formWorker.clearRecipe(tabUrl));
      } else if (message && message.type === 'pickForm') {
        const tab = await activeTab();
        sendResponse(
          await formWorker.formMessage(tab && tab.id, {
            action: 'pick',
            kind: message.kind || 'root',
          }),
        );
      } else if (message && message.type === 'populate') {
        const tab = await activeTab();
        sendResponse(await formWorker.populate(tab && tab.id));
      } else if (message && message.type === 'cardStatus') {
        sendResponse(await cardStatus(message, tabUrl));
      } else if (message && message.type === 'scrapeCard') {
        const tabId = sender && sender.tab ? sender.tab.id : null;
        sendResponse(await scrapeCard(message, tabId, tabUrl));
      } else if (message && message.type === 'scrapePage') {
        const tab = await activeTab();
        sendResponse(await scrapePage(tab && tab.id, tabUrl));
      } else if (message && message.type === 'scrapeProgress') {
        sendResponse({ ok: true, progress: sweepWorker.progress() });
      } else {
        sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
    }
  })();
  return true; // async response
});
