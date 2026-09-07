import json
import os
import datetime
from datetime import timezone

import config

MODEL_STATE_FILE = getattr(config, "MODEL_STATE_FILE", "model_state.json")
UNAVAILABLE_TTL_HOURS = getattr(config, "MODEL_UNAVAILABLE_TTL_HOURS", 24)


def _now_iso():
    return datetime.datetime.now(timezone.utc).isoformat()


def _empty_state():
    return {
        "current_model": config.MODEL_NAME,
        "unavailable": [],
        "updated_at": None,
    }


def load_state():
    """Load the persisted model state, or return a default state if missing/broken."""
    if os.path.exists(MODEL_STATE_FILE):
        try:
            with open(MODEL_STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception as e:
            print(f"⚠️  Could not read model state file '{MODEL_STATE_FILE}': {e}")
    return _empty_state()


def save_state(state):
    state["updated_at"] = _now_iso()
    try:
        with open(MODEL_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️  Could not write model state file '{MODEL_STATE_FILE}': {e}")


def _is_stale(recorded_at):
    """True when an 'unavailable' record is old enough to reconsider the model."""
    if not recorded_at:
        return False
    try:
        ts = datetime.datetime.fromisoformat(recorded_at)
    except Exception:
        return False
    age_hours = (datetime.datetime.now(timezone.utc) - ts).total_seconds() / 3600.0
    return age_hours > UNAVAILABLE_TTL_HOURS


def unavailable_names(state):
    """Names of models currently flagged unavailable (stale entries ignored)."""
    names = set()
    for u in state.get("unavailable", []):
        name = u.get("name")
        if name and not _is_stale(u.get("recorded_at")):
            names.add(name)
    return names


def preferred_available(state):
    """Known-good models, ordered by PREFERRED_MODELS preference (stale/failed excluded)."""
    skip = unavailable_names(state)
    return [m for m in config.PREFERRED_MODELS if m not in skip]


def next_available_model(state, after_model):
    """The next preferred model after `after_model` that is currently available."""
    avail = preferred_available(state)
    try:
        idx = config.PREFERRED_MODELS.index(after_model)
    except ValueError:
        idx = -1
    for m in config.PREFERRED_MODELS[idx + 1:]:
        if m in avail:
            return m
    return None


def init_model_state():
    """Load persisted availability and set the startup MODEL_NAME.

    Returns the state. Resumes from the last known-good model, or the first
    available one, skipping models that recently failed (until TTL).
    """
    state = load_state()
    avail = preferred_available(state)
    current = state.get("current_model")
    if current in config.PREFERRED_MODELS and current in avail:
        config.MODEL_NAME = current
    elif avail:
        config.MODEL_NAME = avail[0]
    else:
        config.MODEL_NAME = config.PREFERRED_MODELS[0]
    state["current_model"] = config.MODEL_NAME
    save_state(state)
    failed = sorted(unavailable_names(state))
    print(f"📚 Model availability loaded: starting with '{config.MODEL_NAME}' "
          f"(skipping unavailable: {failed or 'none'}).")
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
    unavailable = [u for u in state.get("unavailable", []) if u.get("name") != failing_model]
    unavailable.append({"name": failing_model, "reason": reason, "recorded_at": _now_iso()})
    state["unavailable"] = unavailable
    state["current_model"] = next_model
    save_state(state)
    return next_model
