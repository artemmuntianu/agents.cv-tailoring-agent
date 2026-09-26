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
| `docs/template_agents.md` | A reference copy of the CommonAgentSDK layered-docs standard (the authoritative copy lives outside this repo, at `E:\CommonAgentSDK\instructions\template_agents.md`). `tools/analyze.mjs` is the same kind of copy of the SDK's CLI - TypeScript-only, and not wired up here |

Do not restate a layer's rules here - link to `charts/AGENTS.md`, `tests/AGENTS.md` and
the rest instead.

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
