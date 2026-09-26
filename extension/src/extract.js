/**
 * The vacancy scraper, exactly the DOM contract from the architecture design:
 *
 *   div[id^="job-item-"]  ->  { external_id, title, company, description_raw, source_url }
 *
 * Everything lives inside the one exported function on purpose: the popup injects it
 * with `chrome.scripting.executeScript({ func })`, which serialises the function
 * source only - a module-level helper or constant would arrive as `undefined`.
 *
 * One deliberate divergence from the sketch: the full description lives in
 * `.js-original-text` (the preview in `.js-truncated-text` is cut off), so the former
 * wins and the preview is only a fallback.
 */
export function extractVacancies(root, options = {}) {
  /** Selectors in priority order - first non-empty match wins. */
  const TITLE_SELECTORS = ['.job-item__position', 'h2', '[class*="position"]'];
  const COMPANY_SELECTORS = ['[class*="text-gray-800"]', '.company', '.job-item__company'];
  const DESCRIPTION_SELECTORS = ['.js-original-text', '.js-truncated-text', '[class*="description"]'];
  const BLOCK_TAGS = [
    'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'section', 'article', 'tr', 'table', 'blockquote', 'pre',
  ];
  const SKIP_TAGS = ['script', 'style', 'noscript', 'template'];

  /**
   * HTML -> plain text with paragraph breaks preserved. `innerText` is avoided
   * deliberately: jsdom (the test environment) does not implement it, and a
   * layout-dependent value would make the scraper untestable.
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

  function pickText(card, selectors) {
    for (const selector of selectors) {
      const node = card.querySelector(selector);
      if (!node) continue;
      const text = collapse(textOf(node));
      if (text) return text;
    }
    return '';
  }

  function firstHref(card) {
    const links = Array.from(card.querySelectorAll('a[href]'));
    const job = links.filter((link) => /job|vacanc|\/jobs\//i.test(link.getAttribute('href') || ''));
    const chosen = job.length > 0 ? job[0] : links[0];
    return chosen ? chosen.getAttribute('href') || '' : '';
  }

  const max = options.max || 25;
  const doc = root || (typeof document === 'undefined' ? null : document);
  if (!doc) return { vacancies: [], skipped: 0, error: 'no document' };

  const base = doc.baseURI || (doc.location && doc.location.href) || 'https://example.invalid';
  const cards = Array.from(doc.querySelectorAll('div[id^="job-item-"]'));
  const vacancies = [];
  let skipped = 0;

  for (const card of cards) {
    if (vacancies.length >= max) break;

    const externalId = (card.getAttribute('id') || '').replace(/^job-item-/, '').trim();
    const description = pickText(card, DESCRIPTION_SELECTORS);
    if (!externalId || !description) {
      skipped += 1; // no id or no text: nothing a worker could tailor
      continue;
    }

    const href = firstHref(card);
    let sourceUrl = '';
    if (href) {
      try {
        sourceUrl = new URL(href, base).toString();
      } catch {
        sourceUrl = '';
      }
    }

    const vacancy = {
      external_id: externalId,
      title: pickText(card, TITLE_SELECTORS),
      company: pickText(card, COMPANY_SELECTORS),
      description_raw: description,
      // Always present (null when the card has no usable link) so the payload shape
      // is stable for the batch endpoint's validator.
      source_url: sourceUrl || null,
    };
    vacancies.push(vacancy);
  }

  return { vacancies: vacancies, skipped: skipped, error: null };
}
