import { CARD_LIST } from './plans.js';

/**
 * DOU's listings. Its cards are Djinni's - the same `div[id^="job-item-"]` wrapper, the same
 * description container - so this binds the *same* strategy on purpose.
 *
 * What differs is the slug, and the slug is not cosmetic: it completes the vacancy's business key, so
 * DOU's 374708 and Djinni's 374708 are two vacancies and must never share a card space. Should DOU's
 * markup ever drift, the selectors it needs are written here, in its own binding.
 */
export const dou = {
  slug: 'dou',
  hosts: ['dou.ua'],
  /**
   * DOU puts the vacancy id after `/vacancies/`, **not** `/jobs/`: `/vacancies/375802/` and
   * `/companies/riseapps/vacancies/375802/` are the same vacancy, and the number is exactly the
   * `resumes.external_id` that both the feed intake and the browser scrape store. Reading it here is
   * what stops a DOU page from being pushed to the card's *Application URL* to resolve at all
   * (2026-10-07: card `375802` could not be populated from its own DOU page).
   */
  urlId: '\\/vacancies\\/(\\d+)',
  buttons: 'cards',
  sweep: false,
  plan: CARD_LIST,
};
