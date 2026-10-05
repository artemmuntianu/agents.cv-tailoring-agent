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
  buttons: 'cards',
  sweep: false,
  plan: CARD_LIST,
};
