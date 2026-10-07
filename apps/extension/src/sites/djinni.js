import { CARD_LIST } from './plans.js';

/**
 * Djinni: the reference site for the `cards` strategy - a listing whose cards *are* the vacancies.
 *
 * A site module is a **binding**: a slug (half of the vacancy's business key - `resumes_job_key_idx`),
 * the hosts it owns, the content-script behaviour it needs, and the strategy its pages are read with.
 * `sites/index.js` discovers these and routes by host; nothing else in the extension names a site, and
 * `sites.test.ts` refuses a half-added one - a slug no host can reach, or a host the manifest does not
 * actually inject into.
 */
export const djinni = {
  slug: 'djinni',
  hosts: ['djinni.co'],
  /**
   * Where *this site's own* vacancy URL carries the id (`/jobs/848944-slug/`). The form filler asks
   * the registry for it, which is what lets *Populate* resolve a card by its id - and therefore what
   * keeps the card's *Application URL* optional, since it is only the landing page of an ATS that
   * leaves this site.
   */
  urlId: '\\/jobs\\/(\\d+)',
  /** Which per-card button content script the manifest wires for these hosts (`src/inject.js`). */
  buttons: 'cards',
  /** Whether "Scrape & queue this page" has to *walk* the page (`src/indeed/sweep.js`) - it does not. */
  sweep: false,
  plan: CARD_LIST,
};
