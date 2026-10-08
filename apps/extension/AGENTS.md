# apps/extension/ - the vacancy scraper (Chrome MV3)

The producer at the head of the pipeline: it turns *one listing page* into a batch of
vacancies and hands it to the backoffice gateway, which publishes one AMQP message per
vacancy. It replaces the "Chrome extension -> Vercel gateway" hop of the source design;
the gateway is now `apps/backoffice/src/pages/api/vacancies/batch.ts`
(`CONSTITUTION.md` D12).

It has two entry points, and both end in the same gateway call:

* the **popup** (on demand) - scrape every card on the page and queue the batch;
* an **injected per-card button** (`src/inject.js`, a `content_scripts` entry) - one
  vacancy at a time, right where the vacancy is, showing `Scrape` or `Scraped` (a link to
  that card on the board).

Read `CONSTITUTION.md` first. The batch contract it must satisfy is documented in
`apps/backoffice/AGENTS.md`; the worker that consumes the result is `apps/worker/agent/AGENTS.md`.

## Scrapers are plugins (the site registry)

A **site is a plugin**: one module in `src/sites/` binding a slug, the hosts it owns, the content-script
behaviour it needs, and the **strategy** its pages are read with. `src/sites/index.js` is the registry - it
routes a URL to a plugin (`siteForUrl` / `siteForPage`), answers by stored slug (`siteForSlug`), and
validates the whole set at load. Nothing else in the extension names a site: `background.js` asks it for
`resumes.source` and for the plan to inject, `popup.js` for the plan to read the operator's page with,
`indeed/sweep.js` for both.

```js
// src/sites/djinni.js - a binding, in full
export const djinni = {
  slug: 'djinni',         // resumes.source: half of the vacancy's business key
  hosts: ['djinni.co'],   // exact match, plus any '.'-suffix subdomain
  buttons: 'cards',       // which content script the manifest wires ('cards' | 'pane' | 'none')
  sweep: false,           // does "Scrape & queue this page" walk the page? (Indeed is the only yes)
  plan: CARD_LIST,        // the strategy (src/sites/plans.js)
};
```

**The strategy is data, and that is forced rather than chosen.** The reading happens *inside the page*,
and the only way in is `chrome.scripting.executeScript({ func })`, which serialises the function's
**source** - so an injected reader cannot close over a module - while `args` are structured-cloned, so a
function cannot be handed to it either. Selectors travel; code does not. One executor (`src/extract.js`,
which is why its DOM toolkit stays *inside* that function) interprets the plan, and the plugin is what
supplies it. `sites.test.ts` runs `structuredClone` over every plan for exactly this reason.

Three kinds exist (`src/sites/plans.js`); a new **shape** is a new reader in `extract.js`, while a new
**site** on a shape we know is a binding and nothing else:

| kind | the page | used by |
|---|---|---|
| `cards` | a listing whose cards *are* the vacancies | `djinni`, `dou`, and the fallback for an unlisted site (`other`) |
| `job-page` | the whole vacancy is on the job page | `greenhouse`, and `teamtailor` (the filler only) |
| `pane` | the cards carry a snippet and one pane holds the selected vacancy's text | `indeed` |

Adding a site costs: the module (bind an existing strategy when the mark-up is one we already know, as
`dou.js` does) + a manifest entry and host permission for *every* host it claims + nothing else - two guards
in `sites.test.ts` fail until the manifest matches the declaration and the board can name the slug. A
`buttons: 'none'` site needs that entry too, for the **form filler** rather than for a scraper: that is the
whole wiring of a Greenhouse board and of a Teamtailor career page. The
registry is the extension's copy of `apps/worker/scout/sources.py`: one module per site, routed by host,
validated at load.

## Greenhouse boards (the `job-page` strategy)

`job-boards.greenhouse.io`, its EU twin `job-boards.eu.greenhouse.io` and the older
`boards.greenhouse.io` behave unlike the two Ukrainian sites, in both halves of the extension:

- **A job page *is* the vacancy.** There is no listing markup to read, so `extractVacancies` falls
  back to `greenhouseJobPage`: the id comes from the URL (`/<board>/jobs/<id>`, the same shape the
  gateway derives from a pasted link), the title from the `h1`, the company from the `<title>`'s
  "... at <company>" (falling back to the board's path segment) and the text from
  `.job__description`. The registry routes these hosts to the `greenhouse` plugin, whose slug is a legal
  `resumes.source` value.
- **That page carries the button, because that is where the vacancy is.** The plugin declares
  `buttons: 'cards'` - the *manifest wiring*, not a card count - and `src/inject.js` finds no
  `div[id^="job-item-"]` here, so the **page** becomes the unit its control belongs to: the id from the
  URL, the button inserted right after the `h1`. The gate is `JOB_PAGE.marker` plus that id, so a bare
  board (which carries the markup but names no job) gets nothing at all. Verified live 2026-10-08 on
  `job-boards.greenhouse.io/cresteo/jobs/4740438005`.
- **Its application form carries no `name` attribute anywhere** and its four react-select
  dropdowns are `role="combobox"`, which is why the annotator keys on `id` as well and gives a
  `role="combobox"` a kind of its own (the rules below): the filler opens such a widget and clicks
  the option the plan named, because the widget renders its list only while open and no option list
  can travel in a snapshot. The labels are real (`label[for]`) - except on the two upload
  controls, whose own label is the hidden text of the *button* ("Attach"): the question lives on
  the enclosing `role="group" aria-labelledby="upload-label-<field>"`, which `questionFor` reads
  before the control's own label.
- **The resume goes through `assignFile` on a plain `input[type=file]`** - Greenhouse has none of
  Djinni's custom-widget ceremony. The button is only what the operator clicks; the hidden input
  behind it (`#resume`, `class="visually-hidden"`) takes the File list and fires the two events,
  and pinning it (`Pin the resume field`) is what points the run at it unambiguously.
- **The cover letter is a two-step the operator does by hand.** The form shows no letter field
  until the site's own "Enter manually" is clicked, so the letter is pasted into the textarea that
  reveals - pin it (`#cover_letter_text`) once it is on the page. Nothing in the extension clicks
  that toggle: a hidden control is never the run's to touch.
- **Discovery stays `scout`'s job.** The extension only inherits the batch contract
  (`source: "greenhouse"`, id = the numeric job id) for a page the operator queued by hand; a
  board-wide feed is a parser module in `apps/worker/scout/parsers/` plus its URL in `SCOUT_FEEDS`, not a
  scraper here.

## The MyGreenhouse portal (badges only)

`https://my.greenhouse.io/jobs/search?…` is Greenhouse's **job-seeker** portal, not a company board:
its tiles link out to the boards above, so every vacancy it lists is one of *those* boards' jobs. It
gets a content script of its own - `src/mygreenhouse.js`, its own `content_scripts` entry - and that
script does exactly one thing: it stamps each tile with a `Scraped` / `Not Scraped` pill.

- **No scrape action, deliberately.** The tile's markup is not the vacancy (the text is on the board
  page the link points at), so a scrape here would have to open that board first - which is what
  clicking the tile already does, and where the extension *does* put its own button: a Greenhouse board
  gets `Scrape`/`Scraped` beside the job title. A badge is the honest thing to put on a listing you
  cannot read.
- **...and therefore not the `inject.js`/`formfill.js` entry.** `inject.js` looks for
  `div[id^="job-item-"]` cards and `formfill.js` for an application form; the portal renders neither,
  so sharing their entry would put two observers on a page with nothing for them to find.
- **The status question names its source.** `{ type: 'cardStatus', externalIds, source: 'greenhouse' }`
  - the message `inject.js` sends, plus an explicit `source`. This is the one place outside the
  registry that names a site (invariant 35), and it is forced: `cardStatus` otherwise derives the slug
  from the *tab's host*, the portal's host is deliberately not one the `greenhouse` plugin claims
  (those are the three boards an operator scrapes and fills on), so the derived answer would be
  `other` - a different `resumes.source` space - and every badge would be grey whatever the board
  held. `cardStatus` honours a message's own `source` over the tab's, and `mygreenhouse.test.ts`
  asserts the constant resolves through `siteForSlug`, so a renamed slug fails the suite instead of
  going quiet.
- **The DOM contract** (verified against the live page 2026-10-08): a tile is
  `div[data-provides="search-result"]`, and the vacancy is the first anchor inside it whose `href`
  matches `/jobs/<board>/<numeric-id>` - that number is the board's own job id, i.e. the
  `external_id` a board scrape of the same vacancy stores, which is the whole reason a badge is
  possible. The pill is absolutely positioned at the tile's bottom-left (`bottom: 14px;
  left: 16px`), clear of the site's own bell button (`absolute right-6 top-5`), and carries no
  click handler. A tile whose link names no job simply gets none.
- **Inertia re-renders the list** on every filter/pagination change, so a debounced
  `MutationObserver` (250 ms - the strategy `inject.js` uses for htmx) re-scans, one scan at a time:
  rendering a badge is itself a DOM mutation, and overlapping scans would each ask for the ids the
  other is already asking about. The popup's `boardChanged` message clears the cached answers, so a
  batch scrape is reflected without a reload. "Not signed in" is a normal state - the badges still
  appear, as `Not Scraped`.

## Teamtailor career pages (the `job-page` strategy, filler only)

An employer's own career site on Teamtailor (`careers.blackbird-lab.com` today) is the second half of
the story Greenhouse's boards tell: the vacancy's Apply button leaves DOU, the card is still
`dou`/`353314`, and the filler resolves the page by the cards' own **Application URL** - so the host
must be granted or Populate answers *"no form filler on it - reload the page"* (the live failure that
added this plugin, 2026-10-07).

- **The form is an overlay the page fetches into itself** - `<div
  data-controller="careersite--jobs--form-overlay"` with a
  `data-…-job-application-url-value="…/applications/new"` - a turbo-frame/dialog in the *same*
  document. So the operator's sequence is Apply, then **Pick the form** on the overlay, then Populate.
  Nothing here crosses a document boundary: the page's two `<iframe>`s are its chat messenger.
- **No buttons, and nothing to scrape.** `buttons: 'none'` leaves `src/inject.js` silent - its gate is
  Greenhouse's `JOB_PAGE.marker`, which these pages do not carry (their form is an overlay in the same
  document) - and `JOB_PAGE` is bound honestly rather than opportunistically: the reader refuses a page
  whose marker or description it cannot find and answers *no vacancies* (`mode: 'job-page'`) instead of
  a mangled card. A button here would therefore only ever offer a click that answers *that card is not
  on this page any more*.
- **Only the verified host is claimed.** Teamtailor also serves customers at
  `<company>.teamtailor.com`, which nobody has injected into yet; a second host is one more `hosts`
  entry plus one more manifest grant, and a claim nobody injects into only *looks* right.

## Indeed's job feed (a fourth page shape, and the only pane-driven one)

`*.indeed.com` cannot be read like the others, because **the cards carry no description**. The feed
is two panes - a card list on the left, the selected vacancy in a pane on the right - and exactly one
description exists on the page at a time (live page 2026-10-05: 12 `div.cardOutline` cards, one
`[data-testid="viewjob-main-content"]`):

- **`extractVacancies` reads the *selected* vacancy, not a list.** The id comes from the **pane's own
  `fromjk`** (the highlight - `div.cardOutline.vjs-highlight` → `a[data-jk]` - is only the fallback for
  a layout that renders no `fromjk`), the prose from `div.simple-job-description-html`, and the
  title/company from whichever element *named* the vacancy: the pane, or the card when the fallback
  was used. That order is load-bearing - the highlight moves a beat before the pane's text does, so an
  id taken from the card can end up over the previous vacancy's body. `source_url` is rebuilt as the
  stable `/viewjob?jk=<jk>`. The result says which shape it read: `mode` is `cards` | `greenhouse-job` |
  `indeed-pane` | `none`.
- **This is the one shape where a snippet must never become a description.** The cards would each
  yield a snippet (`attribute_snippet_testid`, `salary-snippet-container`), so a pane-less Indeed page
  yields **nothing** instead of twelve half-vacancies - `scraper.test.ts` pins that, and it is why the
  popup says *"this queued the vacancy in the right pane"* rather than reporting one card as if the
  page had been scraped.
- **`src/indeed.js` is its own content script** (a second manifest entry, not `src/inject.js`:
  different site, different mechanic, and `inject.js` is already Djinni/DOU's card markup). Its button
  selects the card - a *synthetic* click on `a[data-jk]`, because that link is `target="_blank"` and a
  trusted click would open a tab - then waits (250 ms polls, up to 15 s) for the pane to be **ready to
  read** before asking the worker to extract. "Ready" is two things at once, and both are load-bearing:
  the pane must **name that job itself** (its own `fromjk`), and it must have **rendered its
  description**. Waiting on the highlight alone was this shape's first live bug - Indeed moves the
  highlight and re-renders the pane's links *before* the text arrives, so a 3 s wait handed the worker
  an empty pane and it answered *"that card is not on this page any more - reload and retry"*
  (2026-10-05). **A pane that never becomes ready is a reported error, never a scrape of the wrong
  job** - the order is what makes the result trustworthy.
- **That click may only ever select.** Indeed's own handler has to run - it is what swaps the pane - but
  it is equally free to open the posting, which is right for a human's click and a tab per card for a
  sweep. So `select()` cancels the anchor's own action (`preventDefault` on the dispatched event) *and*
  mutes `window.open` for the duration of the dispatch: the second guard is what covers the handler,
  which `preventDefault` cannot reach (live bug 2026-10-05: "the autoscraper opens vacancies"). Both are
  pinned by a test that spies on `window.open` and on the event.
- **The button gets its own strip at the bottom of the card** (`placeButton`): a full-width flex row
  (`div.cvt-scrape-row`, `justify-content:center`) appended to the block that holds the site's own action
  row. It used to sit *inside* `.ctaContainer` with `margin-left:auto` - the right end of Indeed's
  save / not-interested icon row, the far corner from where the card's text ends (operator request
  2026-10-05). `.ctaContainer` is now only what *finds* that block, which stays locale-independent
  unlike the icons' `aria-label`s (`Guardar oferta` exists only in a translation table, never as an
  element to key on). The strip is **appended**, never inserted before Indeed's empty trailing
  placeholder, so it is the last thing in the card's content: the test asserts both `lastElementChild`
  and that the button is not inside `.ctaContainer`.
- **The `indeed` plugin owns every `*.indeed.com`.** One slug on purpose: Indeed's `jk` is
  unique across the country sites, so `pt`/`www`/`uk` are a single id space, and a per-country slug
  would fork one vacancy into as many cards.
- **There is no feed to read, and that is not an oversight.** `/rss` serves nothing and `robots.txt`
  disallows `/rss` and `/*?rss` for `User-agent: *`; the old Publisher Job Search API host
  (`api.indeed.com`) no longer resolves; every HTML path answers 403/401 to a non-browser client. So
  Indeed is browser-scrape-only: no `scout` parser can exist for it, and nothing unattended may touch
  it (`CONSTITUTION.md` invariant 34).
- **"Scrape & queue this page" walks the feed.** One description at a time is exactly why the popup's
  one-shot read cannot serve Indeed, so there it becomes a *sweep*: `src/indeed/sweep.js` walks the
  page's cards - the content script selecting each one over `indeedCards`/`indeedSelect` - reads each
  pane with the same `extractVacancies`, and publishes the lot as one batch, chunked at the endpoint's
  25-card cap. The walk lives in the **service worker** (a popup closes the moment it loses focus, and
  a dozen cards take tens of seconds): the popup starts it and then polls `scrapeProgress` once a
  second, exactly as it follows a form fill. A card whose pane never becomes readable is counted and
  skipped, never guessed at - and `sweep.js` knows no selector at all.
- **The sweep skips the cards the board already has** (`knownIds`, the board's own status lookup): it
  never selects them, because doing so flickers the feed through vacancies nobody needs and would only
  re-publish them as duplicates. That is the rule a per-card button already follows - a `Scraped` card
  offers no scrape (live bug 2026-10-05). A lookup that fails walks everything rather than refusing to
  run: the publish that follows reports the real problem.

## The form filler (`Populate`)

The second half of the extension: on a vacancy page it fills the application form from what the
board already knows. The click sequence is `Populate` in the popup -> snapshot -> board -> plan ->
write into the page. Four rules shape it, and all four are about not guessing:

1. **The form is picked, never guessed.** `Pick the form` puts the page into a crosshair mode: the
   operator clicks the form (Djinni's dialog, DOU's area below Apply) and the selector is stored per
   **host** in `chrome.storage.local.formRecipes`. The two fields that must be exactly right can be
   pinned the same way (`Pin the letter field`, `Pin the resume field`), which takes them out of the
   model's hands entirely. **A board's hosts usually render one form**, so the popup's **Save as
   default** copies this host's whole recipe (the root *and* both pins) to its **job board** in
   `chrome.storage.local.formDefaults`, keyed by the registry's slug
   (`sites/index.js::boardKeyForUrl`): one pick then covers `job-boards.greenhouse.io`,
   `job-boards.eu.greenhouse.io` and `boards.greenhouse.io`, and Djinni's dashboard inherits what
   `/jobs` taught. `recipeFor()` asks the host first, so a later pick on one host still wins for that
   host - a default is a fallback, never an override - and an unlisted host is its own board (the
   `other` slug belongs to every unknown site, so a *default* must not be shared through it). The
   button is enabled only when this host holds a pick of its own (there is nothing to widen
   otherwise), and `Forget this site` drops the host pick and the board default together.
2. **The model never sees a selector - and never sees a document.** The page annotates every
   fillable control with a deterministic `data-cvt-id` (f1, f2, ... in DOM order) and the worker
   sends that snapshot to the board, which queues it on `applications.draft` (`apply.py`). The plan
   comes back keyed by those ids; the generated **cover letter and tailored PDF are inserted
   locally** by `formfill.js` from `GET /api/cover/<job_id>` and `GET /api/artifacts/<job_id>`, so
   the plan only ever says *which element* each belongs in (`cover_letter` / `resume_file`, always
   with an empty value).
3. **A missing fact is skipped, never invented.** The prompt may use the vacancy, the candidate
   facts (`application_profile`) and the CV digest; anything else is `skip` + a reason, and the
   review panel lists it. Nothing is submitted by the extension - not the form, not a consent
   checkbox, not the site's own template controls. The extension does not edit the facts: they are
   the **card owner's** row, rendered read-only on the board's `/sources` page and loaded in bulk by
   `scripts/seed_profile.py` (the popup's *Candidate facts* editor was removed 2026-10-03), and the
   same row grounds the CV and the cover letter too (`CONSTITUTION.md` invariants 25/31).
4. **The card is resolved twice, never guessed.** `form/worker.js` asks the page's own vacancy id
   first (`GET /api/vacancies/status`, the same lookup the per-card buttons use) - and **which part
   of that URL is the id is the site's own fact** (`sites/<site>.js`'s `urlId`, read by
   `vacancyIdFromUrl`: Djinni `/jobs/<id>`, DOU `/vacancies/<id>`, Greenhouse `/jobs/<id>`, Indeed
   `?jk=`), because the flow used to hard-code `/jobs/` and every DOU page therefore answered "no
   id" (card `375802`, 2026-10-07). When that finds nothing it asks **which card this page is**
   (`GET /api/vacancies/link?url=…`) - the lookup that matches the page URL against the cards' own
   **application URL** (`resume_board.apply_url`, set on the card in the board's Details block: a
   DOU/Djinni vacancy whose Apply button opens the employer's ATS page keeps `dou`/`351812` as its
   identity, so nothing on the board carries that Greenhouse job number). That field is **optional**:
   it only ever matters for a page that left the site, which is exactly the case the id cannot
   answer. **The id lookup answers for the board's *current* `CV_VERSION`** (the business key
   `resumes_job_key_idx` includes it), so a card scraped under another version is not found by id and
   this fallback is forced for it - the `v1`/`v2` twin rows in the live database are exactly that
   (2026-10-07). Bumping `CV_VERSION` is therefore a *Populate* regression, not only a re-tailoring
   one. Neither match stops the run with *"this page is not linked to a card yet"* - the popup
   then says `Matched this page by Application URL` when the second lookup answered, because there
   is nothing else that would tell the operator the connection worked. The lookup needs no manifest
   change (the ATS host has to be in `host_permissions`/`content_scripts` already, or there is no
   filler on the page at all), and nothing is written to the page before a card is known.

Constraints worth knowing: the site's submit button is never clicked; `input[type=hidden]`,
`password` and disabled fields are not annotated at all; a radio/checkbox group is one field with N
options (the site's own labels, e.g. `Так`/`Ні`); a control is identified by its `name` **or** its
`id` - a React form keeps the value in JS state and renders no `name`, which is how Greenhouse's
whole application was invisible to the first version of this rule - and only the box a widget
generates for itself is dropped (TomSelect's unnamed `#tomselect-1-ts-control` inside its own
`.ts-wrapper`, never the `<select>` it hides, which keeps its `name` and stays annotatable);
`required` counts whether it is the attribute or `aria-required`, on the control or on the group
around it; a control a script owns (`role="combobox"`, react-select and friends) is reported as
kind `combobox`, which the applier never types into - it **opens the widget and clicks the option**
the plan named (`chooseCombobox`: the four gestures that open one tried in turn, the label matched
against the options the open menu rendered, the widget's own search box as the filter for a long
list, and the committed value verified before the field counts as filled); the snapshot is hashed
by the board, so re-Populating the
same rendered form costs no Gemini call while a changed form (or newly saved candidate facts)
re-drafts.

**One click is not one step.** A fill can take a minute - KEDA scaling a queue pod from zero, one
Gemini call, two document fetches - so the popup's status follows the run instead of claiming to be
snapshotting for all of it: `form/worker.js` records the step it is in, the popup polls it once a
second (`{ type: 'phase' }` -> `{ ok, phase }`) and `src/form/phases.js` words it, with the run's
elapsed seconds appended. While the draft is being written the label follows the **board's own**
`queued`/`running` status, which is the half the extension cannot see.

## Load it (unpacked, no build step)

There is deliberately no bundler and no `package.json`: three small files Chrome can
load as-is.

1. `chrome://extensions` -> enable **Developer mode** -> **Load unpacked** ->
   select this `apps/extension/` directory.
2. Start the backoffice (`npm run dev` in `apps/backoffice/`, see `apps/backoffice/AGENTS.md`),
   sign in once in the browser tab.
3. Open a vacancy listing page (e.g. `djinni.co/jobs/`), click the extension icon,
   enter the gateway URL (`http://localhost:4321`), your provisioned email/password,
   **Sign in**, then **Scrape & queue this page**.
4. The popup reports `Created N card(s) in Scraped.` -- and nothing is queued: the gateway
   creates one row per vacancy and stops there (`apps/backoffice/AGENTS.md`, invariants 16 and 23
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
| `manifest.json` | MV3 declaration: `activeTab` + `scripting` + `storage`, gateway host permission, popup, service worker, the `content_scripts` entries (the listing pages' buttons, Indeed's feed, the MyGreenhouse portal's badges). **Tracked source** (`.gitignore` negates `*.json` for it): a clone must load unpacked, and `apps/backoffice/src/lib/inject.test.ts` asserts `host_permissions` covers every `content_scripts` match - a manifest that is only on one machine fails that test on CI |
| `src/extract.js` | `extractVacancies(root, options)` - the **one page reader**, which is why it is a single self-contained function. Takes a strategy (`options.plan`) and interprets its `kind`; the result echoes it in `mode` (`cards` \| `job-page` \| `pane` \| `none`) |
| `src/sites/index.js` | The **registry**: routes a URL to a plugin, answers by slug, and validates the set at load (a duplicated slug or host is refused) |
| `src/sites/plans.js` | The three **strategies** - `CARD_LIST`, `JOB_PAGE`, `PANE` - as selector data, because a plan crosses into the page and a function cannot |
| `src/sites/<site>.js` | One **plugin** per site: slug + hosts + content-script behaviour + the strategy it binds to (`djinni`, `dou`, `greenhouse`, `indeed`, `teamtailor` - the last one for the filler alone) |
| `src/inject.js` | The button content script (classic): `Scrape`/`Scraped` on the `cards` sites - per card on Djinni/DOU, and beside the job title on a board that renders no cards (Greenhouse) |
| `src/mygreenhouse.js` | The MyGreenhouse portal's content script (classic, its own `content_scripts` entry): the `Scraped`/`Not Scraped` **badges** on `my.greenhouse.io` tiles. Read-only - no scrape action, no scrape selectors of its own, and its one status message names the `greenhouse` source |
| `src/indeed.js` | The Indeed content script (classic, its own `content_scripts` entry): the same buttons, but a click first selects the card and waits for the pane - the only shape where the text is not in the card. Also answers the sweep's two messages (`indeedCards`, `indeedSelect`) |
| `src/indeed/sweep.js` | The whole-feed walk behind the popup's **Scrape & queue this page** on Indeed: select each card, read its pane, publish one batch. Runs in the worker (the popup cannot hold a 30-second loop) and knows no selector |
| `src/formfill.js` | The form filler (a second `content_scripts` entry, also classic): the HITL picker, the deterministic annotator, the snapshot, the applier and the per-site adapters |
| `src/form/plan.js` | Pure plan plumbing: the pins overriding the model, which documents a plan needs, and the popup's report |
| `src/form/worker.js` | The flow, as a module `background.js` delegates to: snapshot -> `POST /api/apply/<job_id>` -> poll -> fetch the letter and the PDF -> apply, recording the phase of each step |
| `src/form/phases.js` | The progress vocabulary: the step list and the one-line label the popup ticks through while a fill runs (pure, unit tested) |
| `src/background.js` | The only network client: sign-in, token storage, the status lookup, the page->card lookup (`cardForUrl`), the authenticated batch POST, and the form filler's messages (`pickForm`, `formRecipe`, `saveFormDefaults`, `clearFormRecipe`, `populate`, `phase`) |
| `src/popup.html`, `src/popup.js` | Scrape the active tab, hand the batch to the worker, report the outcome. On a page whose URL names its vacancy (`vacancyIdFromUrl`) it also checks on open whether the board already has it, and disables *Scrape & queue this page* for one that is there |
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

## The injected buttons (`src/inject.js`)

Loaded as a `content_scripts` entry by host (`document_idle`), so it runs on every page the manifest
lists for it - Djinni (the jobs list and the dashboard/subscriptions page `/my/dashboard/subs`, which
reuses the card component), DOU, the three Greenhouse boards and the Teamtailor career host - and works
on the **unit** a button belongs to:

- **a listing card**: Djinni and DOU. One vacancy per `div[id^="job-item-"]`, and its `id` is the
  external_id.
- **the page itself**: a board that renders no cards at all, i.e. Greenhouse. The whole page is one
  vacancy, so the id comes from its URL (`/jobs/<digits>`) and the button lands beside the job's `h1`.

A page that is neither gets nothing at all (Teamtailor: `buttons: 'none'`, and none of Greenhouse's
markup). It is a **classic script**: MV3 does not load an ESM content script from the manifest, so this
file must have no `import`/`export` (the test loads it the way the browser does, with `window.eval`).

- **Two permissions, and they are not interchangeable.** `content_scripts.matches` makes
  Chrome *load* `inject.js` on the page; `host_permissions` is what lets
  `chrome.scripting.executeScript` (the `scrapeCard` path, and the popup's scrape) touch that
  tab. `activeTab` covers only the popup, because clicking the toolbar icon is what grants it -
  a button *on the page* is not a user invocation, so without the host permission a click fails
  with `Cannot access contents of the page...`. Both lists must name `djinni.co`; a test in
  `inject.test.ts` pins that.
- **Where the button goes**: inside a card, in the footer's action row - the row holding the site's own
  `Зберегти` / `Сховати` / copy-link controls. That row is found through the site's own `[data-job-id]`
  hook (on `button.copy-link-item`, the element its analytics reads); when that is missing, the footer
  block `div.d-flex.flex-column.gap-1` is the fallback. The button gets `margin-left:auto`, i.e. the
  footer's right bottom corner. A one-vacancy page has no such row: the button is inserted immediately
  after the `h1` (or into the marker block, when the layout renders no title), with a plain margin.
- **One selector is copied into this file, and pinned.** `#application-form, .job__description` *is*
  `JOB_PAGE.marker` (`sites/plans.js`), carried here because a classic content script cannot import the
  registry - and it is a **placement** gate, never a reading one (`extract.js` does the reading; this
  file only says which vacancy a control stands for). The URL id is required as well, which is what
  separates one vacancy's own page from the bare board that carries the same markup.
  `inject.test.ts` asserts the copy against the strategy and both halves of the gate - a marker without
  an id, and a URL id without the marker, each pinning "no button".
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
  page, through `GET /api/vacancies/status`, which is board-scoped; an optional `source` in the
  message overrides the slug the sender's own host would name - the MyGreenhouse badge is the only
  caller that sends one, and that section explains why);
  `{ type: 'scrapeCard', externalId }` → `{ ok, jobId, gateway, created, duplicates }`; and
  the incoming `{ type: 'boardChanged' }` - sent to every tab after the popup publishes a
  batch with `created > 0`, so the buttons stop offering `Scrape` for cards the popup just
  created.
- **The buttons survive the site's own swaps**: a `MutationObserver` (200ms debounce) re-injects into
  any unit that lost its button - favouriting, hiding and infinite scroll all replace cards in place,
  and a board page's title block is re-rendered by React. "Not signed in" is a normal state: the
  buttons stay `Scrape`.

## Tests

The form filler's DOM work is verified **by hand** (`apps/extension/README.md` has the checklist) - a
deliberate choice, not an oversight: jsdom has no `DataTransfer`, so `input.files = ...` cannot be
asserted in CI, and no `elementFromPoint`, which is why the picker reads `event.target` and the file
assignment sits behind `assignFile()`. What *is* checked automatically: the import graph
(`npx esbuild ../extension/src/*.js ../extension/src/form/*.js --bundle`), the syntax of the two
classic scripts (`node --check`), and the pure helpers (`form/plan.js`, `form/phases.js` -
the progress wording has its own vitest, `apps/backoffice/src/lib/form-phase.test.ts`).

The scraper and the injected buttons run where the JS tests already live - the backoffice's
vitest, with jsdom:

```sh
cd apps/backoffice; npm test
#   src/lib/scraper.test.ts   <- extract.js,            fixtures djinni-listing.html,
#                                                       greenhouse-job.html, indeed-feed.html
#                                 (each page read with the plan of the site that owns it, so the
#                                  tests exercise the real plugins)
#   src/lib/sites.test.ts     <- the registry: routing, validate(), structured-cloneable plans, the
#                                 manifest wiring and the board's labels (both pinned against it)
#   src/lib/inject.test.ts    <- inject.js, window.eval, fixture djinni-card-footer.html + the inline
#                                 one-vacancy page (Greenhouse's job page, where the page is the unit)
#   src/lib/mygreenhouse.test.ts <- mygreenhouse.js (eval too), tiles inline: both badge states, the
#                                 one-per-page `cardStatus` with its explicit `source`, and the
#                                 re-scan after an Inertia list swap
#   src/lib/indeed.test.ts    <- indeed.js, window.eval, fixture indeed-feed.html (the whole live
#                                 feed: 12 cards + the one pane, so the select-then-wait rule, the
#                                 refusal to scrape the wrong vacancy and the sweep's two messages
#                                 are all pinned)
#   src/lib/sweep.test.ts     <- indeed/sweep.js with a fake chrome + publish: the walk's order, the
#                                 card it must never file the previous pane's text under, the batch
#                                 cap (asserted against the gateway's own MAX_BATCH_SIZE) and the
#                                 `running` flag that must never latch
#   src/lib/formfill.test.ts  <- formfill.js (eval too), fixture greenhouse-application-form.html
#   src/lib/form-worker.test.ts <- form/worker.js with a fake chrome + fetch: which card a page
#                                 resolves to (its own vacancy id, else its Application URL)
```

`inject.test.ts` loads the content script exactly as the browser does (`window.eval` inside a
jsdom page with a fake `chrome.runtime`), so the DOM hooks, every state, the click → message →
`Scraped` link flow and the htmx re-injection are asserted against the live card markup.
`formfill.test.ts` does the same for the filler: the real Greenhouse form is annotated and a plan
is applied to it, so the identity rule, the combobox click and both pin paths are pinned by
tests rather than by the manual checklist above (jsdom does no layout, so that file never reads
`field.hidden`).

The fixtures are copies of what the sites actually render (the listing sample from the design
document, the pasted card footer, and Greenhouse's job page with the real `#application-form`), so
a change to the selectors *or* to the annotator's rules has to face the markup they were written
against. There is no test harness for `background.js`/`popup.js`:
they are thin glue over `chrome.*` APIs, and their outcome is verified end-to-end (popup or
button -> gateway -> queue depth -> board) - their syntax and import graph are still checked,
with the esbuild that ships in `apps/backoffice/node_modules`. `form/worker.js` sits between them and
*is* covered (`form-worker.test.ts` fakes `chrome.tabs`/`chrome.storage` and `fetch`), because the
one rule that must never drift there is which card a page belongs to:

```sh
cd apps/backoffice; npx esbuild ../extension/src/*.js --bundle --platform=browser --format=esm --outdir=$env:TEMP/ext-check
```

## Deliberately missing (it is a POC)

- **Three strategies, not a general engine.** A plugin binds its site to one of the three readers above -
  it does not describe a site in the abstract, and a shape we have never seen is a new reader in
  `extract.js`, not a new key in a config. The one thing a plugin supplies itself is its selectors
  (`plans.js`), because that is the part only its own mark-up can answer for.
- No pagination/infinite-scroll walking: it scrapes what is rendered on the page.
- **The sweep walks what the page had when it was pressed.** Indeed's feed lazily renders more cards as
  the list scrolls, and the walk deliberately does not chase them - that would be a crawl, not a page.
  Scroll first, then press; the popup reports how many cards it skipped.
- **No automatic capture of where the Apply button lands.** The redirect only appears *after* the
  click (a new tab, a different host), so the connection is the operator's: paste the ATS URL into
  the card's *Application URL* and Populate works there from then on. A `tabs.onUpdated` +
  `openerTabId` listener could fill that in by itself, but an MV3 service worker is asleep most of
  the time and a wrong guess would link a card to the wrong posting - the manual field is the
  honest POC answer, and the lookup it feeds is already host-agnostic. **The field is not always
  needed**: a card whose own posting *is* the page being filled resolves by the id that page's URL
  carries (`urlId` in rule 4), which is why the board describes it as optional - only a page that
  left the site has to be connected by hand.
- Buttons follow the cards: every Djinni page that renders one gets them (`https://djinni.co/*`),
  a page that renders none gets nothing. The scope is the whole host on purpose - the
  dashboard (`/my/dashboard/subs`) lists vacancies with the same card markup as `/jobs`, and a
  narrower path pattern silently missed it (2026-09-26); the manifest patterns are pinned by a
  test in `inject.test.ts`.
- A button never re-runs a vacancy the board already has; a new `CV_VERSION` is the way to
  tailor one again.
- No chrome.storage sync/encryption for the token (it is an 8h session token).
- **A custom upload widget needs an adapter.** Djinni has no `input[type=file]` in its form: the resume is a TomSelect `select` fed by an htmx swap, so `src/formfill.js` drives the site's own "+ Додати резюме" control, fills the file input it renders and submits that fragment (`adapterFor`). DOU's plain file input needs none.
- **One picked root per host.** A site with a second, differently-marked-up apply page means picking again - not a code change.
- Not published to the Web Store.

## Don't

- Give `src/mygreenhouse.js` a scrape path, a `Scrape` button, or a copy of the scraping selectors:
  the portal's tiles are links to the boards, where `inject.js` already offers the button, and the
  tile's text is not the vacancy (the badge's explicit `source` is what keeps its read-only lookup
  honest - the one exception invariant 35 records).
- Copy another strategy selector into `src/inject.js`, or change `JOB_PAGE.marker` without the copy
  beside it: that one marker is pinned by `inject.test.ts` so it stays a single *placement* exception
  rather than a habit (the reading is `extract.js`'s, and the vacancy is the worker's answer).
- Add a build step, a bundler or a `package.json` to this directory.
- Move the `fetch` back into the popup, or store credentials anywhere but
  `chrome.storage.local`.
- Reference module-level state from inside `extractVacancies`.
- Add `import`/`export` to `src/inject.js` (a manifest `content_scripts` file is a classic
  script) or give it a second copy of the scraping selectors - it asks the worker, which runs
  `extractVacancies`.
- Drop `djinni.co` from `host_permissions` (or from `content_scripts.matches`): one makes the
  buttons not appear, the other makes every click fail with a permission error. The `greenhouse.io`
  patterns are the same trap in reverse: without a `content_scripts.matches` entry the filler is
  never injected, and without the host permission the popup cannot read the page at all.
- Loosen the payload shape the gateway validates (see `apps/backoffice/src/lib/vacancies.ts`).
- Scrape an Indeed card where it stands, or read the pane "as it happens to be": the card has no
  description and the page holds exactly one, so the wrong read files another vacancy's text under
  this card's id. Select the card, wait for the pane (`src/indeed.js`), then extract.
- Put Indeed's buttons in `src/inject.js`, or give `src/indeed.js` a second copy of the scraping
  selectors: the content scripts only *select* a card and send a message - `extract.js` is the one
  place that reads a vacancy, and the worker is the one that runs it.
- Give `src/indeed/sweep.js` a selector, or let it build a vacancy by hand: it walks and publishes, and
  every read goes through `extractVacancies` in the tab.
