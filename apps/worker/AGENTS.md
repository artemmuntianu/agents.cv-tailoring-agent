# apps/worker/ - the Python image

The one deployable Python app: the LangGraph worker plus the two scheduled jobs
(`scout`, `archiver`), their shared adapters and the hermetic suite. **Everything in this
directory is the Docker build context** - `apps/worker/Dockerfile` builds the image that CI
and `scripts/local-deploy.ps1` ship, so a `.dockerignore`/`COPY` path is relative to here.

Read `CONSTITUTION.md` first; the sub-layers own their own mechanics:

| Path | Owns |
|---|---|
| `apps/worker/agent/` | LangGraph orchestration - state, contract, models, nodes, graph, pipeline (`apps/worker/agent/AGENTS.md`) |
| `apps/worker/utils/` | backend adapters + infrastructure - queue, DB, storage, model state, retry, DOCX mutator, renderer, logging (`apps/worker/utils/AGENTS.md`) |
| `apps/worker/scout/` | the scheduled RSS intake (`apps/worker/scout/AGENTS.md`) |
| `apps/worker/archiver/` | the scheduled inactivity sweep (`apps/worker/archiver/AGENTS.md`) |
| `apps/worker/tests/` | the hermetic verification layer (`apps/worker/tests/AGENTS.md`) |

## Entry points

| File | Role |
|---|---|
| `worker.py` | queue consumer (the pod) |
| `apply.py`, `cover.py`, `rerender.py` | the per-queue consumers |
| `publisher.py` | host-side dev stand-in for the API gateway |
| `healthcheck.py` | exec probes (`--mode liveness`, `readiness`, `amqp`, `render`, `all`) |
| `config.py` | every env-overridable setting (import-safe without provider SDKs) |

## Build & run

```sh
docker build -t cv-tailoring-worker:dev apps/worker   # image (context = this directory)
python -m pytest -q                                   # from the repo root (pyproject testpaths -> apps/worker/tests)
cd apps/worker && python -m scout --dry-run            # module paths resolve from here
```

`fonts/` is the build-time Calibri input: `scripts/fetch-fonts.ps1` fills it and the
Dockerfile bakes it in (`CONSTITUTION.md` D15). It is gitignored except for its README, and
it is **inside** the build context, so `.dockerignore` deliberately does not exclude it.

## Conventions

- Keep the dependency direction one-way: `apps/worker/agent/` -> `apps/worker/utils/` -> `config`; `apps/worker/utils/` must
  never import `apps/worker/agent/`.
- Configuration is read once, in `config.py`.
- `apps/worker/tests/conftest.py` and `apps/worker/tests/helpers.py` put this directory on `sys.path`, so tests
  import `config`, `agent`, `utils` as top-level modules - keep it that way (do not turn
  this into an installed package unless the layout truly needs it).
