# Proposal

## Why

The repo keeps three kinds of truth: `CONSTITUTION.md` (canonical architecture, 37 numbered
invariants, the D-numbered discrepancies), one `AGENTS.md` per layer (mechanics) and `docs/`
(the deep dives and the diagram). None of them can hold **a plan for work that has not happened
yet**: a feature begins as a chat prompt, so its requirements, its scope and its deliberate
omissions live only in the transcript and are re-derived by every later session.

OpenSpec supplies that layer - a change proposal reviewed before code, then archived into a
permanent behaviour spec - without adding a runtime dependency, a service or a second database.

## What Changes

- Adopt OpenSpec as the repo's change-planning layer at the `spec-driven` schema (`openspec/`).
- Install its workflow files for the **vendor-neutral `.agents/skills/`** target, so no tool-owned
  folder (`.clinerules`, `.cline/`) is written to and no marker block is added to any doc.
- Fill `openspec/config.yaml` with the context and per-artifact rules an agent cannot infer from
  the code: the monorepo layout, the invariant discipline, LF-only, PowerShell 5.1, the gates.
- Add `openspec/AGENTS.md` as the layer doc and register it in the root `AGENTS.md` architecture
  map and in `docs/AGENTS.md`'s ownership table (the two registrations that file's rule 3 requires
  of every new document).
- Gate spec structure in CI with `openspec validate --all --strict`, pinned to the CLI version.
- Record the capability backlog, so the next feature targets a named capability instead of
  inventing a taxonomy per change.

## Capabilities

### New Capabilities

- `spec-workflow`: how a change is proposed, validated, applied and archived in this repo, what a
  spec may and may not claim, and how the spec set relates to `CONSTITUTION.md`.

### Modified Capabilities

_None._ No runtime behaviour changes: no queue, no table, no chart, no board route.

## Impact

- `openspec/**` - new (config, specs, changes, archive).
- `.agents/skills/openspec-*/SKILL.md` and `.agents/skills/.openspec-target` - generated workflows.
- `AGENTS.md` (root) - architecture map, the docs-layering paragraph, Commands, Don't.
- `docs/AGENTS.md` - the ownership table and one rule.
- `.github/workflows/ci.yml` and `.github/AGENTS.md` - the validation gate.
- Development-time only: nothing added here runs in the cluster, and no existing test, invariant
  or contract changes.