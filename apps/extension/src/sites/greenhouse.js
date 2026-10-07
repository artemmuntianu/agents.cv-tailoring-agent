import { JOB_PAGE } from './plans.js';

/**
 * Greenhouse's boards: a job page *is* the vacancy, so there is nothing to click through and the id
 * comes from the URL.
 *
 * `buttons: 'none'` is deliberate, not an omission - the per-card button needs cards to sit in, and
 * these boards render none. The hosts are still in the manifest's first content-script entry for the
 * *form filler* (`src/formfill.js`), which is not a scraper: it fills an application, and it is wired
 * by host too.
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
  buttons: 'none',
  sweep: false,
  plan: JOB_PAGE,
};
