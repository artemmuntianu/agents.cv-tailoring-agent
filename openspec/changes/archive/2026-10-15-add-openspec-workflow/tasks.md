# Tasks

## 1. Install and configure

- [x] 1.1 Install the pinned CLI (`npm install -g @fission-ai/openspec@1.14.2`) and initialise the repo root with `openspec init --tools agents`.
- [x] 1.2 Fill `openspec/config.yaml` with the project context, the per-artifact rules and the apply/archive guidance.

## 2. Document the layer

- [x] 2.1 Write `openspec/AGENTS.md`: what the layer owns, how a change flows, the CLI gates and the capability backlog.
- [x] 2.2 Register it in the root `AGENTS.md` (architecture map, the docs-layering paragraph, Commands, Don't).
- [x] 2.3 Add the ownership row and the behaviour-vs-invariant rule to `docs/AGENTS.md`.
- [x] 2.4 Gate: `python tools/analyze.py validate-docs` passes (CI enforces this one).

## 3. Gate it in CI

- [x] 3.1 Add the `specs` job to `.github/workflows/ci.yml`, pinned to `@fission-ai/openspec@1.14.2`.
- [x] 3.2 Document the job and why it is pinned in `.github/AGENTS.md`.
- [x] 3.3 Run the job command locally, so the pin rather than the dev machine's CLI is what is tested.

## 4. Verify and archive

- [x] 4.1 `openspec validate add-openspec-workflow --strict` passes.
- [x] 4.2 `openspec archive add-openspec-workflow`, so the delta merges into `openspec/specs/spec-workflow/spec.md`.
- [x] 4.3 `openspec validate --all --strict` and `openspec list --specs` pass on the archived state.
- [x] 4.4 `git status --short` shows only the paths this proposal names.