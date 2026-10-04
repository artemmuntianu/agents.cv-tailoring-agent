"""The readiness heartbeat: an idle consumer must not look dead.

`healthcheck.py --mode readiness` (every pod's readiness probe) reads the heartbeat file, and the
process only wrote it at start-up and after each task - so a consumer with `minReplicas: 1` that
waits longer than `HEARTBEAT_MAX_AGE_SECONDS` for work reported itself unhealthy, which also made
`helm upgrade --wait` fail on a perfectly healthy worker.
"""

import tempfile
import threading
import time

import config
from tests.helpers import isolated_config
from utils import logging_setup


def test_the_heartbeat_thread_keeps_an_idle_consumer_ready(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            # A real interval is 15s+; the mechanism is what is under test, not the wait.
            monkeypatch.setattr(logging_setup, "HEARTBEAT_TICK_SECONDS", 1)
            monkeypatch.setattr(config, "HEARTBEAT_MAX_AGE_SECONDS", 3)
            stop = threading.Event()
            # Nothing has written it yet (the entry points write it at start-up): only the thread
            # can make the probe happy.
            assert logging_setup.heartbeat_age_seconds() is None
            thread = logging_setup.start_heartbeat_thread(stop)
            try:
                deadline = time.time() + 5
                while logging_setup.heartbeat_age_seconds() is None and time.time() < deadline:
                    time.sleep(0.05)
                age = logging_setup.heartbeat_age_seconds()
                assert age is not None, "the idle thread never refreshed the heartbeat"
                assert age < config.HEARTBEAT_MAX_AGE_SECONDS
            finally:
                stop.set()
                thread.join(timeout=5)
            assert not thread.is_alive()


def test_the_thread_is_a_daemon_and_survives_a_process_that_never_stops(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            monkeypatch.setattr(logging_setup, "HEARTBEAT_TICK_SECONDS", 1)
            thread = logging_setup.start_heartbeat_thread()
            assert thread.daemon is True
            assert thread.is_alive()
