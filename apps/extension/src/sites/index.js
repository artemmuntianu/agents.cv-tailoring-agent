import { djinni } from './djinni.js';
import { dou } from './dou.js';
import { greenhouse } from './greenhouse.js';
import { indeed } from './indeed.js';
import { CARD_LIST } from './plans.js';

export { CARD_LIST, JOB_PAGE, PANE } from './plans.js';

/**
 * The site registry: which plugin owns a URL, and what its cards get stamped with.
 *
 * Discovery only - no network, no state, no DOM. Adding a site is one module beside the others (plus a
 * manifest entry if it needs a content script, which a test enforces), and nothing else in the
 * extension names a site: `background.js`, `popup.js` and `indeed/sweep.js` all ask *this* which
 * strategy a page is read with.
 *
 * It mirrors `apps/worker/scout/sources.py` on purpose - the Python intake has had exactly this
 * registry (one module per site, routed by host, validated at load) since before the extension had a
 * second site - and `validate()` is that registry's safety net, for the same two reasons: two sites
 * sharing a slug would merge their id spaces (one site's vacancies would look like the other's
 * duplicates), and two claiming one host would make routing depend on import order. Neither is
 * visible in review, so both fail loudly instead.
 */
export const SITES = [djinni, dou, greenhouse, indeed];

/**
 * The site an unlisted host is read as: the card-list strategy under the slug `other`.
 *
 * It exists because **Scrape & queue this page** has always read *whatever* page the operator is
 * looking at, and an unlisted site that happens to render these cards is still worth queueing. Its own
 * slug keeps it in its own id space, so it can never collide with a site that has a plugin.
 */
export const GENERIC = {
  slug: 'other',
  hosts: [],
  buttons: 'cards',
  sweep: false,
  plan: CARD_LIST,
};

/** The lower-cased hostname of a URL, or '' when it has none. */
export function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch (error) {
    return '';
  }
}

/**
 * The plugin that owns this URL - the strict question "is this a site we know?".
 *
 * A host matches exactly or as a `.`-suffix, so `dou.ua` also covers `jobs.dou.ua` and `indeed.com`
 * covers `pt.indeed.com`. `null` is a real answer, and callers that must not guess check for it.
 */
export function siteForUrl(url) {
  const host = hostOf(url);
  if (!host) return null;
  for (const site of SITES) {
    for (const claimed of site.hosts) {
      if (host === claimed || host.endsWith('.' + claimed)) return site;
    }
  }
  return null;
}

/** The plugin a page is *read* with: its own, or the generic fallback. Never null. */
export function siteForPage(url) {
  return siteForUrl(url) || GENERIC;
}

/** The plugin behind a stored `resumes.source` slug, or null. */
export function siteForSlug(slug) {
  const wanted = String(slug || '').trim().toLowerCase();
  return SITES.find((site) => site.slug === wanted) || null;
}

/**
 * Refuse a registry that would let two sites share an id space, a host, or a strategy.
 *
 * Called at load (`validate()` below), so a half-added site breaks the extension loudly rather than
 * filing one site's vacancies under another's slug.
 */
export function validate(registry = SITES) {
  const slugs = registry.map((site) => site.slug);
  const clashing = [...new Set(slugs.filter((slug) => slugs.filter((x) => x === slug).length > 1))];
  if (clashing.length > 0) {
    throw new Error('two plugins claim the same slug: ' + clashing.sort().join(', '));
  }

  const claimed = new Map();
  for (const site of registry) {
    for (const host of site.hosts) {
      if (claimed.has(host)) {
        throw new Error(
          site.slug + ' and ' + claimed.get(host) + ' both claim the host ' + host,
        );
      }
      claimed.set(host, site.slug);
    }
  }

  for (const site of registry) {
    if (!site.plan || !site.plan.kind) {
      throw new Error(site.slug + ' declares no page strategy');
    }
  }
}

validate();
