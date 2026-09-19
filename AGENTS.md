# Project

Event-driven **CV tailoring worker**: a job description goes in, a CV tailored for
that vacancy comes out as **DOCX + PDF**. Python **3.11+** (the dev machine runs
3.14, the image uses `python:3.12-slim`), plain `pip` + `requirements*.txt`, no
packaging step. Orchestration is LangGraph, the LLM is Google Gemini, document
surgery is `python-docx`, rendering is LibreOffice + poppler.

The whole platform (RabbitMQ, KEDA autoscaler, Postgres, artifact storage) runs in
a **local Kubernetes cluster**; the only external call is the Gemini API.

**Read `CONSTITUTION.md` and the per-layer `AGENTS.md` files before changing
anything** - that is where the design, invariants and already-known discrepancies
live, so no agent has to re-derive them.

## Architecture map (read first)

- **`CONSTITUTION.md`** - canonical architecture, invariants, legacy/dead code, known discrepancies.
- **`agent/AGENTS.md`** - LangGraph orchestration: state, contract, models, nodes, graph, shared runner.
- **`utils/AGENTS.md`** - backend adapters and infrastructure (queue, DB, storage, model state, retry, DOCX mutator, renderer, logging).
- **`charts/AGENTS.md`** - Helm charts + `deploy/values` (the cluster deployment).
- **`scripts/AGENTS.md`** - operator tooling: deploy, cluster storage, secrets, model check.
- **`tests/AGENTS.md`** - the hermetic verification layer.
- **`docs/AGENTS.md`** - architecture / contract / runbook documentation, and which doc owns what.
- **`.github/AGENTS.md`** - CI workflows.

Root entry points (`config.py`, `main.py`, `worker.py`, `publisher.py`,
`healthcheck.py`) are mapped in `CONSTITUTION.md` section 6.

### How the docs are layered

Three levels, no duplication: this file is the **map** (what exists, how to run
it), `CONSTITUTION.md` is the **canonical truth** (invariants, legacy code, known
discrepancies), and each per-layer `AGENTS.md` is the **mechanical detail** for
the directory it sits in. A layer file states its own rules and links upward
instead of restating them.

Adding a layer (a new top-level directory with real behaviour) means, in one
change: write `<dir>/AGENTS.md`, add it to the architecture map above, and record
any new fact or discrepancy in `CONSTITUTION.md`. Renaming or deleting a layer
does the same in reverse.

## CommonAgentSDK (instructions + tooling)

The shared agent SDK lives outside this repo:

| Path | What it is | Applies here? |
|---|---|---|
| `E:\CommonAgentSDK\instructions\template_agents.md` | The **layered-docs standard** this repo follows: a root `AGENTS.md` with an architecture map, plus one `AGENTS.md` per layer and a `CONSTITUTION.md` for canonical facts. | **Yes - this is the convention being applied.** Follow it when adding/renaming layers. |
| `E:\CommonAgentSDK\tools\analyze.mjs` | A `ts-morph` CLI (outline / dead-exports / refs / imports / typecheck / move-symbols) built for a **TypeScript/Astro** codebase. | **No.** This repo is Python. Do not add Node/ts-morph and do not port the tool; use the Python tooling in "Shared analysis tooling" below. |

Consequence for this repo: the SDK's *instructions* are authoritative for how the
docs are organised, while its *tool* is not usable - keep the two decisions
separate so nobody re-investigates it. Committed reference copies are
`docs/template_agents.md` (the standard) and `tools/analyze.mjs` (the CLI); the
copy of the tool ships without `package.json`/`node_modules`, so it cannot run
here.

## Commands

All commands run from the repo root.

```sh
pip install -r requirements-dev.txt      # runtime + pytest + ruff

python -m pytest -q                      # hermetic: no network, no Gemini, no LibreOffice
python -m ruff check .                   # lint; must stay clean
python healthcheck.py --mode all         # probe render tools + writable dirs

python main.py                           # batch CLI over artifacts/input/jd_*.txt
python worker.py --once                  # drain the configured queue, then exit
python worker.py                         # consume forever (this is the pod)
python publisher.py --all                # publish every jd_*.txt (dev gateway)
python scripts/check_models.py --strict  # MODEL_NAME must exist for this API key
```

The 6 Postgres integration tests only run when pointed at a throwaway database:

```sh
make test-postgres
# or:
TEST_DATABASE_URL=postgresql://cvt:cvt@localhost:5432/cvt python -m pytest -q tests/test_postgres_store.py
```

Cluster / containers:

```sh
.\scripts\local-deploy.ps1                 # build image + secret + helm install
.\scripts\local-deploy.ps1 -SkipBuild      # redeploy an existing image
.\scripts\local-deploy.ps1 -Uninstall      # remove the release (keeps PVCs)
.\scripts\storage-files.ps1 -Action seed   # list | download | shell also valid

docker build -t cv-tailoring-worker:dev .
docker compose up -d rabbitmq postgres
docker compose run --rm worker python publisher.py --all
```

Charts (offline validation, no cluster needed):

```sh
helm lint charts/cv-tailoring-worker
helm dependency update charts/cv-tailoring-platform     # required before linting
helm lint charts/cv-tailoring-platform
helm template cv-tailoring charts/cv-tailoring-platform -f deploy/values/dev.yaml > rendered.yaml
kubeconform -strict -summary -ignore-missing-schemas -kubernetes-version 1.30.0 rendered.yaml
```

`make help` lists every developer target (`Makefile`); on a machine without
`make` (plain Windows), copy the command out of the recipe.

## Linting / formatting

Ruff only (`pyproject.toml` -> `[tool.ruff]`): line-length 100, target `py311`,
rules `E,F,W,I,B,UP` with `E501` and `B008` ignored on purpose (long prompt
strings; `Depends`-style default calls). `artifacts`, `charts` and `deploy` are
excluded. There is no mypy/black step - `ruff check .` is the whole gate and it
must be green.

## Shared analysis tooling

There is no type-aware Python CLI in this repo, and the SDK's `analyze.mjs` is
TypeScript-only (see above). Instead:

- `python -m pytest -q` + `python -m ruff check .` for behaviour and lint;
- `git grep -n "<symbol>"` for "who references X?" - cheap and honest, but it also
  matches comments and strings, so confirm each hit;
- `python -c "..."` with `ast` when a structural view of a module is needed;
- module docstrings and `python -m pydoc <module>` for the intended contract.

Do not add a dependency just to answer a reference/dead-code question.


## Known environment traps (do NOT re-investigate)

1. **CRLF + the editor's replace path.** Some files are CRLF and others LF, so an
   exact-match multi-line replacement can silently miss. Worse, the editor's
   replace path substitutes a dollar sign that is immediately followed by a
   single quote or by a backtick - in this repo that already truncated edits and
   duplicated a whole document. For large or dollar-sign-heavy edits use a small
   Python patcher that reads with `newline=""`, asserts the anchor appears
   exactly once, writes back with the same newlines, then AST-parses the result.
2. **`model_state.json` is tracked but rewritten at runtime.** Run
   `git checkout -- model_state.json` after local test/CLI runs to keep the tree clean.
3. **Bitnami is dead.** `charts.bitnami.com` now redirects to `repo.broadcom.com`
   and the free `bitnami/rabbitmq` images were emptied, so a Bitnami release
   fails with `ImagePullBackOff`. The broker is our own StatefulSet on the
   official `rabbitmq:3.13-management` image; KEDA is the only upstream chart.
4. **Docker Desktop's kind provider also reports the `docker-desktop` context**,
   yet kind nodes keep their own image store. `local-deploy.ps1` detects kind by
   node name (the `-control-plane` suffix) and loads the image explicitly.
5. **Helm 4 is stricter than Helm 3:** a dashed key cannot be a template field
   path (use `index .Values "cv-tailoring-worker"`); a removed key must not stay
   in the `required` list of `values.schema.json`; and every value a template
   reads needs a default in the chart's `values.yaml` or `helm lint` dies with a
   nil pointer.
6. **Vendored subcharts shadow local sources.** `charts/*/charts/*.tgz` is
   gitignored exactly because a stale `.tgz` shadows `file://../cv-tailoring-worker`;
   always run `helm dependency update` before linting or templating.
7. **`helm lint` and `helm template` cannot catch null/invalid field values** - a
   `secretKeyRef.key: null` once shipped and was only caught by `kubeconform`.
   Always render and validate before trusting a chart change.
8. **`kubectl apply --dry-run=client` needs a live API** (it downloads OpenAPI),
   so offline chart validation is `helm lint` + `helm template` + a YAML parse +
   `kubeconform`.
9. **The Windows console is cp1252.** CLI scripts must call
   `sys.stdout.reconfigure(encoding="utf-8")` or emoji output raises
   `UnicodeEncodeError`.
10. **Placeholder Gemini model ids.** A wrong id is a *non-retryable* 400, so
    every task would burn its attempts and land in the DLQ. Run
    `python scripts/check_models.py --strict`; the worker also validates at preflight.
11. **The cv_data <-> cv.docx sync rule is enforced at runtime.** A single
    whitespace mismatch fails the task by design - regenerate `cv_data.json` when
    the master CV changes.
12. **`.env` is gitignored and never staged**, and may still contain now-unused
    Supabase keys (see `CONSTITUTION.md` D9).

## Shell / commands (Windows PowerShell 5.1)

- The terminal is **Windows PowerShell 5.1**. **NEVER** chain commands with `&&`
  or a bare `&` - both are reserved operators there; the only separator that
  works is `;`. Inside a `cmd /c "..."` string `&`/`&&` are fine, because that
  string is handed verbatim to cmd.exe.
- Prefer PowerShell cmdlets over cmd aliases: `dir` -> `Get-ChildItem`,
  `dir /b` -> `Get-ChildItem -Name`, `mkdir` -> `New-Item -ItemType Directory`,
  `rm` -> `Remove-Item`, `cp` -> `Copy-Item`, `mv` -> `Move-Item`. A bare `/b` is
  parsed as a path (`D:\b`) and errors.
- Long-running commands (pytest, `docker build`, `helm install`) sometimes return
  no output, or report a non-zero wrapper exit even on success. Redirect to a file
  and read it back: `cmd /c "python -m pytest -q > out.txt 2>&1"`. **Do not treat
  a non-zero wrapper exit as failure - verify the actual log/artifact.**
- Always quote paths that contain spaces.
- `make` may be absent on plain Windows; copy the command out of the `Makefile`
  recipe instead of installing make.


## Conventions

- **Output language**: always respond in English, even if the user writes in
  another language.
- Provider-specific code sits behind an **env-selected backend plus a `get_*()`
  factory with a matching `reset_*_cache()` test hook** (`utils/`). Follow that
  pattern for anything new instead of branching on the backend at call sites.
- Keep the dependency direction one-way: `agent/` -> `utils/` -> `config`.
  `utils/` must never import `agent/`.
- Configuration is read once, in `config.py`. Never scatter `os.getenv()` through
  the code.
- Docstrings explain the *why* (the invariant being protected), not a restatement
  of the code.
- Log through `utils.logging_setup.get_logger(__name__)` with structured
  `key=value` extras. No `print()` in library code - the two CLIs (`main.py`,
  `publisher.py`) are the deliberate exception.
- Keep Gemini-specific code in `agent/nodes.py`; the pipeline and adapters stay
  provider-agnostic.
- When you change a fact recorded in `CONSTITUTION.md`, update it in the same change.

## Don't

- Leave the tree dirty after a local run (restore `model_state.json`; `artifacts/`
  is not tracked).
- Commit secrets - `.env` is gitignored and charts use `existingSecret`.
- Switch RabbitMQ back to a Bitnami chart, or re-introduce Supabase / Azure code
  (see `CONSTITUTION.md` section 5).
- Add a dependency for something the pinned set already covers - and note that
  `pypdf` is currently unused.
- Trust `helm lint` alone for a chart change.
- Treat a point-in-time handoff as live status; the one that used to live in `docs/` was removed in `46a76fd` and stays recoverable from history (`CONSTITUTION.md` D10).

## When unsure

Ask. A 30-second clarifying question is cheaper than a 30-minute revert. If prose
and code disagree, trust the code and fix the prose (`CONSTITUTION.md` section 8).

