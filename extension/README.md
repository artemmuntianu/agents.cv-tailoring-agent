# Vacancy scraper (Chrome extension)

Scrapes every vacancy card on the current listing page and queues each one for CV
tailoring, through the local backoffice gateway. Load it unpacked - there is no build
step.

## Install (unpacked)

1. Start the backoffice and keep it running:

   ```sh
   # two other terminals:
   kubectl port-forward svc/postgres 5432:5432
   kubectl port-forward svc/rabbitmq 5672:5672

   cd backoffice; npm run dev        # http://localhost:4321
   ```

   Sign in once in the browser tab (`node scripts/user.mjs add ...` if you have no
   account yet).

2. In Chrome: `chrome://extensions` -> enable **Developer mode** -> **Load unpacked**
   -> pick this `extension/` folder.

3. Open a vacancy listing page (e.g. `https://djinni.co/jobs/...`), click the
   extension icon, and:

   - **Gateway**: `http://localhost:4321`
   - **Email / Password**: the account your administrator provisioned (there is no
     signup anywhere in this system)
   - **Sign in** -> the popup stores an 8h session token
   - **Scrape & queue this page**

4. The popup answers e.g. `Created 12 card(s) in Scraped.` Nothing is queued yet: the
   cards wait in **Scraped** until you drag one into **Prepare**, which is what queues the
   tailoring (KEDA then scales the worker 0 -> N, and the card turns *Tailored*).

## The `Scrape` button on every card

Once you are signed in, reload any Djinni page that lists vacancies - the jobs list
(`djinni.co/jobs/...`) or your dashboard/subscriptions page (`djinni.co/my/dashboard/subs`):
each vacancy card gets a green **Scrape** button in its footer, next to *Зберегти* /
*Скопіювати посилання*.

- **Scrape** puts that one vacancy on the board immediately (in **Scraped**) - it does not
  queue any work - so the button turns into **Scraped** the moment the gateway answers.
- **Scraped** is a link: it opens the board with that vacancy's card popped open
  (`http://localhost:4321/?card=<job_id>`), where you can move it, refuse it, or grab the
  tailored PDF/DOCX.
- If a scrape fails, the button says **Retry scrape** and the tooltip carries the reason
  (hover it).
- A vacancy the board already has never costs a request: the buttons ask once per page load
  which of the visible vacancies are known, and only the unknown ones offer **Scrape**.

The popup still works and is the only place to sign in: its *Scrape & queue this page* queues
every card in one batch (≤25). The per-card buttons are a convenience on top of it - and they
notice a batch scrape, so they stop offering `Scrape` for cards the popup has just queued.

Reload the extension on `chrome://extensions` after updating these files, then refresh the
listing page (the buttons are injected at page load).

## What it sends

```json
{
  "vacancies": [
    {
      "external_id": "848944",
      "title": "Platform Engineering Lead",
      "company": "UPPeople",
      "description_raw": "About the Role\nWe are looking for ...",
      "source_url": "https://djinni.co/jobs/848944/"
    }
  ]
}
```

`POST http://localhost:4321/api/vacancies/batch` with
`Authorization: Bearer <token>`. The response echoes `source`, `created`, `duplicates`
and the generated `jobIds`.

## Filling an application form (`Populate`)

Sign in, open the vacancy, click the site's own **Apply** so the form is on the page, then:

1. **Pick the form** (once per site): the page turns into crosshair mode - click the form itself.
   Djinni: the dialog Apply opens (`form#apply_form`). DOU: the area that appears below Apply.
   Greenhouse: the whole form the job page renders inline (`#application-form`) - and there its two
   steps are yours: click the site's own **Enter manually** on the Cover Letter control first (no
   letter field exists before that), then pin it, and pin the resume to the hidden upload field
   behind **Attach**. Escape cancels. Optional but recommended: **Pin the letter field** and
   **Pin the resume field**, the two places the generated documents must land, chosen by you rather
   than by the model.
2. Fill in **Candidate facts** (once): name, contacts, salary expectation, availability, work
   rights, English level. They live in the board's `application_profile` row for your account, which
   is what the worker reads, so they survive a browser reset.
3. **Populate.** The extension snapshots the form, asks the board to draft it (one Gemini call, on
   the `applications.draft` queue) and writes the answers into the page: the recruiter's questions,
   the cover letter into the message field, the tailored PDF into the resume field. What it could
   not answer is listed for you. The status line counts through the flow's own steps (*snapshotting
   the form* -> *sending the snapshot* -> *waiting for a worker pod* / *drafting with Gemini* ->
   *fetching the documents* -> *filling the form*), seconds included, so a cold queue pod reads as
   waiting rather than as a hang.
4. **Read the report, then submit the site's own form.** The extension never submits anything.

It says no, on purpose, when: the vacancy is not on the board yet (scrape and tailor it first), the
application page is not linked to a card (open the vacancy on the board and paste this page's URL
into its **Application URL** - see below), no cover letter has been generated (the report says so -
generate one on the card), the tailored PDF is not on the board's machine
(`storage-files.ps1 -Action download`, or point `OUTPUT_DIR` at the cluster volume), or the form was
re-rendered since the snapshot (run Populate again: the new form gets a new hash and a fresh draft).

**When Apply opens another site.** Many DOU/Djinni vacancies hand the application over to the
employer's own ATS: the Apply button opens `job-boards.eu.greenhouse.io/<board>/jobs/<id>` in a new
tab. That page has no vacancy id the board knows - the card is still `dou`/`351812` - so the
filler asks the board *which card this page is* and matches the URL against the cards' own
**Application URL**. Paste the page's address into the card's **Details -> Application URL** in the
board once (the tracking tail is dropped on save, so `?gh_src=…` never matters) and Populate works
there from then on; the popup confirms with *Matched this page by Application URL*. The ATS host
must be in `host_permissions`/`content_scripts` for the filler to be on the page at all.

Manual checklist after a change to `formfill.js` or `form/`: pick on both sites; populate a Djinni
form (answers + letter + PDF + report); populate a DOU form (letter + file); press Escape mid-pick;
run Populate twice on the same page (the second run reuses the draft, no second Gemini call); reload
the page mid-draft (the old snapshot is refused as stale rather than filled); paste an ATS page URL
into a card's Application URL and populate from that page (the card is found by URL, and it is
*not* found once the field is cleared again).

## Notes

- `host_permissions` covers **both sides**: the gateway origin (`localhost:4321` /
  `127.0.0.1:4321` - change it in `manifest.json` if you move the gateway) and the vacancy sites
  (`djinni.co`, `jobs.dou.ua`/`dou.ua`, and the three `greenhouse.io` boards), which the per-card
  button needs in order to inject the scraper into the tab it was clicked in. Dropping either one
  shows up as a button that answers `Retry scrape`.
- **Greenhouse is read one job at a time.** Its boards have no listing cards - the job page itself
  *is* the vacancy - so **Scrape & queue this page** queues exactly that job; discovery across a
  whole board is the scheduled `scout` job's business. Two things on its apply form stay yours: the
  Cover Letter field only exists after the site's own *Enter manually* is clicked, and the form's
  dropdowns are React widgets the extension does not type into - it lists them in the report.
- A change to `manifest.json` (a new host, a new permission, a version bump) is only visible after
  the extension is reloaded on `chrome://extensions`.
- Cards without an id or without description text are skipped and reported; nothing is
  invented.
- At most 25 cards per click (the gateway rejects larger batches).
- The token expires after 8 hours; the popup then asks you to sign in again.
