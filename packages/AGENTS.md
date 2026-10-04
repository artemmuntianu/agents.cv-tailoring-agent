# packages/ - shared libraries (currently empty)

Reserved for code that **two or more apps** import. It is empty on purpose: today the
Python app in `apps/worker/` is the only consumer of `apps/worker/agent/`/`apps/worker/utils/`, so there is nothing
to lift out - a library that exactly one app owns belongs inside that app, not here.

## The rule

Promote code into `packages/<name>/` only when a **second** app starts importing it (for
example the backoffice and the extension begin sharing a module, or a second Python service
needs `apps/worker/utils/`). When that happens, in one change:

1. create `packages/<name>/` with its own manifest and its own `AGENTS.md`;
2. add it to the root `AGENTS.md` architecture map;
3. record the dependency direction in `CONSTITUTION.md` section 3.

Do not create a package "just in case": an unused package is a maintenance cost and a
second place for the truth to live. The root `pyproject.toml` stays the shared tooling
config (ruff + pytest) for the whole repo regardless.
