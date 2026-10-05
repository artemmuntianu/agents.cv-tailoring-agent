import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GENERIC,
  SITES,
  siteForPage,
  siteForSlug,
  siteForUrl,
  validate,
} from '../../../extension/src/sites/index.js';
import { CARD_LIST, JOB_PAGE, PANE } from '../../../extension/src/sites/plans.js';

/**
 * The site registry - the scrapers, as plugins.
 *
 * A plugin is a strategy (`sites/<site>.js`) plus the slug, hosts and content-script behaviour it
 * needs; the registry routes a URL to one of them, and everything else in the extension asks *it*
 * rather than naming a site. So these tests answer the two questions no single file can:
 *
 * * **is the registry sound?** `validate()` refuses what would silently corrupt data (two sites sharing
 *   a slug would merge their id spaces), and the shipped registry is validated at load.
 * * **do the other files agree with it?** The manifest wires hosts to content scripts by hand and the
 *   backoffice names slugs in its own label map - neither can import this module, so both are pinned
 *   here. Adding a site and forgetting one of them fails the suite instead of shipping half a plugin.
 */
const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../extension/manifest.json', import.meta.url)), 'utf8'),
) as { content_scripts: { matches: string[]; js: string[] }[]; host_permissions: string[] };
const CARD_META = readFileSync(fileURLToPath(new URL('./cardMeta.ts', import.meta.url)), 'utf8');

type Site = (typeof SITES)[number];

/** Chrome match pattern -> regex (`*` is the only wildcard; everything else is literal). */
function patternToRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

describe('the site registry', () => {
  it('routes a URL to the plugin that owns its host, subdomains included', () => {
    expect(siteForUrl('https://djinni.co/jobs/123-x/')?.slug).toBe('djinni');
    expect(siteForUrl('https://jobs.dou.ua/vacancies/?remote')?.slug).toBe('dou');
    expect(siteForUrl('https://job-boards.eu.greenhouse.io/growe/jobs/1')?.slug).toBe('greenhouse');
    expect(siteForUrl('https://pt.indeed.com/')?.slug).toBe('indeed');

    // A host that merely *ends* like a claimed one is not its subdomain, and an unlisted host is not a
    // site we know at all.
    expect(siteForUrl('https://notdjinni.co/jobs/')).toBeNull();
    expect(siteForUrl('https://djinni.co.evil.test/jobs/')).toBeNull();
    expect(siteForUrl('https://example.com/jobs/')).toBeNull();
    expect(siteForUrl('')).toBeNull();
  });

  it('separates "not a site we know" from "read it with the fallback"', () => {
    // The popup reads whatever page the operator is looking at, so it asks the lenient question.
    expect(siteForPage('https://example.com/jobs/')).toBe(GENERIC);
    expect(GENERIC.slug).toBe('other');
    // Anything that must not guess (the sweep, the manifest guard) asks the strict one.
    expect(siteForUrl('https://example.com/jobs/')).toBeNull();
    expect(siteForPage('https://pt.indeed.com/').slug).toBe('indeed');
  });

  it('finds a plugin by the slug a card was stored under', () => {
    expect(siteForSlug('indeed')?.plan).toBe(PANE);
    expect(siteForSlug('greenhouse')?.plan).toBe(JOB_PAGE);
    expect(siteForSlug('  DOU ')?.plan).toBe(CARD_LIST);
    expect(siteForSlug('work-ua')).toBeNull();
  });

  it('refuses a registry that would merge two id spaces or two hosts', () => {
    const site = (slug: string, hosts: string[], plan: unknown): Site =>
      ({ slug, hosts, buttons: 'none', sweep: false, plan }) as Site;

    expect(() =>
      validate([site('a', ['a.test'], CARD_LIST), site('a', ['b.test'], CARD_LIST)]),
    ).toThrow(/same slug/);
    expect(() =>
      validate([site('a', ['x.test'], CARD_LIST), site('b', ['x.test'], CARD_LIST)]),
    ).toThrow(/both claim the host/);
    expect(() => validate([site('a', ['a.test'], undefined)])).toThrow(/no page strategy/);
    // The shipped registry passes - which is also why `index.js` validates at load.
    expect(() => validate()).not.toThrow();
  });

  it('keeps every strategy structured-cloneable, because that is how it reaches the page', () => {
    // `chrome.scripting.executeScript` clones `args` into the tab. A selector string travels; a RegExp
    // or a function would not, and that would fail at scrape time in a browser rather than here.
    for (const site of [...SITES, GENERIC]) {
      expect(() => structuredClone(site.plan), site.slug).not.toThrow();
    }
  });

  it('wires the manifest the way the plugins declare, so the two cannot drift', () => {
    const matchesOf = (file: string): RegExp[] =>
      MANIFEST.content_scripts
        .filter((entry) => entry.js.includes(file))
        .flatMap((entry) => entry.matches)
        .map(patternToRegex);
    const granted = MANIFEST.host_permissions.map(patternToRegex);

    // A plugin says which per-card behaviour it needs; the manifest is what actually wires it.
    for (const file of ['src/inject.js', 'src/indeed.js']) {
      const wanted = file === 'src/indeed.js' ? 'pane' : 'cards';
      for (const site of SITES.filter((entry) => entry.buttons === wanted)) {
        for (const host of site.hosts) {
          const url = 'https://' + host + '/x';
          expect(matchesOf(file).some((pattern) => pattern.test(url)), site.slug).toBe(true);
        }
      }
    }

    // Every host is granted, buttons or not: the popup's `scrapeCard` injects with `chrome.scripting`,
    // and a missing grant is what shows up live as a button that answers "Retry scrape".
    for (const site of SITES) {
      for (const host of site.hosts) {
        const url = 'https://' + host + '/x';
        expect(granted.some((pattern) => pattern.test(url)), site.slug + ' ' + url).toBe(true);
      }
    }

    // ...and a site that declares no buttons never gets the pane script.
    for (const site of SITES.filter((entry) => entry.buttons !== 'pane')) {
      for (const host of site.hosts) {
        expect(matchesOf('src/indeed.js').some((p) => p.test('https://' + host + '/x'))).toBe(false);
      }
    }
  });

  it('has a name on the board for every slug a plugin can stamp', () => {
    // The board renders `resumes.source` through its own label map (`apps/backoffice/src/lib/cardMeta.ts`)
    // and cannot import this registry - a different app, and the extension has no build step - so the two
    // lists are pinned here, exactly as the manifest is. The `other` fallback is deliberately absent from
    // that map: an unlisted slug is echoed as it is rather than prettified (`cardMeta.test.ts`).
    const labelled = [...CARD_META.matchAll(/^ {2}([a-z0-9-]+): '/gm)].map((match) => match[1]);
    const slugs = SITES.map((site) => site.slug);

    for (const slug of slugs) {
      expect(labelled, slug).toContain(slug);
    }
    // ...and nothing else is: a label left behind by a site that no longer exists is drift too.
    for (const slug of labelled) {
      expect(slugs, slug).toContain(slug);
    }
  });
});
