import { extractVacancies } from './extract.js';

/**
 * Popup: scrape the active tab, hand the batch to the service worker, report the
 * outcome. No credential ever reaches this side - the worker owns the token.
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

async function refresh() {
  const state = await send({ type: 'status' });
  const signedIn = Boolean(state.token);

  $('auth').classList.toggle('hidden', signedIn);
  $('queue').classList.toggle('hidden', !signedIn);
  $('session').textContent = signedIn
    ? `Signed in as ${state.user}\nGateway: ${state.gateway}`
    : 'Not signed in - use the account your administrator provisioned.';
  if (!signedIn) $('gateway').value = state.gateway;
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return status('No active tab to scrape.', 'error');

    status('Scraping…');
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractVacancies,
    });
    const result = (injection && injection[0] && injection[0].result) || { vacancies: [], skipped: 0 };

    if (result.error) return status(result.error, 'error');
    if (result.vacancies.length === 0) {
      return status(
        `No vacancy cards found on this page${result.skipped ? ` (${result.skipped} skipped)` : ''}.`,
        'error',
      );
    }

    status(`Queueing ${result.vacancies.length} vacancy(ies)…`);
    const response = await send({ type: 'publish', payload: { vacancies: result.vacancies } });

    if (!response.ok) {
      await refresh();
      return status(response.error || 'publish failed', 'error');
    }
    const parts = [`Queued ${response.published} message(s) on ${response.queue}.`];
    if (response.duplicates) parts.push(`${response.duplicates} already on the board.`);
    if (response.retries) parts.push(`${response.retries} failed card(s) re-queued.`);
    if (result.skipped) parts.push(`${result.skipped} card(s) skipped (no id or no text).`);
    if (typeof response.depth === 'number') parts.push(`Queue depth now ${response.depth}.`);
    parts.push('The cards are in Created - open the board to watch them.');
    status(parts.join('\n'), 'ok');
  } catch (error) {
    status(error && error.message ? error.message : String(error), 'error');
  } finally {
    $('scrape').disabled = false;
  }
}

$('signin').addEventListener('click', signIn);
$('scrape').addEventListener('click', scrapeAndQueue);
$('signout').addEventListener('click', async () => {
  await send({ type: 'signOut' });
  await refresh();
  status('Signed out.');
});

refresh();
