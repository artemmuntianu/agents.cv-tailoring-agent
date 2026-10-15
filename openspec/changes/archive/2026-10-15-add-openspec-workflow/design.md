# Design

## Context

The repo has no planning layer. `CONSTITUTION.md` records what *is* (architecture, 37 invariants,
the D-numbered discrepancies), the layer `AGENTS.md` files record the mechanics, `docs/` holds the
deep dives, and `docs/AGENTS.md` decides which document owns which fact. A feature therefore begins
in chat, and its requirements are written down nowhere that survives the session.

Constraints that shape the approach:

- Files are **LF-only** (invariant 37), and a docs change is gated by
  `python tools/analyze.py validate-docs`, which resolves every reference in the root map - so a new
  document must exist *and* be registered (`docs/AGENTS.md` rule 3).
- `.clinerules` is a tracked **file**, not a directory, and it carries the repo's mandatory
  pre-execution checklist.
- CI is credential-free and cluster-free (`ci.yml`, `.github/AGENTS.md`): a gate must run without a
  database, a broker or a Gemini key.

## Goals / Non-Goals

**Goals:**

- A change is reviewed as a written plan before code exists, and the plan outlives the session.
- Specs describe behaviour; the invariants keep their one owner.
- The gate is real: `openspec validate --all --strict` locally and in CI.
- Starting the next feature is free: rules the agent already knows, capabilities already named.

**Non-Goals:**

- Backfilling the existing system into specs.
- Replacing `CONSTITUTION.md`, the layer `AGENTS.md` files or `docs/`.
- Adding a runtime dependency, a service, a table or a chart value.
- Writing any tool-owned folder (`.clinerules`, `.cline/`) or an `AGENTS.md` marker block.

## Decisions

### Decision: install for the vendor-neutral `.agents/skills/` target

`openspec init --tools agents` writes six workflow skills to `.agents/skills/openspec-*/SKILL.md`
plus the `.agents/skills/.openspec-target` ownership marker, and reports
`Commands skipped for: agents (no adapter)`.

*Alternatives rejected:* `--tools cline` writes slash commands to `.clinerules/workflows/opsx-*.md`,
which requires `.clinerules` to become a directory (it is a tracked file today) - a migration of the
one file holding the mandatory checklist, buying a command form the OpenSpec project says it expects
to retire in favour of skills. A tool-local install also ties the planning layer to the operator's
current assistant, whereas the shared `.agents/skills/` tree is read by every Agent-Skills
conformant tool.

### Decision: specs state behaviour, `CONSTITUTION.md` keeps the invariants

A requirement states what the operator or the system observably does; the mechanism belongs in
`design.md`. A change that alters a documented fact updates `CONSTITUTION.md` in the same change,
which is what section 8 already demands when code and prose disagree.

*Alternative rejected:* deriving specs from the invariants. That gives one fact two owners, the
exact failure `docs/AGENTS.md` exists to prevent.

### Decision: no backfill

`openspec/specs/` starts empty and the capability backlog in `openspec/AGENTS.md` names the
candidates (`board-moves`, `ingest-gateway`, `tailoring-pipeline`, `cover-letters`,
`interview-tracking`, `analytics`, `extension-scraper`, `form-filling`, `scheduled-jobs`), so a new
change reuses an established path instead of inventing a parallel one.

*Alternative rejected:* spec every existing capability up front - weeks of prose nobody reviews,
against OpenSpec's own brownfield guidance (start with a change; specs accrue).

### Decision: pin the CLI version in CI

The gate runs `npx --yes @fission-ai/openspec@1.14.2 validate --all --strict --no-interactive`. The
pin follows the same discipline `.github/AGENTS.md` states for Helm (`v3.16.2`) and Node 22: a
validator that drifts is a gate that fails for reasons unrelated to the change under review.

## Risks / Trade-offs

- **The pinned validator can lag the dev machine's CLI.** A newer local CLI may accept something CI
  rejects; the pin is the arbiter and bumping it is one line in the workflow.
- **`.agents/skills/` is not Cline's documented path** (`.cline/skills/`). The skills are plain
  Markdown instructions and the executor is the `openspec` CLI, so the workflow still runs - by
  asking the agent for the skill by name (`openspec-propose`, `openspec-apply-change`, ...) or by
  running the CLI directly. Vendor-neutral means giving up `/opsx-*` slash commands.
- **`openspec/changes/` accumulates.** An unarchived change stays visible by design;
  `openspec list` is the list and `openspec archive` is what closes one.
- **CI gains one network install** (`npx`). The job already needs npm for the backoffice and the
  package is pinned, so the failure mode is a registry outage rather than a flaky gate.