# .github/ - CI workflows

Two workflows. Both are credential-free and cluster-free: **no Gemini key, no
cloud account, no deploy.** They re-run the commands from the root `AGENTS.md`.

## `workflows/ci.yml` - lint + tests + chart render

Runs on every push to `main` and on every pull request.

| Job | Steps | Why |
|---|---|---|
| `app` | `pip install -r requirements-dev.txt` (Python 3.12, pip cache) -> `python -m ruff check .` -> `python -m pytest -q` with a **Postgres 16 service container** | The service container is what makes the 9 `TEST_DATABASE_URL`-gated tests in `tests/test_postgres_store.py` really run; the rest of the suite stays offline |
| `charts` | `helm lint charts/cv-tailoring-worker` -> `helm dependency update charts/cv-tailoring-platform` -> `helm lint charts/cv-tailoring-platform` -> `helm template ... -f deploy/values/dev.yaml --set cv-tailoring-worker.image.tag=ci` -> `kubeconform -strict -summary -ignore-missing-schemas -kubernetes-version 1.30.0` | `helm lint` cannot catch a null/invalid field value; kubeconform is the step that found `secretKeyRef.key: null` before a deploy did |

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
  (48 collected / 39 passed / 9 skipped, `ruff` clean).

## Don't

- Add `paths:` filters to `ci.yml` that would skip lint/tests for a source-only
  change.
- Cache or commit Helm packages: `charts/*/charts/*.tgz` is gitignored precisely
  because a stale package silently shadows the local subchart.
- Let `helm-smoke.yml` install the **umbrella** chart: it pulls the KEDA subchart
  from the network and hides which layer failed.
