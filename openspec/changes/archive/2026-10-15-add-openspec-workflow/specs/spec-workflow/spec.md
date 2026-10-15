# Spec Delta

## Purpose

Defines how this repo plans, validates and archives a change, and how the resulting spec set relates
to `CONSTITUTION.md` and the per-layer `AGENTS.md` files.

## ADDED Requirements

### Requirement: A behaviour change is planned before it is built

A change that alters product behaviour SHALL be planned as a change proposal under
`openspec/changes/<change-id>/` before implementation starts, and that proposal SHALL name the layers
it touches, the `CONSTITUTION.md` invariants it must not break and what it deliberately leaves out
of scope.

#### Scenario: A new capability is requested

- **WHEN** the operator asks for behaviour the system does not have
- **THEN** a change directory SHALL hold a proposal, its spec delta and its tasks before any source file changes

#### Scenario: A change states no requirement

- **WHEN** a change is pure tooling, documentation or refactoring with no behaviour to specify
- **THEN** the proposal SHALL say so explicitly rather than invent a requirement to satisfy validation

### Requirement: Specs state behaviour, and the constitution keeps the invariants

Every requirement SHALL state an observable outcome - what the operator or the system does - and
internal mechanisms SHALL be described in the change's own `design.md`. `CONSTITUTION.md` SHALL
remain the single owner of the architecture, the numbered invariants and the discrepancy table, and a
change that alters a fact recorded there SHALL update it in the same change.

#### Scenario: A documented fact changes

- **WHEN** a change alters a fact `CONSTITUTION.md` records
- **THEN** the same change SHALL update that file, and the owning layer `AGENTS.md` when mechanics move

#### Scenario: A requirement is only expressible as a mechanism

- **WHEN** a requirement can be stated only in terms of an implementation detail
- **THEN** the requirement SHALL state the outcome and the detail SHALL live in `design.md`

### Requirement: A change is validated before it is archived

`openspec validate --all --strict` SHALL pass on the working tree, and archiving SHALL be the act
that moves a change into `openspec/changes/archive/` and merges its delta into `openspec/specs/`.

#### Scenario: A malformed delta

- **WHEN** a spec delta omits an operation header, a requirement body or a scenario
- **THEN** validation SHALL fail naming the expected structure, rather than let the change be archived

#### Scenario: The gate runs with no cluster and no secret

- **WHEN** CI validates a pull request
- **THEN** it SHALL run the pinned CLI with `--no-interactive`, needing no database, broker or Gemini key

### Requirement: The workflow files are tool-neutral

OpenSpec's workflow files SHALL live in the vendor-neutral `.agents/skills/` tree, and installing or
refreshing them SHALL NOT create, rewrite or delete anything under a tool-owned folder
(`.clinerules`, `.cline/`) or add a marker block to a document.

#### Scenario: The workflows are refreshed

- **WHEN** the CLI is upgraded and `openspec update` runs
- **THEN** only `.agents/skills/openspec-*/SKILL.md` and the ownership marker change, and `.clinerules` stays byte-identical

### Requirement: Capabilities accrue from changes and are named once

`openspec/specs/` SHALL grow through archived changes rather than a one-off backfill, each capability
SHALL be named in kebab-case, and a change whose behaviour belongs to an existing capability SHALL
extend that capability instead of introducing a parallel one.

#### Scenario: A later change revisits a capability

- **WHEN** a new change alters behaviour an archived change already specified
- **THEN** it SHALL carry a delta against that existing capability path

#### Scenario: A genuinely new capability is named

- **WHEN** a change introduces behaviour that belongs to no existing capability
- **THEN** the name SHALL come from the backlog in `openspec/AGENTS.md` when one fits, and the backlog SHALL be extended when it does not