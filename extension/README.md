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

4. The popup answers e.g. `Queued 12 message(s) on resumes.generate. Queue depth now
   12.` The cards are in **Created** straight away; each turns *Tailored* once the
   worker finishes (KEDA scales the worker 0 -> N).

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
`Authorization: Bearer <token>`. The response echoes `published`, `duplicates`,
`queue`, `depth` and the generated `jobIds`.

## Notes

- `host_permissions` allows `localhost:4321` / `127.0.0.1:4321`. For another gateway
  origin, add it to `manifest.json` and reload the extension.
- Cards without an id or without description text are skipped and reported; nothing is
  invented.
- At most 25 cards per click (the gateway rejects larger batches).
- The token expires after 8 hours; the popup then asks you to sign in again.
