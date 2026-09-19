# scripts/ - operator tooling

The code a human runs *against infrastructure* rather than inside the pipeline:
deploy, put the master CV on the cluster volume, create the Secret, verify the
Gemini model id. Nothing here is imported by `agent/` or `utils/`.

Read `CONSTITUTION.md` first; chart structure and cluster traps are in
`charts/AGENTS.md`.

## Tools

| Tool | Language | Purpose |
|---|---|---|
| `local-deploy.ps1` | PowerShell | Build the image, make it visible to the cluster, resolve chart deps, create the Secret, `helm upgrade --install`, print status. Flags: `-SkipBuild`, `-Uninstall` (keeps PVCs), `-Release`, `-Namespace`, `-Values`, `-Image`, `-LocalDbUrl` |
| `storage-files.ps1` | PowerShell | `-Action seed` pushes `cv.docx`, `cv_data.json` and any `jd_*.txt` to `/data`; `list`, `download` (PDFs -> `artifacts\output`), `shell`. Talks to the `cv-files` pod, so it works while the worker is scaled to zero |
| `worker-secret.ps1` | PowerShell | Creates `cv-tailoring-secrets` from `.env` (`GEMINI_API_KEY`, `DATABASE_URL`); real environment variables win over the file; `-DryRun` prints what it would do **without** the values |
| `check_models.py` | Python | Lists the models this API key can use and checks `MODEL_NAME`; `--strict` exits 1 when it is unavailable and prints the `--set` snippet to deploy with |

Broker credentials are deliberately **not** in `worker-secret.ps1`: the chart
injects `RABBITMQ_USERNAME` / `RABBITMQ_PASSWORD` from the same Secret KEDA uses,
so the password lives in exactly one place.

## Contract

- `local-deploy.ps1` order matters: tools -> Docker daemon -> cluster context ->
  image -> **make the image visible** -> chart deps -> Secret -> helm -> status.
  kind nodes keep their own image store, so it detects kind by node name
  (`*-control-plane` / `*-worker*`) and runs `kind load docker-image`; without the
  kind CLI it falls back to what that command does under the hood - `docker save`
  -> `docker cp` into the node container -> `docker exec <node> ctr -n k8s.io
  images import`; a k3d cluster gets `k3d image import`; kubeadm / Docker Desktop
  share Docker's store and need nothing.
- `local-deploy.ps1` calls `worker-secret.ps1` (step 7) - never duplicate the
  Secret creation in a second script.
- `storage-files.ps1` failing with "no `cv-files` pod found" means *deploy first*,
  not "the volume is empty".
- `check_models.py` imports `agent.nodes.get_genai_client` (the SDK call lives
  there). It is an operator script, so this does not break the one-way
  `utils/ -> agent/` rule.
- Volume layout it maintains: `/data/cv_data.json`, `/data/input/cv.docx`,
  `/data/input/jd_*.txt`, `/data/output/*.docx|pdf` - the same paths
  `README.md` documents.

## Conventions

- PowerShell 5.1: `;` is the only command separator (never `&&` or a bare `&`),
  `$ErrorActionPreference = 'Stop'`, a `Fail` helper exits non-zero with a
  `[fail]` line, and cmdlets are preferred over cmd aliases.
- Python scripts under `scripts/` must call
  `sys.stdout.reconfigure(encoding="utf-8")` before printing (the console is
  cp1252) and are covered by `python -m ruff check .`.
- Never echo a secret value and never write one to git - `.env` is gitignored;
  copy `.env.example`.
- Resolve paths from `$PSScriptRoot` (PowerShell) or `__file__` (Python), so the
  scripts work from any cwd and from a git worktree.

## Don't

- Add cloud steps (`az`, ACR/GHCR pushes, Bicep) - that era was removed on
  purpose (`CONSTITUTION.md` section 5).
- Re-implement file transfer with a manual `kubectl cp`/`exec` into the worker
  pod: the worker scales to zero, and `cv-files` is the reason this flow works.
- Print or commit a credential, and do not relax a `[fail]` check - each one
  guards a failure that already happened once.
