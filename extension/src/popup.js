import { extractVacancies } from './extract.js';
import { phaseLabel } from './form/phases.js';
import { describeReport } from './form/plan.js';

/**
 * Popup: scrape the active tab, drive the application-form filler, edit the candidate facts.
 * No credential ever reaches this side - the worker owns the token.
 */
const $ = (id) => document.getElementById(id);

const PROFILE_FIELDS = [
  'full_name',
  'email',
  'phone',
  'location',
  'linkedin',
  'github',
  'english_level',
  'salary_expectation',
  'availability',
  'work_rights',
];

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
  if (signedIn) await Promise.all([refreshRecipe(), loadProfile()]);
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

async function scrapeAndQueue() {
  $('scrape').disabled = true;
  try {
    const tab = await activeTab();
    if (!tab || !tab.id) return status('No active tab to scrape.', 'error');

    status('Scraping…');
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractVacancies,
    });
    const result = (injection && injection[0] && injection[0].result) || {
      vacancies: [],
      skipped: 0,
    };

    if (result.error) return status(result.error, 'error');
    if (result.vacancies.length === 0) {
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

async function loadProfile() {
  const response = await send({ type: 'profileGet' });
  if (!response.ok) {
    report(response.error || 'could not read the candidate facts', 'error');
    return;
  }
  const facts = (response.profile && response.profile.facts) || {};
  for (const key of PROFILE_FIELDS) $(`p_${key}`).value = facts[key] || '';
}

async function saveProfile() {
  const facts = {};
  for (const key of PROFILE_FIELDS) {
    const value = $(`p_${key}`).value.trim();
    if (value) facts[key] = value;
  }
  const response = await send({ type: 'profilePut', profile: { facts } });
  if (!response.ok) return report(response.error || 'could not save the facts', 'error');
  report(
    'Candidate facts saved on the board. A new fact changes the form hash, so the next Populate ' +
      'drafts the form again.',
    'ok',
  );
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
$('saveProfile').addEventListener('click', saveProfile);
$('loadProfile').addEventListener('click', loadProfile);
$('signout').addEventListener('click', async () => {
  await send({ type: 'signOut' });
  await refresh();
  status('Signed out.');
});

refresh();
