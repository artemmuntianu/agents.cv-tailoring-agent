import { JOB_PAGE } from './plans.js';

/**
 * Greenhouse's boards: a job page *is* the vacancy, so there is nothing to click through and the id
 * comes from the URL.
 *
 * `buttons: 'cards'` reads oddly for a board with no cards, and it is nonetheless right: it means "the
 * manifest wires the button script to these hosts", and the button script handles both shapes. Here it
 * finds no `div[id^="job-item-"]`, so the **page** is the unit - the id from the URL, the button
 * inserted beside the job's own `h1` (verified 2026-10-08 on
 * `job-boards.greenhouse.io/cresteo/jobs/4740438005`). The hosts are in the manifest's first
 * content-script entry for the *form filler* too (`src/formfill.js`), which is not a scraper: it fills
 * an application, and it is wired by host as well.
 */
export const greenhouse = {
  slug: 'greenhouse',
  /**
   * The three board hosts - the same three the manifest wires, so a claim here and a grant there
   * cannot drift (a test asserts it). Deliberately not the apex `greenhouse.io`: that is the company's
   * own site, and a claim nobody injects into is a claim that only looks right.
   */
  hosts: ['job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io', 'boards.greenhouse.io'],
  /** The same URL shape `JOB_PAGE.urlId` scrapes with (`/<board>/jobs/<id>`). */
  urlId: '\\/jobs\\/(\\d+)',
  buttons: 'cards',
  sweep: false,
  plan: JOB_PAGE,
};
