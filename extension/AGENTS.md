# extension/ - the vacancy scraper (Chrome MV3)

The producer at the head of the pipeline: it turns *one listing page* into a batch of
vacancies and hands it to the backoffice gateway, which publishes one AMQP message per
vacancy. It replaces the "Chrome extension -> Vercel gateway" hop of the source design;
the gateway is now `backoffice/src/pages/api/vacancies/batch.ts`
(`CONSTITUTION.md` D12).

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
4. The popup reports `Queued N message(s) on resumes.generate.`; the cards appear on
   the board as the workers pick them up (KEDA scales 0 -> N).

`host_permissions` in `manifest.json` lists `localhost:4321` / `127.0.0.1:4321`. A
different gateway origin must be added there (Chrome does not allow a wildcard host
for `fetch` from a service worker without it).

## Layout

| Path | Owns |
|---|---|
| `manifest.json` | MV3 declaration: `activeTab` + `scripting` + `storage`, gateway host permission, popup, service worker |
| `src/extract.js` | `extractVacancies(root)` - the DOM contract (`div[id^="job-item-"]`) |
| `src/background.js` | The only network client: sign-in, token storage, the authenticated batch POST |
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

## Tests

The scraper is the one piece of real logic, and it runs where the JS tests already
live - the backoffice's vitest, with jsdom:

```sh
cd backoffice; npm test        # src/lib/scraper.test.ts, fixture: src/lib/fixtures/djinni-listing.html
```

The fixture is a trimmed copy of the design document's DOM sample, so a change to the
selectors has to face the markup they were written against. There is no test harness
for `background.js`/`popup.js`: they are thin glue over `chrome.*` APIs, and their
outcome is verified end-to-end (popup -> gateway -> queue depth -> board). Their syntax
and import graph are still checked, with the esbuild that ships in `backoffice/node_modules`:

```sh
cd backoffice; npx esbuild ../extension/src/*.js --bundle --platform=browser --format=esm --outdir=$env:TEMP/ext-check
```

## Deliberately missing (it is a POC)

- One site profile only (Djinni's markup). Another site needs its own selectors, not a
  generic "config-driven" engine.
- No pagination/infinite-scroll walking: it scrapes what is rendered on the page.
- No `content_scripts` auto-injection: injection is on demand from the popup.
- No chrome.storage sync/encryption for the token (it is an 8h session token).
- Not published to the Web Store.

## Don't

- Add a build step, a bundler or a `package.json` to this directory.
- Move the `fetch` back into the popup, or store credentials anywhere but
  `chrome.storage.local`.
- Reference module-level state from inside `extractVacancies`.
- Loosen the payload shape the gateway validates (see `backoffice/src/lib/vacancies.ts`).
