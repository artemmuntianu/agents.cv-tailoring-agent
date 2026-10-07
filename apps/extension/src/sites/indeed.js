import { PANE } from './plans.js';

/**
 * Indeed's job feed - the one strategy that needs more than a read.
 *
 * Its cards carry a snippet and the pane holds a single vacancy's text, so a card has to be *selected*
 * and waited for before it can be read at all. That behaviour is `src/indeed.js` (the content script
 * whose `indeedCards`/`indeedSelect` messages the worker drives), and it is why this is the only
 * binding with `sweep: true`: "Scrape & queue this page" walks the feed card by card
 * (`src/indeed/sweep.js`).
 *
 * One slug covers every country site on purpose: Indeed's `jk` is unique across them, so
 * `pt`/`www`/`uk` are a single id space and a per-country slug would fork one vacancy into as many
 * cards as there are sites.
 */
export const indeed = {
  slug: 'indeed',
  hosts: ['indeed.com'],
  /** The vacancy key in the page URL (`/viewjob?jk=510f8e399c212ca1`) - the same `jk` `PANE.paneId` reads. */
  urlId: '[?&]jk=([0-9a-f]{8,32})',
  buttons: 'pane',
  sweep: true,
  plan: PANE,
};
