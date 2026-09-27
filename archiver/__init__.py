"""The inactivity sweep: applied cards nobody is working on are refused in place.

Entry point: `python -m archiver` (`__main__.py` -> `run.main`). Read `archiver/AGENTS.md` for
what this layer deliberately does not do (no move, no `resumes.status`, no queue, no delete).
"""

from archiver import run  # noqa: F401  (one import for the layer)

__all__ = ["run"]
