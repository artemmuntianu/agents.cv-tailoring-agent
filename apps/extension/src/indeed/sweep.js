import { extractVacancies } from '../extract.js';
import { siteForPage } from '../sites/index.js';

/**
 * The Indeed page sweep: "queue every vacancy on this feed".
 *
 * Indeed's feed holds the description of exactly one vacancy - the selected card's - so queueing a
 * whole page is a **walk**: select a card, wait until its description is rendered, read that one
 * vacancy, move on. The walk lives here rather than in the popup for the same reason the batch POST
 * does: a popup closes the moment it loses focus, and a dozen cards take tens of seconds. The popup
 * starts the walk and then polls `progress()`; closing it mid-run loses the report, not the cards.
 *
 * The halves stay with their owners - this module knows no selector at all:
 *
 *   `src/indeed.js`     selects a card and answers once its pane is readable (the content script is
 *                       the only thing that can touch the live page and watch the pane settle)
 *   `extractVacancies`  reads that one vacancy (the single DOM contract, injected here)
 *
 * Two rules:
 *
 * * **a card whose pane never became readable is skipped, never guessed at.** The sweep counts it and
 *   walks on: the alternative is filing another vacancy's text under this card's id, which is the one
 *   mistake this shape can make.
 * * **one page is one batch**, shipped in chunks of the endpoint's own cap, because the batch route
 *   rejects more than 25 cards in one request
 *   (`apps/backoffice/src/lib/vacancies.ts::MAX_BATCH_SIZE`). A test pins the two numbers together.
 */
export const BATCH_SIZE = 25;
/** Let the feed settle between two selections: Indeed re-renders the list as the pane changes. */
const BETWEEN_CARDS_MS = 200;

/**
 * @param publish     `background.js`'s authenticated batch POST, injected like the form filler's deps.
 * @param knownIds    Which of these vacancies the board already has (`externalIds` → `Set`); the walk
 *                    skips them, so a `Scraped` card is never selected. A lookup that fails answers
 *                    "we know nothing", which walks everything rather than refusing to run.
 * @param settleMs    The pause between two cards. A test hook (the suite walks 28 cards): production
 *                    never passes it, and the default is the constant above.
 */
export function createSweepWorker({ publish, knownIds, settleMs = BETWEEN_CARDS_MS }) {
  let state = {
    running: false,
    done: 0,
    total: 0,
    created: 0,
    duplicates: 0,
    skipped: 0,
    already: 0,
    error: '',
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** The popup's ticker: how far the walk is, and how it ended. */
  function progress() {
    return { ...state };
  }

  /** A message to the page's content script, or `null` when nothing there answers. */
  function tabMessage(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          // No content script on the page (not an Indeed feed), or it was reloaded since.
          if (chrome.runtime.lastError) return resolve(null);
          resolve(response || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  /** The page's cards in DOM order, or `null` when this page has no Indeed content script. */
  async function cardIds(tabId) {
    const answer = await tabMessage(tabId, { type: 'indeedCards' });
    if (!answer || !answer.ok) return null;
    return Array.isArray(answer.ids) ? answer.ids : [];
  }

  /** Ask the page to select this card; true once its pane is readable. */
  async function selectCard(tabId, externalId) {
    const answer = await tabMessage(tabId, { type: 'indeedSelect', externalId: externalId });
    return Boolean(answer && answer.ok && answer.ready);
  }

  /** The one vacancy the page is showing, read by the very scraper the popup also uses. */
  async function readSelected(tabId, tabUrl) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: extractVacancies,
      // The walk is only for a site whose strategy says so (`sweep: true`), and the registry is what
      // knows which strategy that page is read with.
      args: [null, { max: 200, plan: siteForPage(tabUrl).plan }],
    });
    const result = (injection && injection.result) || { vacancies: [] };
    return result.vacancies || [];
  }

  /**
   * Walk the page's cards and queue what could be read. Never rejects: the outcome is in the return
   * value *and* in `progress()`, because the popup may not be there to receive either.
   */
  async function run(tabId, tabUrl) {
    if (state.running) return { ok: false, error: 'a sweep is already running' };
    state = {
      running: true,
      done: 0,
      total: 0,
      created: 0,
      duplicates: 0,
      skipped: 0,
      already: 0,
      error: '',
    };

    try {
      const ids = (await cardIds(tabId)) || [];
      if (ids.length === 0) {
        state.error = 'no Indeed cards on this page';
        return { ok: false, error: state.error };
      }

      // Cards the board already has are **not walked**: selecting them flickers the feed through
      // vacancies nobody needs (live 2026-10-05: "the autoscraper opens vacancies with Scraped
      // buttons"), and publishing them again would only come back as duplicates. It is the rule the
      // per-card buttons already follow - a `Scraped` card offers no scrape.
      const known = (await knownIds(ids, tabUrl)) || new Set();
      const wanted = ids.filter((externalId) => !known.has(externalId));
      state.already = ids.length - wanted.length;
      state.total = wanted.length;

      if (wanted.length === 0) {
        // Nothing to do is not a failure: every card on the page is already on the board.
        return { ok: true, created: 0, duplicates: 0, skipped: 0, already: state.already };
      }

      // What the page rendered when the operator asked. Cards the feed adds later (as the list
      // scrolls under the walk) are deliberately not chased: the sweep is one page, not a crawl.
      const vacancies = [];
      for (const externalId of wanted) {
        if (await selectCard(tabId, externalId)) {
          // The pane is this card's now, so the id it reports must be this one: anything else means
          // the read landed on another vacancy, and a missing card is worth more than a wrong one.
          const found = (await readSelected(tabId, tabUrl)).find(
            (item) => item.external_id === externalId,
          );
          if (found) vacancies.push(found);
          else state.skipped += 1;
        } else {
          state.skipped += 1;
        }
        state.done += 1;
        await sleep(settleMs);
      }

      if (vacancies.length === 0) {
        state.error = 'none of the cards on this page could be read - is the feed still loading?';
        return { ok: false, error: state.error };
      }

      for (let i = 0; i < vacancies.length; i += BATCH_SIZE) {
        const published = await publish({ vacancies: vacancies.slice(i, i + BATCH_SIZE) }, tabUrl);
        if (!published || !published.ok) {
          state.error = (published && published.error) || 'publish failed';
          return { ok: false, error: state.error, created: state.created };
        }
        state.created += Number(published.created) || 0;
        state.duplicates += Number(published.duplicates) || 0;
      }

      return {
        ok: true,
        created: state.created,
        duplicates: state.duplicates,
        skipped: state.skipped,
        already: state.already,
      };
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
      return { ok: false, error: state.error, created: state.created };
    } finally {
      // Always: the popup polls this to learn the walk is over, and a stuck `running` would leave it
      // ticking forever - and block the next sweep.
      state.running = false;
    }
  }

  return { run, progress, cardIds };
}
