/**
 * The page strategies a site can be read with - the *what* of a scrape, as plain data.
 *
 * Why data and not code: the reading happens **inside the page**, and the only way a popup or a
 * service worker gets a function in there is `chrome.scripting.executeScript({ func })`, which
 * serialises the function's *source*. An injected reader therefore cannot close over a module, and
 * `args` are structured-cloned, so a function cannot be handed to it either. **Selectors travel; code
 * does not.** The one executor that understands these plans is `extract.js` - which is why its DOM
 * toolkit stays inside that function - and a site is a *binding* of slug + hosts + behaviour to one of
 * them (`sites/<site>.js`).
 *
 * So a new mark-up *shape* is a new kind plus a reader in `extract.js`; a new *site* on a shape we
 * already know is a binding and nothing else. (Values are plain strings, regexes included: a `RegExp`
 * is not worth betting a round trip to the page on.)
 */

/**
 * A listing whose cards *are* the vacancies: the text sits inside the card.
 *
 * Djinni and DOU answer this one, and so does the fallback for an unlisted site that happens to render
 * the same cards.
 */
export const CARD_LIST = {
  kind: 'cards',
  /** The card element, and the id prefix inside its `id` (`id="job-item-848944"`). */
  card: 'div[id^="job-item-"]',
  idPrefix: 'job-item-',
  title: ['.job-item__position', 'h2', '[class*="position"]'],
  company: ['[class*="text-gray-800"]', '.company', '.job-item__company'],
  /**
   * The full text lives in `.js-original-text`; `.js-truncated-text` is the cut-off preview, so it is
   * only the fallback.
   */
  description: ['.js-original-text', '.js-truncated-text', '[class*="description"]'],
};

/**
 * A board that renders the whole vacancy on the job page: no cards at all.
 *
 * Greenhouse's `job-boards.greenhouse.io`, its `job-boards.eu.` twin and the older `boards.`.
 */
export const JOB_PAGE = {
  kind: 'job-page',
  /** The id is in the URL, because the page *is* the vacancy: `/<board>/jobs/<id>`. */
  urlId: '\\/jobs\\/(\\d+)(?:\\/|$)',
  /** What separates a job page from the bare board, which carries the markup but no id. */
  marker: '#application-form, .job__description',
  description: ['.job__description.body', '.job__description'],
  title: ['h1', '.job__title'],
  /**
   * The page's `<title>` is "Job Application for <role> at <company>"; the board's own path segment is
   * the fallback, since it is always there.
   */
  companyFromTitle: '\\bat\\s+([^|]+)$',
  companyPathSegment: 3,
};

/**
 * A two-pane feed whose cards carry no description: the right pane holds the **selected** vacancy's
 * text, exactly one at a time. Indeed's job feed (`*.indeed.com`).
 *
 * The only shape that needs more than a read - a card has to be selected and waited for first - which
 * is `src/indeed.js`'s job, and why the Indeed binding is the only one with `sweep: true`.
 */
export const PANE = {
  kind: 'pane',
  /** The pane, and the container inside it that holds the prose. */
  pane: '[data-testid="viewjob-main-content"]',
  description: ['.simple-job-description-html'],
  /** The pane names the vacancy it is showing (`fromjk=<jk>`): that is what pairs id with text. */
  paneId: 'fromjk=([0-9a-f]{8,32})',
  /** ...and the highlighted card is the fallback, for a layout that renders no `fromjk`. */
  highlight: 'div.cardOutline.vjs-highlight',
  cardId: 'a[data-jk]',
  cardIdAttr: 'data-jk',
  title: ['h3 span[title]', '[data-testid="vj-job-title"]'],
  company: [
    '[data-testid="company-name"]',
    '[data-testid="company-info-title-row"] a',
    'a[href*="/cmp/"]',
  ],
  /** The stable page a human would paste, built from the page's own origin. */
  vacancyPath: '/viewjob?jk=',
};
