"""Model-availability ledger.

Historically this was a single local JSON file, which breaks down once several
worker pods run in parallel (read-modify-write races) and is wiped every time
KEDA scales the deployment back to zero. The ledger therefore lives behind a
small store interface:

* ``file``     - the original local JSON behaviour (CLI / dev).
* ``postgres`` - shared, atomic upserts in Supabase/Postgres (cloud).

The public API (``init_model_state`` / ``advance_after_failure`` ...) is
unchanged so callers do not care which backend is active.
"""

import datetime
import json
import os

import config
from utils.logging_setup import get_logger

log = get_logger(__name__)


def _now_iso():
    return datetime.datetime.now(datetime.UTC).isoformat()


def _empty_state():
    return {
        "current_model": config.MODEL_NAME,
        "unavailable": [],
        "updated_at": None,
    }


def _normalize(state):
    if not isinstance(state, dict):
        return _empty_state()
    state.setdefault("current_model", config.MODEL_NAME)
    state.setdefault("unavailable", [])
    state.setdefault("updated_at", None)
    return state


class FileModelStateStore:
    """Local JSON implementation (atomic replace, single-writer semantics)."""

    backend = "file"

    def __init__(self, path=None):
        self.path = path

    @property
    def file_path(self):
        return self.path or config.MODEL_STATE_FILE

    def load(self):
        path = self.file_path
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as handle:
                    return _normalize(json.load(handle))
            except Exception as exc:  # noqa: BLE001 - never break the run
                log.warning("could not read model state file", path=path, error=str(exc))
        return _empty_state()

    def save(self, state):
        state["updated_at"] = _now_iso()
        path = self.file_path
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp_path = f"{path}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=False, indent=2)
            os.replace(tmp_path, path)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not write model state file", path=path, error=str(exc))


class PostgresModelStateStore:
    """Shared implementation: atomic upserts, survives scale-to-zero."""

    backend = "postgres"

    def __init__(self, db=None):
        self._db = db

    @property
    def db(self):
        if self._db is None:
            from utils import db as db_module

            self._db = db_module.get_db("postgres")
        return self._db

    def load(self):
        with self.db.connection() as conn:
            with conn.cursor() as cur:
                cur.execute("select value from app_settings where key = 'model_state'")
                row = cur.fetchone()
                cur.execute("select name, reason, recorded_at from model_availability")
                unavailable = [
                    {
                        "name": record["name"],
                        "reason": record["reason"],
                        "recorded_at": record["recorded_at"].isoformat()
                        if record["recorded_at"] is not None
                        else None,
                    }
                    for record in cur.fetchall()
                ]
        state = _empty_state()
        if row and row["value"]:
            value = row["value"]
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except Exception:  # noqa: BLE001
                    value = {}
            state.update(value or {})
        state["unavailable"] = unavailable
        return _normalize(state)

    def save(self, state):
        state["updated_at"] = _now_iso()
        payload = json.dumps(
            {
                "current_model": state.get("current_model"),
                "updated_at": state.get("updated_at"),
            }
        )
        with self.db.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into app_settings (key, value, updated_at)
                    values ('model_state', %s::jsonb, now())
                    on conflict (key) do update
                        set value = excluded.value, updated_at = now()
                    """,
                    (payload,),
                )
                cur.execute("delete from model_availability")
                for item in state.get("unavailable", []):
                    cur.execute(
                        """
                        insert into model_availability (name, reason, recorded_at)
                        values (%s, %s, now())
                        on conflict (name) do update
                            set reason = excluded.reason, recorded_at = now()
                        """,
                        (item.get("name"), item.get("reason")),
                    )
            conn.commit()


_STORE_CACHE = {}


def get_store(backend=None):
    """Return the configured store, falling back to the file backend."""
    backend = (backend or config.MODEL_STATE_BACKEND or "file").strip().lower()
    if backend in _STORE_CACHE:
        return _STORE_CACHE[backend]
    store = FileModelStateStore()
    if backend == "postgres":
        try:
            store = PostgresModelStateStore()
            store.db.ping()
        except Exception as exc:  # noqa: BLE001 - degrade loudly, never crash
            log.warning(
                "postgres model-state backend unavailable - falling back to file",
                error=str(exc),
            )
            store = FileModelStateStore()
    _STORE_CACHE[backend] = store
    return store


def reset_store_cache():
    """Test helper: forget cached stores."""
    _STORE_CACHE.clear()


# --------------------------------------------------------------------------- #
# Public API (unchanged signatures)
# --------------------------------------------------------------------------- #
def load_state():
    """Load the persisted model state, or return a default state if missing."""
    return get_store().load()


def save_state(state):
    get_store().save(state)


def _is_stale(recorded_at):
    """True when an 'unavailable' record is old enough to reconsider the model."""
    if not recorded_at:
        return False
    try:
        timestamp = datetime.datetime.fromisoformat(recorded_at)
    except Exception:  # noqa: BLE001
        return False
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=datetime.UTC)
    age_hours = (
        datetime.datetime.now(datetime.UTC) - timestamp
    ).total_seconds() / 3600.0
    return age_hours > config.MODEL_UNAVAILABLE_TTL_HOURS


def unavailable_names(state):
    """Names of models currently flagged unavailable (stale entries ignored)."""
    names = set()
    for item in state.get("unavailable", []):
        name = item.get("name")
        if name and not _is_stale(item.get("recorded_at")):
            names.add(name)
    return names


def preferred_available(state):
    """Known-good models, ordered by PREFERRED_MODELS (stale/failed excluded)."""
    skip = unavailable_names(state)
    return [m for m in config.PREFERRED_MODELS if m not in skip]


def next_available_model(state, after_model):
    """The next preferred model after `after_model` that is currently available."""
    available = preferred_available(state)
    try:
        index = config.PREFERRED_MODELS.index(after_model)
    except ValueError:
        index = -1
    for model in config.PREFERRED_MODELS[index + 1:]:
        if model in available:
            return model
    return None


def init_model_state():
    """Load persisted availability and set the startup MODEL_NAME.

    Returns the state. Resumes from the last known-good model, or the first
    available one, skipping models that recently failed (until TTL).
    """
    state = load_state()
    available = preferred_available(state)
    current = state.get("current_model")
    if current in config.PREFERRED_MODELS and current in available:
        config.MODEL_NAME = current
    elif available:
        config.MODEL_NAME = available[0]
    else:
        config.MODEL_NAME = config.PREFERRED_MODELS[0]
    state["current_model"] = config.MODEL_NAME
    save_state(state)
    failed = sorted(unavailable_names(state))
    log.info(
        "model availability loaded",
        model=config.MODEL_NAME,
        skipping=(",".join(failed) or "none"),
        backend=get_store().backend,
    )
    return state


def advance_after_failure(failing_model, reason):
    """Record `failing_model` as unavailable and return the next available model.

    Returns None when no further model is available (nothing gets persisted in
    that case, so the last model is not permanently bricked). The returned model
    is persisted as the new current_model, but config.MODEL_NAME is NOT mutated.
    """
    state = load_state()
    next_model = next_available_model(state, failing_model)
    if next_model is None:
        return None
    unavailable = [
        u for u in state.get("unavailable", []) if u.get("name") != failing_model
    ]
    unavailable.append(
        {"name": failing_model, "reason": reason, "recorded_at": _now_iso()}
    )
    state["unavailable"] = unavailable
    state["current_model"] = next_model
    save_state(state)
    return next_model
