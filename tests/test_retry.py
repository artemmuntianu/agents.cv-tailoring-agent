"""Retry/backoff layer - especially the headless (pod) quota behaviour."""

import tempfile
from unittest import mock

import pytest

import config
from tests.helpers import isolated_config
from utils import retry


def test_retryable_error_detection():
    assert retry._is_retryable("429 resource exhausted")
    assert retry._is_retryable("503 UNAVAILABLE high demand")
    assert retry._is_retryable("anything", status_code=429)
    assert not retry._is_retryable("invalid api key")


def test_daily_quota_detection():
    assert retry._is_daily_quota("quota exceeded: per_day limit")
    assert retry._is_daily_quota("RPD reached")
    assert not retry._is_daily_quota("429 rate limit")


def test_quota_wait_raises_retry_later_when_headless():
    """A pod must never block on input(); it hands the task back instead."""
    with isolated_config(tempfile.mkdtemp()):
        with mock.patch.object(config, "INTERACTIVE_QUOTA_WAIT", False):
            with pytest.raises(retry.RetryLater) as excinfo:
                retry.wait_until_midnight_utc()
    assert excinfo.value.delay_seconds and excinfo.value.delay_seconds > 0
    assert "quota" in excinfo.value.reason


def test_retry_decorator_retries_transient_errors_then_succeeds():
    attempts = {"count": 0}

    @retry.retry_with_exponential_backoff
    def flaky():
        attempts["count"] += 1
        if attempts["count"] < 2:
            raise RuntimeError("429 too many requests")
        return "ok"

    with isolated_config(tempfile.mkdtemp()):
        with mock.patch.object(config, "BACKOFF_INITIAL_DELAY", 0.0), \
                mock.patch.object(config, "BACKOFF_MAX_RETRIES", 3), \
                mock.patch("time.sleep", lambda *_: None):
            assert flaky() == "ok"
    assert attempts["count"] == 2


def test_non_retryable_error_propagates_immediately():
    @retry.retry_with_exponential_backoff
    def boom():
        raise ValueError("invalid api key")

    with pytest.raises(ValueError):
        boom()
