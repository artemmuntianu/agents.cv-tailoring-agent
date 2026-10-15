# openspec/ - the change-planning layer

The one place a change is agreed on **before** it is built, and the one place the resulting
behaviour contract lives afterwards. Nothing here runs: no module imports `openspec/`, no container
reads it, and it adds no dependency, service or table.

Read this file before proposing a change; read `CONSTITUTION.md` before writing anything at all.

## What lives where

| Path | Owns |
|---|---|
| `openspec/config.yaml` | The `spec-driven` schema, the project context and the per-artifact rules - what an agent must know that the code cannot tell it |
| `openspec/specs/<capability>/spec.md` | The **behaviour contract**: requirements with scenarios, accrued one archived change at a time |
| `openspec/changes/<change-id>/` | One in-flight change: `proposal.md`, its `specs/<capability>/spec.md` delta, `design.md`, `tasks.md` |
| `openspec/changes/archive/<date>-<change-id>/` | Finished changes, exactly as they were planned - a record, not a backlog |
| `.agents/skills/openspec-*/SKILL.md` | The generated workflow instructions (vendor-neutral Agent Skills tree), refreshed by `openspec update`. `.agents/skills/.openspec-target` records which tool renderer owns that tree |

## How a change flows

1. **Explore** (optional) - think a shape through before committing to it.
2. **Propose** - one directory per change: why, what changes, the spec delta, the design
   tradeoffs, the tasks. Planning artifacts only; no source file moves in this step.
3. **Review** - the proposal is read before any code exists. That review is the point of the layer.
4. **Apply** - implement the tasks, ticking each one as the gate it names passes.
5. **Archive** - `openspec archive <change-id>` merges the delta into `openspec/specs/` and moves the
   change into `archive/`. Only an archived change counts as shipped behaviour.

## The rules that keep it honest

- **One owner per fact.** `CONSTITUTION.md` owns the architecture, the numbered invariants and the
  discrepancy table; the layer `AGENTS.md` files own mechanics; `docs/` owns the deep dives;
  `openspec/specs/` owns observable behaviour. A change that moves a fact updates its owner **in the
  same change**. A spec never defines a mechanism and never contradicts an invariant.
- **Specs accrue from changes.** There is no backfill of the existing system: an empty
  `openspec/specs/` was the honest starting point, and the first archived change is the first spec.
- **Kebab-case capability paths, named once.** Reuse an existing path when the behaviour belongs to
  it; the backlog below is where a genuinely new name is chosen.
- **`validate --strict` before archive.** Strict mode treats warnings as failures, so every
  requirement needs its `SHALL`/`MUST` body before its scenarios, plus at least one `#### Scenario:`.
- **Tool-neutral files.** The workflows live in `.agents/skills/`; OpenSpec never writes
  `.clinerules` or `.cline/`. Invoke a workflow by asking the agent for the skill by name
  (`openspec-propose`, `openspec-apply-change`, `openspec-archive-change`, ...) or by running the CLI
  - there are no `/opsx-*` slash commands in this repo.
- **A plan is not a promise.** Editing a proposal, or abandoning one, is normal; the archive is what
  makes it history.

## Commands

```sh
openspec list --specs                               # the capability set
openspec list                                       # the in-flight changes
openspec show <change-id>                           # one change, as markdown
openspec status --change <change-id>                # which artifacts exist yet
openspec view                                       # one-screen overview
openspec validate --all --strict --no-interactive    # the gate CI runs (pinned in ci.yml)
openspec archive <change-id>                        # merge the delta into specs/ and file it away
openspec update                                     # refresh .agents/skills/ after a CLI upgrade
```

The CLI is a global tool (`npm install -g @fission-ai/openspec@1.14.2`), not a repo dependency. CI
runs the pinned version, so a change must pass that version rather than the operator local one.

## Capability backlog

Candidate capabilities for the next changes, derived from the existing invariants. A name here is a
hint, not a promise - an archived change is what makes a capability real.

| Capability | Covers |
|---|---|
| `spec-workflow` | This layer: how a change is proposed, validated, applied and archived (the first archived change) |
| `board-moves` | The columns, the dialog, and the refusal / restore / removal rules (invariants 19-23, 27-29) |
| `ingest-gateway` | The batch route, the manual intake, dedupe and the `submitted` claim (invariants 16, 17) |
| `tailoring-pipeline` | The LangGraph flow, ack-after-persist, retries, the sync and no-fabrication rules (invariants 1-10, 23) |
| `cover-letters` | The letter, its own queue and its own page (invariant 24) |
| `interview-tracking` | The interview record and the activity rule (invariant 26) |
| `analytics` | The period-by-period reading of the board |
| `extension-scraper` | The site plugins and the DOM contract (invariants 34, 35) |
| `form-filling` | The application snapshot, the draft plan and the never-submit rule (invariant 36) |
| `scheduled-jobs` | The scout and the archiver, and the run ledger (invariants 25, 27) |