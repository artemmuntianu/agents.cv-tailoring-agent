/**
 * The page reader: one function, three strategies, executed **inside the page**.
 *
 * `chrome.scripting.executeScript({ func })` serialises this function's source only, so nothing here
 * may close over a module - which is why the DOM toolkit below lives inside it, and why a site's
 * strategy arrives as **data** in `options.plan` (`src/sites/plans.js`) rather than as per-site code.
 * The worker picks the plan by host (`src/sites/index.js`); this function interprets it.
 *
 * A plan's `kind` names the shape being read, and the result echoes it in `mode` - so a caller can tell
 * "an Indeed feed whose pane is still loading" (mode `pane`, nothing found) from "a page we could not
 * read at all" (mode `none`):
 *
 *   cards      a listing whose cards *are* the vacancies (Djinni, DOU, the unlisted-site fallback)
 *   job-page   a board that renders the whole vacancy on the job page (Greenhouse)
 *   pane       a two-pane feed whose cards carry no description (Indeed)
 *
 * Two invariants survive from the shapes this replaced. A card with no id or no text is **skipped**,
 * never emitted half-formed - the batch contract requires `external_id` + `description_raw`, and a card
 * the worker cannot tailor is worse than no card. And the `pane` shape takes its id from the pane
 * rather than the card whenever the pane names itself, because the highlight moves a beat before the
 * text does and an id from the card can end up over the previous vacancy's body.
 */
export function extractVacancies(root, options = {}) {
  const plan = (options && options.plan) || null;
  const max = (options && options.max) || 25;

  const BLOCK_TAGS = [
    'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'section', 'article', 'tr', 'table', 'blockquote', 'pre',
  ];
  const SKIP_TAGS = ['script', 'style', 'noscript', 'template'];

  function none(error) {
    return { vacancies: [], skipped: 0, error: error, mode: 'none' };
  }

  /**
   * HTML -> plain text with paragraph breaks preserved. `innerText` is avoided deliberately: jsdom
   * (the test environment) does not implement it, and a layout-dependent value would make the reader
   * untestable.
   */
  function textOf(node) {
    const chunks = [];
    const walk = (element) => {
      for (const child of Array.from(element.childNodes || [])) {
        if (child.nodeType === 3) {
          chunks.push(child.nodeValue || '');
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = (child.tagName || '').toLowerCase();
        if (SKIP_TAGS.indexOf(tag) !== -1) continue;
        if (tag === 'br') {
          chunks.push('\n');
          continue;
        }
        const block = BLOCK_TAGS.indexOf(tag) !== -1;
        if (block) chunks.push('\n');
        walk(child);
        if (block) chunks.push('\n');
      }
    };
    walk(node);
    return chunks.join('');
  }

  function collapse(text) {
    return String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00a0]+/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  }

  /** The first selector that yields text, collapsed - '' when none of them does. */
  function pickText(node, selectors) {
    if (!node) return '';
    for (const selector of selectors) {
      const found = node.querySelector(selector);
      if (!found) continue;
      const text = collapse(textOf(found));
      if (text) return text;
    }
    return '';
  }

  /** The card's own link to the vacancy: the job-ish one, else whatever link it carries. */
  function firstHref(card) {
    const links = Array.from(card.querySelectorAll('a[href]'));
    const job = links.filter((link) => /job|vacanc|\/jobs\//i.test(link.getAttribute('href') || ''));
    const chosen = job.length > 0 ? job[0] : links[0];
    return chosen ? chosen.getAttribute('href') || '' : '';
  }

  /* -- strategy: cards ------------------------------------------------------------------------ */

  /** One vacancy per card, read where it stands. */
  function readCards(doc, base) {
    const vacancies = [];
    let skipped = 0;

    for (const card of Array.from(doc.querySelectorAll(plan.card))) {
      if (vacancies.length >= max) break;

      const raw = String(card.getAttribute('id') || '').trim();
      const externalId = raw.indexOf(plan.idPrefix) === 0 ? raw.slice(plan.idPrefix.length) : raw;
      const description = pickText(card, plan.description);
      if (!externalId || !description) {
        skipped += 1; // no id or no text: nothing a worker could tailor
        continue;
      }

      const href = firstHref(card);
      let sourceUrl = '';
      if (href) {
        try {
          sourceUrl = new URL(href, base).toString();
        } catch (error) {
          sourceUrl = '';
        }
      }

      vacancies.push({
        external_id: externalId,
        title: pickText(card, plan.title),
        company: pickText(card, plan.company),
        description_raw: description,
        // Always present (null when the card has no usable link) so the payload shape stays stable
        // for the batch endpoint's validator.
        source_url: sourceUrl || null,
      });
    }

    return { vacancies: vacancies, skipped: skipped, error: null, mode: 'cards' };
  }

  /* -- strategy: job-page --------------------------------------------------------------------- */

  /** The whole page *is* the vacancy: the id from the URL, the text from the page. */
  function readJobPage(doc) {
    const href = (doc.location && doc.location.href) || doc.baseURI || '';
    const match = String(href).match(new RegExp(plan.urlId));
    const description = pickText(doc, plan.description);
    if (!match || !doc.querySelector(plan.marker) || !description) {
      // A bare board carries the markup but no id, and a page mid-render carries no text: neither is
      // a vacancy, and the caller can see that from the empty result.
      return { vacancies: [], skipped: 0, error: null, mode: 'job-page' };
    }

    let company = '';
    const at = collapse(textOf(doc.querySelector('title'))).match(
      new RegExp(plan.companyFromTitle, 'i'),
    );
    if (at) company = at[1].trim();
    if (!company) {
      const segment = String(href).split('/')[plan.companyPathSegment] || '';
      if (segment && !/^jobs?$/i.test(segment)) company = segment;
    }

    return {
      vacancies: [
        {
          external_id: match[1],
          title: pickText(doc, plan.title),
          company: company,
          description_raw: description,
          source_url: href || null,
        },
      ],
      skipped: 0,
      error: null,
      mode: 'job-page',
    };
  }

  /* -- strategy: pane ------------------------------------------------------------------------- */

  /** The pane's own vacancy id, from the `fromjk` its company and apply links carry. */
  function paneJk(pane) {
    const found = String((pane && pane.innerHTML) || '').match(new RegExp(plan.paneId, 'i'));
    return found ? found[1] : '';
  }

  /** The vacancy's own page - the stable URL a human would paste, not the feed's tracking link. */
  function paneUrl(doc, externalId) {
    let origin = '';
    try {
      origin = new URL((doc.location && doc.location.href) || doc.baseURI || '').origin;
    } catch (error) {
      origin = '';
    }
    return origin ? origin + plan.vacancyPath + encodeURIComponent(externalId) : '';
  }

  /**
   * The **selected** vacancy of a two-pane feed.
   *
   * The cards carry a snippet at best and the pane holds the full text of whichever card is selected -
   * exactly one at a time - so this is not a list to loop over. The id comes from the pane's own
   * `fromjk`, with the highlighted card as the fallback for a layout that renders none, and the prose
   * from the pane. Whichever element *named* the vacancy also describes it: mixing the pane's text
   * with another card's title would put one job's header over another job's body.
   */
  function readPane(doc) {
    const pane = doc.querySelector(plan.pane);
    const description = pickText(pane, plan.description);
    if (!description) {
      // A pane that is still loading is not a vacancy - this is the "recognised, not ready yet"
      // answer the caller must be able to tell apart from "unreadable page".
      return { vacancies: [], skipped: 0, error: null, mode: 'pane' };
    }

    const selected = doc.querySelector(plan.highlight);
    const link = selected ? selected.querySelector(plan.cardId) : null;
    const fromPane = paneJk(pane);
    const cardJk = link ? String(link.getAttribute(plan.cardIdAttr) || '').trim() : '';
    const externalId = String(fromPane || cardJk).trim();
    if (!externalId) {
      return { vacancies: [], skipped: 0, error: null, mode: 'pane' };
    }

    const named = fromPane ? pane : selected;
    return {
      vacancies: [
        {
          external_id: externalId,
          title: pickText(named, plan.title) || pickText(pane, plan.title),
          company: pickText(named, plan.company) || pickText(pane, plan.company),
          description_raw: description,
          source_url: paneUrl(doc, externalId) || null,
        },
      ],
      skipped: 0,
      error: null,
      mode: 'pane',
    };
  }

  /* -- dispatch ------------------------------------------------------------------------------- */

  const doc = root || (typeof document === 'undefined' ? null : document);
  if (!doc) return none('no document');
  if (!plan || !plan.kind) return none('no site strategy for this page');

  const base = doc.baseURI || (doc.location && doc.location.href) || 'https://example.invalid';
  if (plan.kind === 'cards') return readCards(doc, base);
  if (plan.kind === 'job-page') return readJobPage(doc);
  if (plan.kind === 'pane') return readPane(doc);
  return none('unknown strategy kind: ' + plan.kind);
}
