# docs/ (and the repo's documentation set) - documentation ownership

Each document has exactly one job. The per-layer `AGENTS.md` files are written for
agents; `CONSTITUTION.md` and `README.md` are written for humans. The rule that keeps
this honest is `CONSTITUTION.md` section 8: when code and prose disagree, the code wins
and the disagreement is recorded.

## Which doc owns what

| Doc | Owns |
|---|---|
| `README.md` (root) | The user-facing quickstart, the configuration table and the repo layout |
| `CONSTITUTION.md` | Canonical architecture, invariants and the discrepancy table - read it before the layer files |
| `AGENTS.md` (root) + one file per layer | The map, plus the mechanical detail for `agent/`, `utils/`, `charts/`, `scripts/`, `tests/`, `docs/`, `.github/` |
| `docs/AGENTS.md` | This file: which document owns what, and what must not drift |
| `docs/PROJECT_STATE.md` | A **point-in-time** session handoff (resume point for the first live deploy). Restored deliberately; its counts are already stale (D7), so never read it as live status |
| `docs/ARCHITECTURE.md` | How the code maps onto the design documents: the verified cluster topology (pod groups, ports, scaling path), the per-task step table (a-g), scaling/storage invariants, what owns what, deliberate deviations |
| `docs/MESSAGE_CONTRACT.md` | The queue contract: payload fields, `job_id` semantics, the ack/retry/DLQ matrix, status lifecycle, idempotency key, directory-backend behaviour |
| `docs/RUNBOOK.md` | Operations: daily checks, queue backlog, CrashLoop, DLQ, Gemini quota, secret rotation, scaling/cost knobs, rollback |
| `docs/diagrams/` | The runtime architecture diagram: `cv-tailoring-runtime.archify.json` is the authored source, the delivered `cv-tailoring-runtime.html` is the artifact. Dense `standard` profile by design - see the section below |
| `docs/template_agents.md` | A reference copy of the CommonAgentSDK layered-docs standard (the authoritative copy lives outside this repo, at `E:\CommonAgentSDK\instructions\template_agents.md`). `tools/analyze.mjs` is the same kind of copy of the SDK's CLI - TypeScript-only, and not wired up here |

Do not restate a layer's rules here - link to `charts/AGENTS.md`, `tests/AGENTS.md` and
the rest instead.

## The runtime architecture diagram

`docs/diagrams/cv-tailoring-runtime.archify.json` is the authored source (archify schema
v1) and `docs/diagrams/cv-tailoring-runtime.html` is the delivered, self-contained
artifact. `meta.output` must stay a *relative* path inside the repo root - the deliver
step resolves it against the working directory, so a bare filename lands the artifact at
the root. Regenerate with:

```sh
node <archify-skill>/bin/archify.mjs validate architecture docs/diagrams/cv-tailoring-runtime.archify.json
node <archify-skill>/bin/archify.mjs deliver  architecture docs/diagrams/cv-tailoring-runtime.archify.json
```

It is deliberately authored as a **dense `standard` map**, not `showcase`. The 18
components need a 1910px-wide canvas (the whole pipeline reads in one row), while the
showcase contract requires the 9px node context line to project to at least 6px at a
960px reader width - i.e. a viewBox of roughly 1300px or less. Folding the pipeline is
what would meet it; the choice was to keep the single-row pipeline and accept the
recorded finding (the single `composition/desktop-readability` warning in an otherwise
clean receipt: 9/9 artifact checks, 0 errors).

**Status 2026-09-27: the spec is clean, the HTML is a WIP artifact - only `validate` was
run.** `archify visual-check docs/diagrams/cv-tailoring-runtime.html` **fails** with
`Adaptive reader layout did not reach stable dimensions`. The shipped viewer sizes its
frame as `desiredWidth = availableSvgHeight * (viewBox.w / viewBox.h) + chrome` against
`MIN_READER_WIDTH = 960` / `MAX_READER_WIDTH = 1920` (`assets/template.html`), and every
example the skill ships has a canvas 1030-1096px wide (aspect 1.60-1.93); ours is
1910x850 (aspect 2.25), so at 1440x900 the frame over-sizes, `settleOverflow` changes the
width, the cards re-wrap and the layout never settles (reproduced twice). The same 1910px
width projects the 9px context line to 4.5px at the 960px floor - the browser-side twin of
the descriptor warning above. **The fix is a narrower canvas (roughly 1080-1400px)**: fold
`vision_check` + `persist` into a second pipeline row and move the storage/cron rows down.
No component or edge is dropped, but the lower half's coordinates, corridors and `labelAt`
pins all move - that re-layout was deliberately not done, so re-run `visual-check` before
treating this HTML as shippable.

What the diagram asserts is checked against the code - only `adapt_text` and `vision_check`
call Gemini, `render` does not - so when the pipeline changes, the same change updates the
spec and re-delivers the HTML.

## One Postgres schema (D10, resolved)

There is exactly one DDL: `utils/db.SCHEMA_SQL`, which the worker executes on startup -
so it is what exists in the cluster. It creates the worker's tables (`resumes`,
`model_availability`, `app_settings`) **and the backoffice's three** (`resume_board`,
`resume_history`, `app_users` - the first two `on delete cascade` to `resumes(job_id)`),
because the backoffice shares this database. `docs/postgres_schema.sql` was deleted on
2026-09-25 (its only consumer, the docker-compose initdb path, was removed). Add tables to
`SCHEMA_SQL` (and to `tests/test_postgres_store.py`) - never to a second file.

## History: the docs set was deleted once, then restored

Commit `46a76fd` removed the whole classic `docs/` set; it was restored in `4678752` and the
commit that followed, because the deploy handoff and the runbook are still in use. The layer
`AGENTS.md` files own the mechanics and these documents own the deep dives - if a document
ever looks obsolete, move its content instead of deleting the file (that deletion detour is
what produced D10).

## Rules

1. A behaviour change updates its owning doc *in the same change*; a fact change
   updates `CONSTITUTION.md` too.
2. A new discrepancy is not quietly fixed in prose - add it to `CONSTITUTION.md`
   section 5 with a D-number and a status.
3. A new document must appear in the root `AGENTS.md` architecture map and in the
   ownership table above. A document with no owner is deleted instead.
4. A point-in-time handoff is never live status; operational knowledge belongs in
   `CONSTITUTION.md` (invariants) and in the layer files (mechanics).
5. The SDK's `template_agents.md` is the *standard*, not a to-do list: it describes the
   Astro project it came from, so never copy its `src/...` layer map into this repo
   (the root `AGENTS.md` CommonAgentSDK section records the applicability).

## Don't

- Document a chart value that no template renders (`queueRetryTtlMs`, `storageBackend`
  - D1/D5); either wire it up or list it as inert.
- Delete a document instead of moving its content - the last time that happened
  (`46a76fd`) it cost a restore cycle, and its metadata drifted (D10).
