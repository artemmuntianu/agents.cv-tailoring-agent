import { mergePlan, neededDocuments, publicFields } from './plan.js';

/**
 * The service worker's half of the form filler: everything between "the operator clicked
 * Populate" and "the page has the values".
 *
 * It lives in its own module (not in `background.js`) because it is a complete flow - snapshot,
 * draft on the board, poll, fetch the two documents, apply - and `background.js` is already where
 * three other flows meet. Its extension-level helpers (`settings`, `cardStatus`, `sourceForUrl`)
 * are injected, so this file owns no global state.
 *
 * Two rules shape the flow:
 *
 * * the **snapshot hash** is the cache key. The board stores a plan per `(job_id, hash)`, so
 *   re-filling the same rendered form costs no Gemini call, while a changed form re-drafts.
 * * the generated **documents never leave the browser**: only the plan travels through the queue,
 *   and it only says which element the cover letter and the PDF belong in.
 */
const POLL_INTERVAL_MS = 2500;
const POLL_DEADLINE_MS = 120000;
const DEFAULT_GATEWAY = 'http://localhost:4321';

export function createFormWorker({ settings, cardStatus }) {
  function hostOf(url) {
    try {
      return new URL(String(url || '')).hostname.toLowerCase();
    } catch (error) {
      return '';
    }
  }

  /** The vacancy id in a job page's URL (`/jobs/850592-slug/`). */
  function externalIdFromUrl(url) {
    try {
      const match = new URL(String(url || '')).pathname.match(/\/jobs\/(\d+)/);
      return match ? match[1] : '';
    } catch (error) {
      return '';
    }
  }

  /** Talk to the page's form filler (`formfill.js`), a separate classic content script. */
  function formMessage(tabId, payload) {
    return new Promise((resolve) => {
      if (!tabId) {
        resolve({ ok: false, error: 'no active tab' });
        return;
      }
      try {
        chrome.tabs.sendMessage(tabId, { type: 'cvtForm', ...payload }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              error: 'this page cannot be filled (no form filler on it - reload the page)',
            });
            return;
          }
          resolve(response || { ok: false, error: 'the page did not answer' });
        });
      } catch (error) {
        resolve({ ok: false, error: 'the page could not be reached' });
      }
    });
  }

  async function recipes() {
    const stored = await chrome.storage.local.get(['formRecipes']);
    return stored.formRecipes && typeof stored.formRecipes === 'object' ? stored.formRecipes : {};
  }

  /**
   * Remember what the operator picked, per host.
   *
   * The root is the only thing the extension cannot guess - the two sites render the same idea in
   * completely different markup, and Djinni's form only appears after Apply - and the pins make the
   * fields that must be exactly right independent of the model.
   */
  async function storeFormPick(kind, picked, tabUrl) {
    const host = hostOf(tabUrl);
    if (!host) return { ok: false, error: 'this page has no host' };
    if (!picked || !picked.selector) return { ok: false, error: 'nothing was picked' };

    const all = await recipes();
    const recipe = all[host] || { root: null, pins: {}, updatedAt: null };
    if (kind === 'root') recipe.root = picked;
    else recipe.pins[kind] = picked.selector;
    recipe.updatedAt = new Date().toISOString();
    all[host] = recipe;
    await chrome.storage.local.set({ formRecipes: all });
    return { ok: true, recipes: recipe };
  }

  async function clearRecipe(tabUrl) {
    const host = hostOf(tabUrl);
    const all = await recipes();
    if (host && all[host]) {
      delete all[host];
      await chrome.storage.local.set({ formRecipes: all });
    }
    return { ok: true };
  }

  // -- authenticated gateway calls ------------------------------------------- //

  async function gatewayJson(path, options = {}) {
    const { gateway, token } = await settings();
    if (!token) return { ok: false, error: 'not signed in' };
    const response = await fetch(`${gateway || DEFAULT_GATEWAY}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    if (response.status === 401) {
      await chrome.storage.local.remove(['token', 'user']);
      return { ok: false, error: 'the session expired - sign in again' };
    }
    const body = await response
      .json()
      .catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok || body.ok === false) {
      return { ok: false, error: body.error || `HTTP ${response.status}` };
    }
    return { ok: true, body };
  }

  /** base64, because MV3 messages are JSON and a Blob could not cross that boundary. */
  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
  }

  async function fetchCoverLetter(jobId) {
    const result = await gatewayJson(`/api/cover/${encodeURIComponent(jobId)}`);
    if (!result.ok) return result;
    return {
      ok: true,
      text: result.body.text || '',
      status: result.body.status,
      error: result.body.error || '',
    };
  }

  async function fetchResumePdf(jobId) {
    const { gateway, token } = await settings();
    if (!token) return { ok: false, error: 'not signed in' };
    try {
      const response = await fetch(
        `${gateway || DEFAULT_GATEWAY}/api/artifacts/${encodeURIComponent(jobId)}?format=pdf`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        const reason = await response.text().catch(() => '');
        return { ok: false, error: reason || `HTTP ${response.status}` };
      }
      const disposition = response.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/i);
      return {
        ok: true,
        name: match ? match[1] : `${jobId}.pdf`,
        base64: toBase64(await response.arrayBuffer()),
      };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Poll until the draft for *this snapshot* is answered, or the deadline passes. */
  async function waitForPlan(jobId, schemaHash) {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      const result = await gatewayJson(
        `/api/apply/${encodeURIComponent(jobId)}?schema=${encodeURIComponent(schemaHash)}`,
      );
      if (!result.ok) return result;
      const body = result.body;
      if (body.status === 'completed' && body.plan) return { ok: true, body };
      if (body.status === 'failed') {
        return { ok: false, error: body.error || 'the draft failed on the board' };
      }
      if (body.status === 'stale') {
        return {
          ok: false,
          error: 'the form changed while the draft was being written - run Populate again',
        };
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return { ok: false, error: 'the draft is taking longer than expected - check the board' };
  }

  /**
   * The whole Populate flow. It returns the page's own report (what was written, what was left),
   * plus where it came from: the card, the snapshot hash and the draft's status.
   */
  async function populate(tabId) {
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const url = (tab && tab.url) || '';
    const host = hostOf(url);
    if (!host) return { ok: false, error: 'no active tab' };

    const recipe = (await recipes())[host];
    if (!recipe || !recipe.root || !recipe.root.selector) {
      return {
        ok: false,
        error: 'the form has not been picked on this site yet - use "Pick the form" first',
      };
    }

    const snapshot = await formMessage(tabId, {
      action: 'snapshot',
      root: recipe.root.selector,
      pins: recipe.pins || {},
    });
    if (!snapshot.ok) return snapshot;
    if (!snapshot.fields || snapshot.fields.length === 0) {
      return { ok: false, error: 'the picked element has no fillable fields in it' };
    }

    const externalId = externalIdFromUrl(url);
    if (!externalId) {
      return {
        ok: false,
        error: 'this page has no vacancy id in its URL - open the vacancy itself',
      };
    }
    const status = await cardStatus({ externalIds: [externalId] }, url);
    const known = status.ok && status.known ? status.known[externalId] : null;
    const jobId = known && known.jobId;
    if (!jobId) {
      return {
        ok: false,
        error: 'this vacancy is not on the board yet - scrape it and tailor it first',
      };
    }

    const started = await gatewayJson(`/api/apply/${encodeURIComponent(jobId)}`, {
      method: 'POST',
      body: JSON.stringify({
        url,
        host,
        form: { root: snapshot.root, html: snapshot.html, fields: publicFields(snapshot.fields) },
      }),
    });
    if (!started.ok) return started;
    const schemaHash = started.body.schemaHash;

    const planned = await waitForPlan(jobId, schemaHash);
    if (!planned.ok) return planned;
    const plan = planned.body.plan || { fields: [] };
    const pins = recipe.pins || {};

    const need = neededDocuments(plan.fields || [], pins);
    const cover = need.cover ? await fetchCoverLetter(jobId) : null;
    const file = need.file ? await fetchResumePdf(jobId) : null;

    const applied = await formMessage(tabId, {
      action: 'apply',
      instructions: {
        root: recipe.root.selector,
        host,
        pins,
        note: plan.note || '',
        fields: mergePlan(snapshot.fields, plan.fields || [], pins),
        cover: cover && cover.ok ? { text: cover.text } : null,
        file: file && file.ok ? { name: file.name, base64: file.base64 } : null,
      },
    });
    if (!applied.ok) return applied;

    return {
      ...applied,
      ok: true,
      jobId,
      schemaHash,
      planStatus: planned.body.status,
      coverStatus: cover ? (cover.ok ? cover.status : 'unavailable') : 'not needed',
      fileStatus: file ? (file.ok ? file.name : 'unavailable') : 'not needed',
      planBits: {
        decided: (plan.fields || []).length,
        undecided: (plan.undecided || []).length,
        model: planned.body.model || '',
      },
    };
  }

  /** The candidate facts, edited from the popup - the same document the worker reads. */
  async function profileGet() {
    const result = await gatewayJson('/api/profile');
    return result.ok ? { ok: true, ...result.body } : result;
  }

  async function profilePut(profile) {
    const result = await gatewayJson('/api/profile', {
      method: 'PUT',
      body: JSON.stringify(profile || {}),
    });
    return result.ok ? { ok: true, ...result.body } : result;
  }

  return {
    populate,
    storeFormPick,
    recipes,
    clearRecipe,
    hostOf,
    formMessage,
    externalIdFromUrl,
    profileGet,
    profilePut,
  };
}
