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

## Notes

- `host_permissions` covers **both sides**: the gateway origin (`localhost:4321` /
  `127.0.0.1:4321` - change it in `manifest.json` if you move the gateway) and `djinni.co`,
  which the per-card button needs in order to inject the scraper into the tab it was clicked
  in. Dropping either one shows up as a button that answers `Retry scrape`.
- Cards without an id or without description text are skipped and reported; nothing is
  invented.
- At most 25 cards per click (the gateway rejects larger batches).
- The token expires after 8 hours; the popup then asks you to sign in again.
