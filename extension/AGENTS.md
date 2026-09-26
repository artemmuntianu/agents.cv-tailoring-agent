# extension/ - the vacancy scraper (Chrome MV3)

The producer at the head of the pipeline: it turns *one listing page* into a batch of
vacancies and hands it to the backoffice gateway, which publishes one AMQP message per
vacancy. It replaces the "Chrome extension -> Vercel gateway" hop of the source design;
the gateway is now `backoffice/src/pages/api/vacancies/batch.ts`
(`CONSTITUTION.md` D12).

It has two entry points, and both end in the same gateway call:

* the **popup** (on demand) - scrape every card on the page and queue the batch;
* an **injected per-card button** (`src/inject.js`, a `content_scripts` entry) - one
  vacancy at a time, right where the vacancy is, showing `Scrape` or `Scraped` (a link to
  that card on the board).

Read `CONSTITUTION.md` first. The batch contract it must satisfy is documented in
`backoffice/AGENTS.md`; the worker that consumes the result is `agent/AGENTS.md`.

## Load it (unpacked, no build step)

There is deliberately no bundler and no `package.json`: three small files Chrome can
load as-is.

1. `chrome://extensions` -> enable **Developer mode** -> **Load unpacked** ->
   select this `extension/` directory.
2. Start the backoffice (`npm run dev` in `backoffice/`, see `backoffice/AGENTS.md`),
   sign in once in the browser tab.
3. Open a vacancy listing page (e.g. `djinni.co/jobs/`), click the extension icon,
   enter the gateway URL (`http://localhost:4321`), your provisioned email/password,
   **Sign in**, then **Scrape & queue this page**.
4. The popup reports `Created N card(s) in Scraped.` -- and nothing is queued: the gateway
   creates one row per vacancy and stops there (`backoffice/AGENTS.md`, invariants 16 and 23
   in `CONSTITUTION.md`). Tailoring starts when the operator drags a card into **Prepare**:
   that drag publishes the message and the worker's claim adopts the same row, so the card
   turns from *Tailoring In Progress* to *Tailored* in place (KEDA scales 0 -> N).
5. Reload the listing page: every card now carries a green **Scrape** button in its
   footer. It queues just that vacancy, and turns into **Scraped** - a link to the card on
   the board - the moment the vacancy is there.

`host_permissions` in `manifest.json` lists `localhost:4321` / `127.0.0.1:4321`. A
different gateway origin must be added there (Chrome does not allow a wildcard host
for `fetch` from a service worker without it).

## Layout

| Path | Owns |
|---|---|
| `manifest.json` | MV3 declaration: `activeTab` + `scripting` + `storage`, gateway host permission, popup, service worker, the `content_scripts` entry for the listing page |
| `src/extract.js` | `extractVacancies(root)` - the DOM contract (`div[id^="job-item-"]`) |
| `src/inject.js` | The listing-page content script: the per-card `Scrape`/`Scraped` buttons. **Classic script** (no imports/exports) |
| `src/background.js` | The only network client: sign-in, token storage, the status lookup, the authenticated batch POST |
| `src/popup.html`, `src/popup.js` | Scrape the active tab, hand the batch to the worker, report the outcome |
| `README.md` | The same load-and-use steps as above, for an operator |

## Contract

- **The DOM contract is the design's**: `div[id^="job-item-"]` cards; `external_id`
  from `job-item-<id>`; title from `.job-item__position`; company from
  `[class*="text-gray-800"]`/`.company`; description from `.js-original-text` **first**
  (the `.js-truncated-text` preview is incomplete and only a fallback); `source_url`
  resolved with `new URL(href, baseURI)`.
- **One card may be dropped, never mangled**: a card without an id or without text is
  skipped and counted (`skipped`), because the gateway would reject the whole batch.
- **Capped at 25 cards** (`extractVacancies(root, { max })`), matching the gateway's
  `MAX_BATCH_SIZE`.
- **`extractVacancies` must stay self-contained.** The popup injects it with
  `chrome.scripting.executeScript({ func })`, which serialises the function *source*;
  a module-level helper or constant would arrive as `undefined` in the page. This is
  why the selectors and helpers live inside the function body.
- **`source_url` is always present** (`null` when the card has no link) so the payload
  shape is stable for validation.
- **The token lives in the service worker, not the popup.** The popup closes when it
  loses focus, so it only scrapes and reports; `background.js` performs the POST and
  keeps `gateway`/`token`/`user` in `chrome.storage.local`. A 401 forgets the token so
  the popup asks for a sign-in instead of retrying forever.
- Text extraction avoids `innerText`: jsdom does not implement it, and a
  layout-dependent value would make the scraper untestable.

## The injected per-card buttons (`src/inject.js`)

Loaded as a `content_scripts` entry (`https://djinni.co/*` + the `www` host, `document_idle`), so
it runs on every Djinni page and injects into whatever vacancy cards that page renders - the
jobs list **and** the dashboard/subscriptions pages (`/my/dashboard/subs`), which reuse the same
card component. A page with no cards (a vacancy's own detail page) simply gets nothing: the
script is a no-op there. It is a **classic script**: MV3 does not load an ESM content
script from the manifest, so this file must have no `import`/`export` (the test loads it the
way the browser does, with `window.eval`).

- **Two permissions, and they are not interchangeable.** `content_scripts.matches` makes
  Chrome *load* `inject.js` on the page; `host_permissions` is what lets
  `chrome.scripting.executeScript` (the `scrapeCard` path, and the popup's scrape) touch that
  tab. `activeTab` covers only the popup, because clicking the toolbar icon is what grants it -
  a button *on the page* is not a user invocation, so without the host permission a click fails
  with `Cannot access contents of the page...`. Both lists must name `djinni.co`; a test in
  `inject.test.ts` pins that.
- **Where the button goes**: inside the card (`div[id^="job-item-"]`), in the footer's action
  row - the row holding the site's own `Зберегти` / `Сховати` / copy-link controls. That row is
  found through the site's own `[data-job-id]` hook (on `button.copy-link-item`, the element
  its analytics reads); when that is missing, the footer block
  `div.d-flex.flex-column.gap-1` is the fallback. The button gets `margin-left:auto`, i.e. the
  footer's right bottom corner.
- **States**, readable on the element as `data-cvt-state`: `idle` (green `Scrape`, Bootstrap
  `btn-success`) → `busy` (`Scraping…`, disabled) → `done` (`Scraped`, an `<a>` to
  `<gateway>/?card=<job_id>`, `target=_blank`) or `error` (`Retry scrape`, the reason in the
  tooltip). The element is *replaced* between states, so `data-cvt-state` and `.cvt-scrape`
  are the only things to find it by.
- **A click never reaches the card.** The card itself opens the vacancy on any click, so the
  handler is registered in the capture phase and calls `stopPropagation()` (plus
  `preventDefault()` while it is still a button).
- **The content script never builds a vacancy payload.** It sends
  `{ type: 'scrapeCard', externalId }`; the *service worker* injects `extractVacancies` into
  the tab and takes that one card out of the result. One copy of the DOM contract
  (`extract.js`) is the whole point - and a card the board already knows turns into `Scraped`
  without a single request.
- **Three messages**, all handled by `background.js`:
  `{ type: 'cardStatus', externalIds: [...] }` → `{ ok, gateway, known }` (one request per
  page, through `GET /api/vacancies/status`, which is board-scoped);
  `{ type: 'scrapeCard', externalId }` → `{ ok, jobId, gateway, created, duplicates }`; and
  the incoming `{ type: 'boardChanged' }` - sent to every tab after the popup publishes a
  batch with `created > 0`, so the buttons stop offering `Scrape` for cards the popup just
  created.
- **The buttons survive the site's own htmx swaps**: a `MutationObserver` (200ms debounce)
  re-injects into any card that lost its button - favouriting, hiding and infinite scroll all
  replace cards in place. "Not signed in" is a normal state: the buttons stay `Scrape`.

## Tests

The scraper and the injected buttons run where the JS tests already live - the backoffice's
vitest, with jsdom:

```sh
cd backoffice; npm test
#   src/lib/scraper.test.ts   <- extract.js,            fixture djinni-listing.html
#   src/lib/inject.test.ts    <- inject.js, window.eval, fixture djinni-card-footer.html
```

`inject.test.ts` loads the content script exactly as the browser does (`window.eval` inside a
jsdom page with a fake `chrome.runtime`), so the DOM hooks, every state, the click → message →
`Scraped` link flow and the htmx re-injection are asserted against the live card markup.

The fixtures are trimmed copies of what the site actually renders (the listing sample from the
design document, and the pasted card footer), so a change to the selectors has to face the
markup they were written against. There is no test harness for `background.js`/`popup.js`:
they are thin glue over `chrome.*` APIs, and their outcome is verified end-to-end (popup or
button -> gateway -> queue depth -> board). Their syntax and import graph are still checked,
with the esbuild that ships in `backoffice/node_modules`:

```sh
cd backoffice; npx esbuild ../extension/src/*.js --bundle --platform=browser --format=esm --outdir=$env:TEMP/ext-check
```

## Deliberately missing (it is a POC)

- One site profile only (Djinni's markup). Another site needs its own selectors, not a
  generic "config-driven" engine.
- No pagination/infinite-scroll walking: it scrapes what is rendered on the page.
- Buttons follow the cards: every Djinni page that renders one gets them (`https://djinni.co/*`),
  a page that renders none gets nothing. The scope is the whole host on purpose - the
  dashboard (`/my/dashboard/subs`) lists vacancies with the same card markup as `/jobs`, and a
  narrower path pattern silently missed it (2026-09-26); the manifest patterns are pinned by a
  test in `inject.test.ts`.
- A button never re-runs a vacancy the board already has; a new `CV_VERSION` is the way to
  tailor one again.
- No chrome.storage sync/encryption for the token (it is an 8h session token).
- Not published to the Web Store.

## Don't

- Add a build step, a bundler or a `package.json` to this directory.
- Move the `fetch` back into the popup, or store credentials anywhere but
  `chrome.storage.local`.
- Reference module-level state from inside `extractVacancies`.
- Add `import`/`export` to `src/inject.js` (a manifest `content_scripts` file is a classic
  script) or give it a second copy of the scraping selectors - it asks the worker, which runs
  `extractVacancies`.
- Drop `djinni.co` from `host_permissions` (or from `content_scripts.matches`): one makes the
  buttons not appear, the other makes every click fail with a permission error.
- Loosen the payload shape the gateway validates (see `backoffice/src/lib/vacancies.ts`).
