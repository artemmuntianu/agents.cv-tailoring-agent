# .github/ - CI workflows

Two workflows. Both are credential-free and cluster-free: **no Gemini key, no
cloud account, no deploy.** They re-run the commands from the root `AGENTS.md`.

## `workflows/ci.yml` - lint + tests + chart render

Runs on every push to `main` and on every pull request.

| Job | Steps | Why |
|---|---|---|
| `app` | `pip install -r requirements-dev.txt` (Python 3.12, pip cache) -> `python -m ruff check .` -> `python -m pytest -q` with a **Postgres 16 service container** | The service container is what makes the 28 `TEST_DATABASE_URL`-gated tests in `tests/test_postgres_store.py` really run; the rest of the suite stays offline. **The job has no Gemini key** - a test that reaches a real client passes locally (a developer's `.env`) and dies here, so a call must be mocked, not key-dependent |
| `charts` | `helm lint charts/cv-tailoring-worker` -> `helm lint charts/cv-tailoring-scout` -> `helm lint charts/cv-tailoring-archiver` -> `helm dependency update charts/cv-tailoring-platform` -> `helm lint charts/cv-tailoring-platform` -> `helm template ... -f deploy/values/dev.yaml --set cv-tailoring-worker.image.tag=ci` -> `kubeconform -strict -summary -ignore-missing-schemas -kubernetes-version 1.30.0` | `helm lint` cannot catch a null/invalid field value; kubeconform is the step that found `secretKeyRef.key: null` before a deploy did. The two scheduled-job charts are linted directly as well, so a broken one names itself instead of failing inside the umbrella |

| `backoffice` | `npm ci` -> `npx tsc --noEmit` -> `npm test` -> `npm run build`, all with `working-directory: backoffice` (Node 22, `cache: npm`) | The POC's own gates are hermetic (vitest + jsdom, no database, no broker), so the job needs no service container - and before it existed nothing in CI ran them at all, while the board is the layer with the most UI code |

Helm is pinned to `v3.16.2` on purpose. Do not bump it casually: the charts must
also render with a developer's Helm 4 (`index .Values "cv-tailoring-worker"` for
the dashed key, no removed key left in `values.schema.json`'s `required`, a
default for every value a template reads).

## `workflows/helm-smoke.yml` - a real install in a kind cluster

Triggered by a PR touching `charts/**`, `deploy/**`, `Dockerfile`, `worker.py` or
`healthcheck.py`, and by `workflow_dispatch`. It builds the image, creates a kind
cluster, `kind load`s the image, installs **the worker chart alone with offline
backends** (`keda.enabled=false`, `replicaCount=1`, `config.queueBackend=directory`,
`config.dbBackend=local`, `config.modelStateBackend=file`), waits for `Ready`,
then execs `healthcheck.py --mode render` and `--mode readiness` inside the pod.
On failure it dumps `kubectl describe pods` and the logs.

It is the only place where the image is proven to ship poppler + LibreOffice and
to pass the exec probes - keep the offline backend flags, or the smoke test would
need a broker. (`config.storageBackend=local` is still passed and is inert; no
template renders it - `CONSTITUTION.md` D1.)

## Rules

- A workflow step must be reproducible locally with the same command (root
  `AGENTS.md` "Commands"/"Charts"); if it cannot be, say so in a comment in the
  workflow.
- Never add a step that needs a secret, a cloud account or a registry push. The
  cloud deploy workflow was deleted with the Azure era (`CONSTITUTION.md`
  section 5).
- Keep `helm dependency update` before the umbrella lint/template: without it the
  `file://../cv-tailoring-worker` dependency does not exist on a fresh checkout.
- Treat a red CI as a real regression - the same suite is green locally
  (132 collected / 104 passed / 28 skipped, `ruff` clean; the backoffice's `npm test` is
  213 passed in 21 files) **and keyless**: `python -m pytest -q` has to pass in a tree with no
  `.env` and no `GEMINI_API_KEY`, because that is what this job runs in.
- A file a job reads has to be tracked. `extension/manifest.json` was swallowed by the blanket
  `*.json` rule, so `inject.test.ts` read a file that only existed on a developer's disk and the
  `backoffice` job could not go green (until 2026-09-29); `.gitignore` now negates it.
- `npm ci` is the lockfile-exact install the `backoffice` job uses. On **Windows** a running
  `npm run dev` holds `node_modules/lightningcss-*/lightningcss.*.node`, so the same command dies
  with `EPERM: operation not permitted, unlink ...` *after* it has already wiped `node_modules` -
  run `npm install` to restore the tree and use `npm test` / `npx tsc --noEmit` as the local gate
  (measured 2026-09-27).

## Don't

- Add `paths:` filters to `ci.yml` that would skip lint/tests for a source-only
  change.
- Cache or commit Helm packages: `charts/*/charts/*.tgz` is gitignored precisely
  because a stale package silently shadows the local subchart.
- Let `helm-smoke.yml` install the **umbrella** chart: it pulls the KEDA subchart
  from the network and hides which layer failed.
