"""Model-availability ledger (file backend, shared-store semantics)."""

import datetime
import tempfile

import config
from tests.helpers import isolated_config
from utils import model_state


def test_init_model_state_starts_from_first_preferred_model():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            state = model_state.init_model_state()
            assert config.MODEL_NAME == config.PREFERRED_MODELS[0]
            assert state["current_model"] == config.MODEL_NAME


def test_advance_after_failure_marks_unavailable_and_switches_model():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            failing = config.PREFERRED_MODELS[0]
            next_model = model_state.advance_after_failure(failing, "retry ceiling reached")

            assert next_model == config.PREFERRED_MODELS[1]
            state = model_state.load_state()
            assert failing in model_state.unavailable_names(state)
            assert state["current_model"] == next_model

            # Resuming a fresh process keeps skipping the failed model.
            model_state.reset_store_cache()
            assert model_state.init_model_state()["current_model"] == next_model


def test_unavailable_entries_expire_after_ttl():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            state = model_state.load_state()
            stale = (
                datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=48)
            ).isoformat()
            fresh = datetime.datetime.now(datetime.UTC).isoformat()
            state["unavailable"] = [
                {"name": config.PREFERRED_MODELS[0], "reason": "old", "recorded_at": stale},
                {"name": config.PREFERRED_MODELS[1], "reason": "new", "recorded_at": fresh},
            ]
            model_state.save_state(state)

            unavailable = model_state.unavailable_names(model_state.load_state())
            assert config.PREFERRED_MODELS[0] not in unavailable
            assert config.PREFERRED_MODELS[1] in unavailable


def test_advance_returns_none_when_every_model_is_exhausted():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            state = model_state.load_state()
            state["unavailable"] = [
                {"name": model, "reason": "rate limited", "recorded_at": None}
                for model in config.PREFERRED_MODELS
            ]
            # recorded_at=None is treated as current (not stale), so all are skipped.
            model_state.save_state(state)
            assert model_state.advance_after_failure(config.PREFERRED_MODELS[0], "x") is None


def test_next_available_model_walks_the_preference_order():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            state = model_state.load_state()
            state["unavailable"] = [
                {"name": config.PREFERRED_MODELS[1], "reason": "429", "recorded_at": None}
            ]
            assert (
                model_state.next_available_model(state, config.PREFERRED_MODELS[0])
                == config.PREFERRED_MODELS[2]
            )
