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
| `docs/template_agents.md` | A reference copy of the CommonAgentSDK layered-docs standard (the authoritative copy lives outside this repo, at `E:\CommonAgentSDK\instructions\template_agents.md`). `tools/analyze.mjs` is the same kind of copy of the SDK's CLI - TypeScript-only, and not wired up here |

Do not restate a layer's rules here - link to `charts/AGENTS.md`, `tests/AGENTS.md` and
the rest instead.

## Documents removed in 46a76fd (recoverable)

Commit `46a76fd` deleted most of the previous `docs/` set: `ARCHITECTURE.md`,
`MESSAGE_CONTRACT.md`, `RUNBOOK.md` and `postgres_schema.sql`. The `PROJECT_STATE.md`
handoff was restored afterwards, because the first live deploy is driven from it.
Their topics are owned by the layer `AGENTS.md` files and by `CONSTITUTION.md` now, and
the originals are one command away:

```sh
git log --diff-filter=D --oneline -- docs/
git show 46a76fd^:docs/RUNBOOK.md                 # or ARCHITECTURE / MESSAGE_CONTRACT
git show 46a76fd^:docs/postgres_schema.sql
```

The leftovers of that removal are tracked as `CONSTITUTION.md` D10: `docker-compose.yml`
still mounts the deleted DDL as its initdb script, and `main.py` still prints a hint
naming `docs/MESSAGE_CONTRACT.md`. Everything else (this file, `README.md`, the root
`AGENTS.md`, `charts/AGENTS.md`, `scripts/AGENTS.md`) was repointed in the same change.

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
- Point a document, a script or a chart at a file that no longer exists - that is
  exactly how D10 happened.
