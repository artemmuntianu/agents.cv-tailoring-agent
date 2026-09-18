# Project state & handoff

> Purpose: let a fresh session (human or AI) resume this work in a couple of
> minutes without re-deriving anything. Read "Resume point" first, then
> "Verified / not verified" before changing code.

## What this is

Turns a job description into a CV tailored for it (DOCX + PDF) with a LangGraph
pipeline: Gemini rewrites the text, `python-docx` performs the document
(AST/XML) surgery, LibreOffice + poppler render it, Gemini Vision checks the
layout.

**It runs entirely on one machine, in a local Kubernetes cluster** - queue,
autoscaler, database and file storage are all in-cluster. The only outbound call
is to the **Gemini API**.

```
publisher / extension --> RabbitMQ (rabbitmq-0, resumes.generate)
                              |  KEDA: queue depth -> replicas (0 -> M -> 0)
                              v
                    ai-agent-worker pod (prefetch = 1, one vacancy per message)
                    adapt_text -> render -> vision_check -> persist
                              |
              cv-artifacts volume (PDF/DOCX) + Postgres (status)
```

Three ways to run the same pipeline (`agent/pipeline.py` is shared):

| Mode | Command | Storage / DB |
|---|---|---|
| Local cluster (primary) | `.\\scripts\\local-deploy.ps1` | PVC `cv-artifacts` + in-cluster Postgres |
| Batch CLI | `python main.py` | `artifacts/` + `db_state.json` |
| docker compose | `docker compose up -d rabbitmq postgres` | compose volumes + Postgres |

## Resume point (as of the last session)

Everything is built, committed and validated **except the last mile: a real
`helm install` on a live cluster has never run.**

State of the machine when the session ended:

* `helm` **4.3.0** and `winget` are installed (open a new terminal for PATH).
* `kubectl` present (ships with Docker Desktop).
* **Docker Desktop's Kubernetes was being created by the user**, provisioner
  chosen: **kubeadm** (single node, shares Docker's image store - see gotchas).
* The Docker daemon had been stopped, so the image has **never been built**.

## Next commands, in this order

```powershell
# 0. new terminal, so helm/kubectl are on PATH
cd E:\CVTailoringAgent
git log --oneline -3                     # main should contain all of this work

# 1. is the cluster up?
kubectl config current-context           # expect: docker-desktop
kubectl get nodes                        # expect one Ready node

# 2. deploy everything (builds the image, creates the Secret, helm install)
.\scripts\local-deploy.ps1

# 3. put the CV on the cluster volume (needs cv.docx + cv_data.json locally)
.\scripts\storage-files.ps1 -Action seed
.\scripts\storage-files.ps1 -Action list

# 4. send one real vacancy and watch KEDA
kubectl port-forward svc/rabbitmq 5672:5672     # in a second terminal
python publisher.py --jd your_job.txt
kubectl get pods -w                              # 0 -> 1 -> 0

# 5. collect the result
.\scripts\storage-files.ps1 -Action download     # -> artifacts\output\*.pdf
```

If step 2 fails, debug in this order: `kubectl get pods`,
`kubectl describe pod <pod>`,
`kubectl logs -l app.kubernetes.io/component=ai-worker`, then re-run with
`-SkipBuild` (or `-Uninstall` to start over).

### Known blockers likely to appear on the first run

1. **The image has never been built.** Expect possible issues with the
   `libreoffice-writer` / `fonts-crosextra-carlito` package names and a ~1 GB
   image (first build takes minutes).
2. **`cv.docx` / `cv_data.json` must exist on the PVC.** The seed step needs the
   files locally; they used to live in Supabase Storage (`master/cv.docx`,
   ~955 KB) before that dependency was removed, so point the script at wherever
   the local copies are (`-CvFile` / `-CvDataFile`; defaults are
   `artifacts\input\cv.docx` and `artifacts\cv_data.json`).
3. **The sync rule**: every line of `cv_data.json` must appear verbatim in
   `cv.docx` or the worker refuses the task (by design). One mismatch (a missing
   space after a pipe character in the "Datopus" line) was already fixed in the
   JSON. If the CV changes, regenerate `cv_data.json`.
4. **`helm install` and KEDA are unproven**: the ScaledObject should take the
   worker 0 -> 1 -> 0; watch `kubectl get scaledobject`.

## Verified working (with the evidence)

| What | How it was verified |
|---|---|
| 41 tests (6 skip without a DB) | `python -m pytest -q` -> all pass |
| Lint/format | `python -m ruff check .` -> clean |
| Charts are valid | `helm lint` (both charts) exit 0; `helm dependency update` fetches KEDA 2.15.2 |
| Full platform renders | `helm template cv-tailoring charts/cv-tailoring-platform -f deploy/values/dev.yaml` -> **45 resources**, all 13 expected pieces (RabbitMQ StatefulSet, Postgres, both PVCs, cv-files, worker + ScaledObject + TriggerAuthentication, ConfigMaps, Secrets, Services) plus KEDA's stack |
| Render is parseable YAML | loaded with PyYAML and counted per kind |
| Offline queue -> worker -> DB | `publisher.py --all` then `worker.py --once`: claim -> prepare_task -> Gemini 400 -> row `failed, attempts=1` -> message in `queue/retry/` |
| Claim / re-claim / DLQ lifecycle | 3 consecutive runs: the same row is reused, `attempts` 1->2->3, then `dead_lettered` and the message moves to `queue/failed/` |
| Real render toolchain (Windows) | LibreOffice -> PDF (28 439 bytes) -> PNG via poppler: `pages=1` |
| Probes | `healthcheck.py --mode render/liveness` healthy; readiness correctly fails before the first heartbeat |
| Batch CLI skip path | `python main.py` -> `Total 1 / Already tailored 1 / Remaining 0` without calling Gemini |
| Secrets hygiene | `.env` is gitignored and untracked; `.env.example` holds only placeholders; no secret ever staged |
| CI ran (first push) | the `ci` workflow's **lint + tests** job passed on `main`, including the 6 Postgres integration tests in a `postgres:16` service container |
| Rendered manifests are schema-valid | `kubeconform -strict -summary -ignore-missing-schemas -kubernetes-version 1.30.0` on the rendered dev manifest -> 45 resources, 0 invalid |

## Not yet verified (the honest gaps)

1. **`docker build`** - Docker was never running, so the Dockerfile is unproven.
2. **`helm install` on a live cluster**, and **KEDA scaling 0->M->0** for real.
3. **A real Gemini tailoring run** (every run used a dummy key): the prompt, the
   vision-revision loop, and per-vacancy timing (docs claim 15-45 s) are
   unmeasured.
4. The removed Supabase path was never exercised against real Supabase (deleted
   before we got there). Do not assume it worked.
5. Everything downstream of `helm install` (pods actually starting, the broker
   accepting connections, the ScaledObject firing) is still unproven - the
   manifests are schema-valid, but nothing has been applied to a cluster yet.

## Environment facts (this machine)

| Item | Value |
|---|---|
| OS | Windows 10 Enterprise **LTSC 2024** (build 26100, `EnterpriseS`); shell is administrator-but-filtered (no UAC elevation) |
| WSL | only the `docker-desktop` helper distro, so `bash script.sh` fails; use Git Bash at `C:\Program Files\Git\bin\bash.exe` or the `.ps1` scripts |
| winget | **installed by us**: v1.29.290, side-loaded from the `microsoft/winget-cli` GitHub release (LTSC has no Store) |
| helm | **4.3.0** via winget, at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Helm.Helm_Microsoft.Winget.Source_8wekyb3d8bbwe\windows-amd64\helm.exe`, on the user PATH |
| kubectl | from Docker Desktop (`C:\Program Files\Docker\Docker\resources\bin\kubectl.exe`) |
| Kubernetes | Docker Desktop cluster being created, provisioner **kubeadm** |
| kubeconform | **0.8.0** via winget (`YannHamon.kubeconform`) - validates rendered manifests offline |
| az CLI | 2.90.0, logged in (`artemmuntianu@gmail.com`, Main Subscription) - **no longer used** |
| Python | 3.14.6 (repo targets 3.11+; the image uses python:3.12-slim) |
| LibreOffice / poppler | `C:\Program Files\LibreOffice\program\soffice.exe`, `C:\Tools\poppler\poppler-26.07.0\Library\bin` |
| Repos | this worktree plus the main checkout at `E:\CVTailoringAgent` (shared `.git`) |

## Credentials / configuration

* `.env` (gitignored) holds `GEMINI_API_KEY` (and optionally `DATABASE_URL`); the
  Supabase keys in it are unused now and can be deleted.
* The worker Secret is created by `scripts\worker-secret.ps1` and needs only
  `GEMINI_API_KEY` + `DATABASE_URL`. Broker credentials come from the
  `rabbitmq-credentials` Secret shared with KEDA.
* The Gemini key was pasted into a chat earlier in this project - rotate it if
  that matters (one line in `.env`).

## Repo map (which file to touch for what)

```
agent/pipeline.py     shared runner used by worker.py and main.py
agent/graph.py        adapt_text -> render -> vision_check -> persist
agent/nodes.py        the four nodes (Gemini calls, DOCX mutation, upload, DB)
agent/contracts.py    ResumeTaskMessage + JobStatus (job_id shape guard)
worker.py             queue consumer: claim -> run -> ack/retry/DLQ
utils/messaging.py    AmqpQueue + DirectoryQueue behind one contract
utils/storage.py      LocalStorage over ARTIFACTS_DIR (+ prepare_task)
utils/db.py           LocalDb + PostgresDb (claim/duplicate/owned semantics)
utils/model_state.py  model-availability ledger (file or Postgres)
utils/docx_mutator.py AST/XML replacements + cv_data <-> cv.docx sync validator
utils/renderer.py     LibreOffice + poppler, per-job profile, hard timeout
charts/cv-tailoring-platform/   RabbitMQ, KEDA, Postgres, PVC + cv-files, worker
charts/cv-tailoring-worker/     Deployment, ScaledObject, TriggerAuthentication
deploy/values/dev.yaml          the only values file (local cluster)
scripts/local-deploy.ps1        one-command deploy (+ -SkipBuild, -Uninstall)
scripts/storage-files.ps1       seed | list | download | shell
scripts/worker-secret.ps1       creates the worker Secret from .env
scripts/check_models.py         validates MODEL_NAME against models.list()
docs/RUNBOOK.md                 ops: backlog, DLQ, quota, rollback, cost knobs
```

## Open tasks (prioritised)

1. **Finish the deployment** (see "Resume point") and fix whatever the first real
   run surfaces - it is the last unproven step.
2. **Verify the image build in isolation**: `docker build -t cv-tailoring-worker:dev .`
   checks that the LibreOffice/poppler/font packages resolve on
   `python:3.12-slim` and shows how long a cold build takes.
3. **First real tailoring run** with the actual CV, a real vacancy and a real
   Gemini key; measure seconds per vacancy and whether the vision loop revises.
4. **`scripts/align_cv_data.py`** - regenerate/repair `cv_data.json` from
   `cv.docx`. The sync rule is the most likely failure mode and today it is fixed
   by hand.
5. **`scripts/doctor.ps1`** - one-shot preflight (docker daemon, k8s context,
   helm/kubectl, `.env`, free ports, RAM allocation) so the failure chain we
   already hit once cannot repeat.
6. Optional: a small HTTP file view of `/data/output` (nginx sidecar or an extra
   rule on the `cv-files` pod) so PDFs open in a browser instead of `kubectl cp`.
7. Optional: the CI workflows have never run (nothing has been pushed); pushing
   the branch would exercise `ci.yml` and the kind-based `helm-smoke.yml`.

## Hard-won gotchas (read before editing)

1. **Editor line endings and escapes.** Some files are CRLF (`utils/db.py`) while
   others are LF, so exact-match edits fail on CRLF files. Worse, the editor's
   replace path processes template escapes: a dollar sign followed by a single
   quote, or a dollar sign followed by a backtick, gets substituted - it silently
   truncated two edits and duplicated one document. Use the pattern adopted
   throughout: a small Python patcher that reads with `newline=""`, asserts the
   anchor appears exactly once, writes back with the same newlines, then
   AST-parses the result. Prefer Python for large or dollar-sign-heavy edits.
2. **`model_state.json` is tracked but rewritten at runtime** - run
   `git checkout -- model_state.json` after local test runs to keep the tree clean.
3. **Bitnami is dead.** `charts.bitnami.com` now redirects to
   `repo.broadcom.com` and `bitnami/rabbitmq` has zero Docker Hub tags, so any
   Bitnami RabbitMQ release fails with `ImagePullBackOff`. The broker is rendered
   by our own chart on the official `rabbitmq:3.13-management` image, and KEDA is
   the only upstream chart dependency.
4. **Docker Desktop's kind provider also reports the `docker-desktop` context**,
   yet kind nodes keep their own image store. `local-deploy.ps1` therefore
   detects kind by node name (the `-control-plane` suffix) and, when the `kind`
   CLI is missing, prints the two ways out.
5. **Helm 4 is stricter than Helm 3**: a dashed key cannot be used as a template
   field path (use `index .Values "cv-tailoring-worker"`); a removed key must not
   stay in the `required` list of `values.schema.json`; and every value a template
   reads needs a default in the chart's `values.yaml` or `helm lint` dies with a
   nil pointer.
6. **Vendored subcharts shadow local sources.** `charts/*/charts/*.tgz` is
   gitignored for that reason; always run `helm dependency update` before linting
   (both `local-deploy.ps1` and CI do it).
7. **The Windows console is cp1252.** CLI scripts must call
   `sys.stdout.reconfigure(encoding="utf-8")` or emoji output raises
   `UnicodeEncodeError`; and `az` writes a cp1252 warning to stderr that Windows
   PowerShell 5.1 turns into a fatal error under `ErrorActionPreference='Stop'`
   (the PS wrappers handle both).
8. **`kubectl apply --dry-run=client` needs a live API** (it downloads OpenAPI),
   so offline chart validation is `helm lint` + `helm template` + a YAML parse.
9. **The sync rule is enforced at runtime**: every line of `cv_data.json` must
   appear verbatim in `cv.docx` (whitespace included). The validator lives in
   `utils/docx_mutator.py`; the worker fails the task rather than guessing.

## Session log (chronological, one line each)

1. Read the two architecture PDFs (Kubernetes + RabbitMQ event-driven design),
   turned them into a phased migration plan and implemented it: env-driven
   config, structured logging, AMQP worker with DLQ + TTL retry ladder,
   storage/db/model-state layers, DOCX-mutator refactor, `persist` node,
   Dockerfile, Helm charts, 41 tests, CI, docs, compose, publisher, healthcheck.
2. Fixed every bug those tests found: `job_id` type mismatch, psycopg prepared
   statements on poolers, placeholder model ids plus startup validation, LocalDb
   attempt-counter clobbering, a logging `exc_info` crash, `CvData` not
   subscriptable, the `PREFERRED_MODELS` separator, and Helm schema/values/NOTES
   issues.
3. Pivoted to **local-first**: dropped Azure (Bicep, AKS, ACR/GHCR, the deploy
   workflow), replaced Supabase Storage with a PVC, and deleted ~1 270 lines of
   cloud code plus every reference to it.
4. Installed **winget** (absent on LTSC) and **Helm 4.3.0**, which immediately
   exposed and fixed three chart bugs that would have broken the first deploy.
5. Wrote the handoff, merged the branch into `main` (fast-forward) and pushed.
6. The first CI run went green for lint + tests (Postgres integration tests
   included) and **failed kubeconform**, which found a real deploy-breaking bug:
   the RabbitMQ StatefulSet rendered `secretKeyRef.key: null` because the umbrella
   values never defined the credential key names. Fixed with `| default` in the
   template plus explicit keys in values.yaml.

> Lesson: `helm lint` and `helm template` cannot catch null/invalid field values.
> Always render and run `kubeconform` (or `kubectl apply --dry-run=server` on a
> live cluster) before trusting a chart change.

## How a new session should start

```powershell
cd E:\CVTailoringAgent
git log --oneline -3                     # expect the merge on top
python -m pytest -q                      # 35 pass, 6 skip
python -m ruff check .
helm lint charts/cv-tailoring-worker ; helm lint charts/cv-tailoring-platform
helm template cv-tailoring charts/cv-tailoring-platform -f deploy/values/dev.yaml > rendered.yaml
kubeconform -strict -summary -ignore-missing-schemas -kubernetes-version 1.30.0 rendered.yaml
kubectl get nodes                        # is the cluster up?
```

Then continue from "Next commands" above. When something fails, collect
`kubectl get pods`, `kubectl describe pod <pod>`, `kubectl logs <pod>` and
`helm status cv-tailoring` before changing anything.
