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

const DEFAULT_GATEWAY = 'http://localhost:4321';

/**
 * The form-filler flow lives in `form/worker.js`; it borrows this worker's two helpers, so both
 * halves of the extension agree on the session and on how a page matches a board card.
 */
const formWorker = createFormWorker({ settings, cardStatus });
const POLL_INTERVAL_MS = 2500;
const POLL_DEADLINE_MS = 120000;

/**
 * The site slug the gateway stores as `resumes.source` (part of the worker's business key:
 * two sites number their vacancies independently, so the number alone is ambiguous).
 *
 * Derived from the page's own URL rather than hardcoded to Djinni: the same DOM contract may
 * hold on another listing site, and an unknown host must still produce a *stable* slug - the
 * id space of an unknown site is simply its own.
 */
function sourceForUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    if (host === 'djinni.co' || host.endsWith('.djinni.co')) return 'djinni';
    if (host === 'dou.ua' || host.endsWith('.dou.ua')) return 'dou';
    return 'other';
  } catch {
    return 'other';
  }
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
  const source = sourceForUrl(tabUrl);
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
    // `null` root = the tab's document; the cap is the page size, not the batch size.
    args: [null, { max: 200 }],
  });
  const result = (injection && injection.result) || { vacancies: [] };
  const wanted = String(message.externalId || '').trim();
  const vacancy = (result.vacancies || []).find((item) => item.external_id === wanted);
  if (!vacancy) {
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
 * Tell any open listing page that the board changed, so the injected per-card buttons stop
 * offering `Scrape` for a vacancy the popup just queued in bulk. Best-effort: a tab without
 * the content script (an older page, another site) rejects, which is not an error.
 */
/** The active tab's URL, for messages that arrive without a sender tab (the popup). */
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
      } else if (message && message.type === 'formRecipe') {
        const all = await formWorker.recipes();
        sendResponse({ ok: true, recipe: all[formWorker.hostOf(tabUrl)] || null });
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
      } else if (message && message.type === 'profileGet') {
        sendResponse(await formWorker.profileGet());
      } else if (message && message.type === 'profilePut') {
        sendResponse(await formWorker.profilePut(message.profile));
      } else if (message && message.type === 'cardStatus') {
        sendResponse(await cardStatus(message, tabUrl));
      } else if (message && message.type === 'scrapeCard') {
        const tabId = sender && sender.tab ? sender.tab.id : null;
        sendResponse(await scrapeCard(message, tabId, tabUrl));
      } else {
        sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
    }
  })();
  return true; // async response
});
