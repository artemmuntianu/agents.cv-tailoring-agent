import { extractVacancies } from './extract.js';
import { phaseLabel } from './form/phases.js';
import { describeReport } from './form/plan.js';
import { siteForPage } from './sites/index.js';

/**
 * Popup: scrape the active tab, drive the application-form filler. No credential ever reaches this
 * side - the worker owns the token.
 */
const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function status(text, kind) {
  const node = $('status');
  node.textContent = text;
  node.className = kind || '';
}

function report(text, kind) {
  const node = $('report');
  node.textContent = text || '';
  node.className = kind || '';
}

function activeTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0] || null);
}

async function refresh() {
  const state = await send({ type: 'status' });
  const signedIn = Boolean(state.token);

  $('auth').classList.toggle('hidden', signedIn);
  $('queue').classList.toggle('hidden', !signedIn);
  $('form').classList.toggle('hidden', !signedIn);
  $('session').textContent = signedIn
    ? `Signed in as ${state.user}\nGateway: ${state.gateway}`
    : 'Not signed in - use the account your administrator provisioned.';
  if (!signedIn) $('gateway').value = state.gateway;
  if (signedIn) await refreshRecipe();
}

/** What the extension knows about this site: the picked form and the two pins. */
async function refreshRecipe() {
  const response = await send({ type: 'formRecipe' });
  const recipe = response && response.recipe;
  if (!recipe || !recipe.root) {
    $('recipe').textContent =
      'No form picked on this site yet: open the vacancy, click Apply, then “Pick the form”.';
    return;
  }
  const pins = Object.keys(recipe.pins || {});
  $('recipe').textContent =
    `Form: ${recipe.root.selector}` +
    (pins.length ? `\nPins: ${pins.join(', ')}` : '\nNo pinned fields (the model chooses them).');
}

async function signIn() {
  $('signin').disabled = true;
  status('Signing in…');
  const response = await send({
    type: 'signIn',
    gateway: $('gateway').value.trim() || 'http://localhost:4321',
    email: $('email').value.trim(),
    password: $('password').value,
  });
  $('signin').disabled = false;
  if (!response.ok) return status(response.error, 'error');
  $('password').value = '';
  await refresh();
  status('Signed in.', 'ok');
}

const SWEEP_TICK_MS = 800;
const SWEEP_DEADLINE_MS = 6 * 60 * 1000;

/**
 * Follow a sweep the worker is driving, and report how it ended.
 *
 * The walk itself is the worker's (`indeed/sweep.js`) - the popup can vanish mid-run and must not take
 * the walk with it - so this only reports. Closing the popup loses the report, not the cards.
 */
async function followSweep() {
  const started = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, SWEEP_TICK_MS));
    const answer = await send({ type: 'scrapeProgress' });
    const progress = (answer && answer.progress) || {};

    if (progress.running) {
      // The walk is one card at a time, so name the card: on a slow feed a frozen label is
      // indistinguishable from a hang.
      const at = Math.min(progress.done + 1, progress.total || 1);
      status(`Scraping vacancy ${at} of ${progress.total}…`);
      if (Date.now() - started > SWEEP_DEADLINE_MS) {
        return status('The sweep is taking too long - check the Indeed tab.', 'error');
      }
      continue;
    }

    if (progress.error) return status(progress.error, 'error');
    const parts = [`Created ${progress.created} card(s) in Scraped.`];
    if (progress.duplicates) parts.push(`${progress.duplicates} already on the board.`);
    if (progress.already) {
      // The sweep never selects these, so the feed does not flicker through vacancies nobody needs.
      parts.push(`${progress.already} card(s) already on the board - not visited.`);
    }
    if (progress.skipped) {
      parts.push(`${progress.skipped} card(s) skipped - their description never loaded.`);
    }
    if (progress.created > 0) parts.push('Drag a card into Prepare to have the worker tailor it.');
    return status(parts.join('\n'), 'ok');
  }
}

async function scrapeAndQueue() {
  $('scrape').disabled = true;
  try {
    const tab = await activeTab();
    if (!tab || !tab.id) return status('No active tab to scrape.', 'error');

    status('Scraping…');
    // Indeed's feed holds one description at a time, so "this page" there is a *walk* the worker
    // drives: it selects each card, waits for that card's pane and reads it, then publishes the lot
    // as one batch. Anything else (`notPage`) is the one-shot card read below.
    const swept = await send({ type: 'scrapePage' });
    if (swept.ok) return await followSweep();

    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractVacancies,
      // The *strategy* this page is read with, chosen by host in the registry - the injected function
      // cannot see the registry, and `activeTab` is what lets this work on a page whose content script
      // was never injected (an unlisted site, or an extension reloaded under an open tab).
      args: [null, { plan: siteForPage(tab.url).plan }],
    });
    const result = (injection && injection[0] && injection[0].result) || {
      vacancies: [],
      skipped: 0,
    };

    if (result.error) return status(result.error, 'error');
    if (result.vacancies.length === 0) {
      // Indeed's feed is recognised even while its pane is still filling: "no vacancy cards" would be
      // a lie there - the cards are on the page, this vacancy's *description* is just not rendered.
      if (result.mode === 'pane') {
        return status(
          'Indeed is still filling the right pane for this vacancy - wait for its description to ' +
            'appear, then press again (or use the card’s own Scrape button, which waits for you).',
          'error',
        );
      }
      return status(
        `No vacancy cards found on this page${result.skipped ? ` (${result.skipped} skipped)` : ''}.`,
        'error',
      );
    }

    status(`Scraping ${result.vacancies.length} vacancy(ies)…`);
    const response = await send({ type: 'publish', payload: { vacancies: result.vacancies } });

    if (!response.ok) {
      await refresh();
      return status(response.error || 'publish failed', 'error');
    }
    const created = Number(response.created) || 0;
    const parts = [`Created ${created} card(s) in Scraped.`];
    if (response.duplicates) parts.push(`${response.duplicates} already on the board.`);
    if (result.skipped) parts.push(`${result.skipped} card(s) skipped (no id or no text).`);
    // Indeed's feed holds one description at a time, so this page is one vacancy rather than a
    // list: say so, and name it - "1 card(s)" next to a page showing twelve cards reads like a bug,
    // and the pane is the only thing that says *which* job was queued.
    if (result.mode === 'indeed-pane') {
      const first = result.vacancies[0] || {};
      parts.push(
        'Indeed shows one job\u2019s description at a time: this queued "' +
          (first.title || 'the vacancy') +
          '" - the one the right pane was showing.',
      );
    }
    if (created > 0) parts.push('Drag a card into Prepare to have the worker tailor it.');
    status(parts.join('\n'), 'ok');
  } catch (error) {
    status(error && error.message ? error.message : String(error), 'error');
  } finally {
    $('scrape').disabled = false;
  }
}

/** Point at the form (or at one of the two fields the extension fills itself). */
async function pick(kind, buttonId) {
  const button = $(buttonId);
  button.disabled = true;
  report('');
  status(
    kind === 'root'
      ? 'Click the application form in the page (Esc cancels).'
      : 'Click the field in the page (Esc cancels).',
  );
  try {
    const response = await send({ type: 'pickForm', kind });
    if (!response.ok) return status(response.error || 'nothing was picked', 'error');
    const picked = response.picked || {};
    await refreshRecipe();
    status(
      kind === 'root'
        ? `Form remembered: ${picked.selector} (${picked.fields || 0} fillable field(s)).`
        : `Pinned: ${picked.selector}`,
      'ok',
    );
  } catch (error) {
    status(error && error.message ? error.message : String(error), 'error');
  } finally {
    button.disabled = false;
  }
}

/**
 * The whole fill: snapshot -> board draft -> apply.
 *
 * The status area follows the flow's **own** phases (a `{ type: 'phase' }` poll every second,
 * worded by `form/phases.js`): a fill is a KEDA cold start plus a Gemini call plus two document
 * fetches, and claiming to be "snapshotting" for all of it reads like a hang. The ticker stops the
 * moment the flow returns, so the summary below is the last thing said.
 */
async function populate() {
  $('populate').disabled = true;
  report('');
  status('Snapshotting the form…');

  let running = true;
  const ticker = setInterval(async () => {
    const response = await send({ type: 'phase' });
    if (running && response && response.ok) status(phaseLabel(response.phase));
  }, 1000);

  try {
    const response = await send({ type: 'populate' });
    running = false;
    if (!response.ok) {
      report((response && response.error) || 'the fill did not run', 'error');
      return status('Populate failed.', 'error');
    }
    const bits = response.planBits || {};
    // Where the card came from matters when the page was not its own source site: a DOU/Djinni
    // card reached through the employer's form is matched by its Application URL.
    const via = response.linkedBy === 'url' ? ' Matched this page by Application URL.' : '';
    status(
      `Draft from ${bits.model || 'the model'} (${bits.decided || 0} fields decided, ` +
        `${bits.undecided || 0} left). Cover letter: ${response.coverStatus}. Resume: ${response.fileStatus}.${via}`,
      'ok',
    );
    report(describeReport(response));
  } catch (error) {
    report(error && error.message ? error.message : String(error), 'error');
    status('Populate failed.', 'error');
  } finally {
    running = false;
    clearInterval(ticker);
    $('populate').disabled = false;
  }
}

$('signin').addEventListener('click', signIn);
$('scrape').addEventListener('click', scrapeAndQueue);
$('pick').addEventListener('click', () => pick('root', 'pick'));
$('pickCover').addEventListener('click', () => pick('cover_letter', 'pickCover'));
$('pickResume').addEventListener('click', () => pick('resume_file', 'pickResume'));
$('populate').addEventListener('click', populate);
$('forget').addEventListener('click', async () => {
  await send({ type: 'clearFormRecipe' });
  await refreshRecipe();
  status('This site’s form recipe was forgotten.', 'ok');
});
$('signout').addEventListener('click', async () => {
  await send({ type: 'signOut' });
  await refresh();
  status('Signed out.');
});

refresh();
