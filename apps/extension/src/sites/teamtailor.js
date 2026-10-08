import { JOB_PAGE } from './plans.js';

/**
 * Teamtailor's career sites: the job page *is* the vacancy, and the application form is an overlay
 * the page fetches into itself (`<div data-controller="careersite--jobs--form-overlay"
 * data-…-form-overlay-job-application-url-value="…/applications/new">`), so there are no cards to
 * click through.
 *
 * `buttons: 'none'` is deliberate, not an omission - `src/inject.js` sits its button either on a card
 * or, on a one-vacancy page, beside the title *behind Greenhouse's own marker*
 * (`#application-form, .job__description`), and these pages carry neither (their form is an overlay in
 * the same document, `data-controller="careersite--jobs--form-overlay"`): a button there could only
 * ever answer *"that card is not on this page any more"*, because the reader below refuses the page.
 * The host is
 * still in the manifest's first content-script entry, for the *form filler* (`src/formfill.js`):
 * that is not a scraper - it fills an application, and it is wired by host too - which is exactly
 * how Greenhouse's boards got theirs. Verified live on this host 2026-10-07 (card `353314`'s
 * Application URL, a DOU vacancy applied to on the employer's own ATS): before the grant, Populate
 * answered *"this page cannot be filled (no form filler on it - reload the page)"*.
 *
 * `JOB_PAGE` is the honest binding even though nothing here is scraped: the reader refuses a page
 * whose marker or description it cannot find (`extract.js::readJobPage` answers *no vacancies*
 * rather than a mangled card), so **Scrape & queue this page** on such a page reports an empty read
 * instead of inventing a vacancy the DOU card already holds. Discovery stays the feeds' business.
 *
 * Only the verified customer host is claimed. Teamtailor also serves customers at
 * `<company>.teamtailor.com`, but that is the vendor's own marketing apex plus domains nobody has
 * injected into yet, and *"a claim nobody injects into is a claim that only looks right"* - a second
 * Teamtailor host is one more entry in `hosts` and one more manifest grant.
 */
export const teamtailor = {
  slug: 'teamtailor',
  /** The one host wired today (see the docstring): a named customer's career site. */
  hosts: ['careers.blackbird-lab.com'],
  /** `/jobs/<id>-<slug>` on the customer domain, the same shape the vendor's own hosting uses. */
  urlId: '\\/jobs\\/(\\d+)',
  buttons: 'none',
  sweep: false,
  plan: JOB_PAGE,
};
