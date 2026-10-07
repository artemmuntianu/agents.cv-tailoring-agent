import { mergePlan, neededDocuments, publicFields } from './plan.js';

/**
 * The service worker's half of the form filler: everything between "the operator clicked
 * Populate" and "the page has the values".
 *
 * It lives in its own module (not in `background.js`) because it is a complete flow - snapshot,
 * draft on the board, poll, fetch the two documents, apply - and `background.js` is already where
 * three other flows meet. Its extension-level helpers (`settings`, `cardStatus`, `cardForUrl`)
 * are injected, so this file owns no global state.
 *
 * Three rules shape the flow:
 *
 * * the **card is resolved twice, in order**. The id the page's own URL carries answers "was this
 *   vacancy scraped from this site?" - read by the page's *site* (`vacancyIdFromUrl`, injected from
 *   `sites/index.js`), so Djinni's `/jobs/<id>` and DOU's `/vacancies/<id>` both count. When that
 *   fails the page URL is matched against the cards' application URLs, which is the only way to
 *   reach a card whose Apply button opened the employer's own ATS form. Neither match means the page
 *   belongs to no card, and the flow stops rather than filling a form from a guess.
 * * the **snapshot hash** is the cache key. The board stores a plan per `(job_id, hash)`, so
 *   re-filling the same rendered form costs no Gemini call, while a changed form re-drafts.
 * * the generated **documents never leave the browser**: only the plan travels through the queue,
 *   and it only says which element the cover letter and the PDF belong in.
 */
const POLL_INTERVAL_MS = 2500;
const POLL_DEADLINE_MS = 120000;
const DEFAULT_GATEWAY = 'http://localhost:4321';

export function createFormWorker({
  settings,
  cardStatus,
  cardForUrl,
  vacancyIdFromUrl,
  boardKeyForUrl,
}) {
  // -- progress --------------------------------------------------------------- //

  /**
   * Where the current run is. The popup polls this through `background.js`
   * (`{ type: 'phase' }`), because one click covers a KEDA cold start, a Gemini call and two
   * document fetches - and one frozen label for a minute is indistinguishable from a hang.
   */
  let phase = { step: 'idle', startedAt: 0, at: 0, status: '', error: '' };

  function setPhase(step, extra = {}) {
    phase = { ...phase, ...extra, step, at: Date.now() };
  }

  function beginRun() {
    phase = { step: 'snapshot', startedAt: Date.now(), at: Date.now(), status: '', error: '' };
  }

  function endRun(result) {
    const ok = Boolean(result && result.ok);
    setPhase(ok ? 'done' : 'failed', {
      status: '',
      error: ok ? '' : (result && result.error) || '',
    });
    return result;
  }

  function hostOf(url) {
    try {
      return new URL(String(url || '')).hostname.toLowerCase();
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

  /** The job board a page belongs to - the registry's answer, or the host when we cannot ask. */
  function boardKeyOf(url) {
    return boardKeyForUrl ? boardKeyForUrl(url) : hostOf(url);
  }

  /** Both stores in one read: the per-host picks and the per-board defaults. */
  async function formRecipes() {
    const stored = await chrome.storage.local.get(['formRecipes', 'formDefaults']);
    return {
      hosts: stored.formRecipes && typeof stored.formRecipes === 'object' ? stored.formRecipes : {},
      boards:
        stored.formDefaults && typeof stored.formDefaults === 'object' ? stored.formDefaults : {},
    };
  }

  /**
   * The recipe a page is filled with: **this host's own pick**, else its **job board's default**.
   *
   * The pick is per host because a board's hosts *usually* render one form and the ones that do not
   * must still be able to differ; `saveFormDefaults` is how the operator says "these are the same"
   * once, instead of picking on every host of the board. `source` says which of the two answered, so
   * the popup can show a stale host pick still overriding a saved default.
   */
  async function recipeFor(tabUrl) {
    const host = hostOf(tabUrl);
    if (!host) return { recipe: null, source: '' };
    const { hosts, boards } = await formRecipes();
    if (hosts[host]) return { recipe: hosts[host], source: 'host' };
    const key = boardKeyOf(tabUrl);
    if (key && boards[key]) return { recipe: boards[key], source: 'board' };
    return { recipe: null, source: '' };
  }

  /**
   * Remember what the operator picked, per **host**.
   *
   * The root is the only thing the extension cannot guess - the two sites render the same idea in
   * completely different markup, and Djinni's form only appears after Apply - and the pins make the
   * fields that must be exactly right independent of the model. A pick here overrides the board
   * default for this host only; *Save as default* is what widens it.
   */
  async function storeFormPick(kind, picked, tabUrl) {
    const host = hostOf(tabUrl);
    if (!host) return { ok: false, error: 'this page has no host' };
    if (!picked || !picked.selector) return { ok: false, error: 'nothing was picked' };

    const { hosts } = await formRecipes();
    const recipe = hosts[host] || { root: null, pins: {}, updatedAt: null };
    if (kind === 'root') recipe.root = picked;
    else recipe.pins[kind] = picked.selector;
    recipe.updatedAt = new Date().toISOString();
    hosts[host] = recipe;
    await chrome.storage.local.set({ formRecipes: hosts });
    return { ok: true, recipe };
  }

  /**
   * Save this page's pick as its **job board's default** - the popup's *Save as default* button.
   *
   * A copy, not a guess: it takes the recipe this host already holds (the root and the two pins) and
   * stores it under the board's key, so the board's other hosts - and any host nobody has picked on
   * yet - are filled with the same selectors. It refuses when this host has nothing picked, and a
   * later pick on one host still wins for that host (`recipeFor` asks the host first).
   */
  async function saveFormDefaults(tabUrl) {
    const host = hostOf(tabUrl);
    if (!host) return { ok: false, error: 'this page has no host' };
    const key = boardKeyOf(tabUrl);
    if (!key) return { ok: false, error: 'this page has no job board' };

    const { hosts, boards } = await formRecipes();
    const recipe = hosts[host];
    if (!recipe || !recipe.root || !recipe.root.selector) {
      return { ok: false, error: 'nothing picked on this page yet - pick the form first' };
    }

    boards[key] = { ...recipe, updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ formDefaults: boards });
    return { ok: true, board: key, recipe: boards[key] };
  }

  /** Forget this host's pick *and* the board default it may have saved. */
  async function clearRecipe(tabUrl) {
    const {hosts, boards} = await formRecipes();
    const host = hostOf(tabUrl);
    const key = boardKeyOf(tabUrl);
    if (host && hosts[host]) delete hosts[host];
    if (key && boards[key]) delete boards[key];
    await chrome.storage.local.set({ formRecipes: hosts, formDefaults: boards });
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
      setPhase('drafting', { status: body.status });
      await sleep(POLL_INTERVAL_MS);
    }
    return { ok: false, error: 'the draft is taking longer than expected - check the board' };
  }

  /**
   * One Populate click: the flow below, plus the progress record the popup ticks through.
   *
   * A throw is turned into the `{ ok: false, error }` shape the popup already handles, so a crash
   * is *reported* - and the phase ends as `failed` - instead of leaving the ticker mid-step.
   */
  async function populate(tabId) {
    beginRun();
    try {
      return endRun(await runPopulate(tabId));
    } catch (error) {
      return endRun({ ok: false, error: error && error.message ? error.message : String(error) });
    }
  }

  /**
   * The whole Populate flow. It returns the page's own report (what was written, what was left),
   * plus where it came from: the card, the snapshot hash and the draft's status.
   */
  async function runPopulate(tabId) {
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const url = (tab && tab.url) || '';
    const host = hostOf(url);
    if (!host) return { ok: false, error: 'no active tab' };

    const { recipe } = await recipeFor(url);
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

    setPhase('board');
    // Two ways to the same card, in this order: the id the page's own URL carries, read by its
    // *site* (Djinni `/jobs/<id>`, DOU `/vacancies/<id>`, ...) - "was this vacancy scraped from
    // this site?" - or the page URL against the cards' application URLs, the only way to reach a
    // card whose Apply button opened the employer's own ATS form.
    const externalId = vacancyIdFromUrl ? vacancyIdFromUrl(url) : '';
    let jobId = '';
    let linkedBy = '';
    if (externalId) {
      const status = await cardStatus({ externalIds: [externalId] }, url);
      const known = status.ok && status.known ? status.known[externalId] : null;
      jobId = (known && known.jobId) || '';
      if (jobId) linkedBy = 'id';
    }
    if (!jobId) {
      const link = await cardForUrl(url);
      const card = link.ok && link.card ? link.card : null;
      if (card && card.jobId) {
        jobId = card.jobId;
        linkedBy = 'url';
      }
    }
    if (!jobId) {
      return {
        ok: false,
        error:
          'this page is not linked to a card yet - open the vacancy on the board and put this ' +
          "page's URL in its Application URL field",
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

    setPhase('drafting', { status: started.body.status || 'none' });
    const planned = await waitForPlan(jobId, schemaHash);
    if (!planned.ok) return planned;
    const plan = planned.body.plan || { fields: [] };
    const pins = recipe.pins || {};

    setPhase('documents');
    const need = neededDocuments(plan.fields || [], pins);
    const cover = need.cover ? await fetchCoverLetter(jobId) : null;
    const file = need.file ? await fetchResumePdf(jobId) : null;

    setPhase('applying');
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
      // Which lookup answered: the page's own vacancy id, or the card's application URL.
      linkedBy,
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

  return {
    populate,
    /** The popup's ticker: which step the flow is in, and since when. */
    phase: () => ({ ...phase }),
    storeFormPick,
    saveFormDefaults,
    recipeFor,
    clearRecipe,
    hostOf,
    formMessage,
  };
}
