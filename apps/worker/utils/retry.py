import functools
import sys
import time
from datetime import UTC, datetime, timedelta

from google.genai.errors import APIError

import config
from utils import model_state
from utils.logging_setup import get_logger

log = get_logger(__name__)


class RetryLater(Exception):
    """Raised when work cannot proceed now but should be retried later.

    The worker converts this into a delayed re-publish on the queue instead of
    blocking a pod on interactive input (containers have no TTY).
    """

    def __init__(self, reason: str, delay_seconds: float | None = None):
        super().__init__(reason)
        self.reason = reason
        self.delay_seconds = delay_seconds


def _interactive_quota_wait_enabled() -> bool:
    """Quota waiting is interactive only when a human is actually attached."""
    if config.INTERACTIVE_QUOTA_WAIT is None:
        try:
            return sys.stdin is not None and sys.stdin.isatty()
        except (AttributeError, ValueError):
            return False
    return bool(config.INTERACTIVE_QUOTA_WAIT)


def wait_until_midnight_utc():
    now_utc = datetime.now(UTC)
    tomorrow_utc = (now_utc + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    seconds_remaining = int((tomorrow_utc - now_utc).total_seconds())

    log.warning(
        "daily quota (RPD) exhausted - resets at 00:00 UTC",
        seconds_remaining=seconds_remaining,
    )

    if not _interactive_quota_wait_enabled():
        # Headless (pod) mode: hand the task back to the queue for a later retry.
        raise RetryLater("daily quota exhausted", delay_seconds=seconds_remaining)

    user_choice = input(
        "👉 Enter 'w' to wait until 00:00 UTC, or any other key to abort: "
    ).strip().lower()
    if user_choice != "w":
        log.error("operation cancelled by user")
        raise SystemExit(1)

    while seconds_remaining > 0:
        mins, secs = divmod(seconds_remaining, 60)
        hours, mins = divmod(mins, 60)
        timer_str = f"{hours:02d}:{mins:02d}:{secs:02d}"
        print(f"\r⏳ Quota Reset Countdown: {timer_str}", end="", flush=True)
        time.sleep(1)
        seconds_remaining -= 1
    print("\n✅ Midnight UTC reached! Resuming operation...")


def _advance_model():
    """Advance config.MODEL_NAME to the next available preferred model.

    The failing model is recorded as unavailable in the persisted model state so
    future runs resume from a known-good model. Returns True if a fallback model
    was selected, False if no further model is available.
    """
    next_model = model_state.advance_after_failure(
        config.MODEL_NAME, "retry ceiling reached"
    )
    if next_model is None:
        log.warning("all preferred models exhausted; re-raising the rate-limit error")
        return False
    config.MODEL_NAME = next_model
    log.warning("rate limited on previous model - switching model", model=config.MODEL_NAME)
    return True


def _is_retryable(error_msg, status_code=None):
    """Return True for transient 429 / 503 style errors that warrant a retry."""
    if status_code is not None and str(status_code) in ("429", "503"):
        return True
    haystack = str(error_msg).lower()
    retryable_tokens = (
        "429", "503", "resourceexhausted", "toomanyrequests",
        "unavailable", "high demand", "try again later", "rate limit",
    )
    return any(t in haystack for t in retryable_tokens)


def _is_daily_quota(error_msg):
    haystack = str(error_msg).lower()
    return any(t in haystack for t in ("daily", "per_day", "rpd"))


def _handle_transient(error_msg, retries, delay, exc):
    """Back off on a transient error; advance to the next model on the ceiling.

    Returns (retries, delay) to continue the retry loop, or raises when no
    fallback model remains.
    """
    if _is_daily_quota(error_msg):
        if _advance_model():
            return 0, config.BACKOFF_INITIAL_DELAY
        wait_until_midnight_utc()
        return retries, delay

    retries += 1
    if retries > config.BACKOFF_MAX_RETRIES:
        if _advance_model():
            return 0, config.BACKOFF_INITIAL_DELAY
        if "503" in error_msg or "unavailable" in error_msg or "high demand" in error_msg:
            log.error("max retries reached for 503 UNAVAILABLE error", retries=config.BACKOFF_MAX_RETRIES)
        else:
            log.error("max retries reached for 429 rate-limit error", retries=config.BACKOFF_MAX_RETRIES)
        raise exc

    log.warning(
        "transient API error - backing off",
        retry=retries,
        max_retries=config.BACKOFF_MAX_RETRIES,
        delay_seconds=round(delay, 1),
    )
    time.sleep(delay)
    return retries, min(delay * config.BACKOFF_FACTOR, config.BACKOFF_MAX_DELAY)


def retry_with_exponential_backoff(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        delay = config.BACKOFF_INITIAL_DELAY
        retries = 0
        while True:
            try:
                return func(*args, **kwargs)
            except APIError as e:
                error_msg = str(e).lower()
                status_code = getattr(e, "code", None)
                if _is_retryable(error_msg, status_code):
                    retries, delay = _handle_transient(error_msg, retries, delay, e)
                else:
                    raise e
            except Exception as e:
                error_msg = str(e).lower()
                if _is_retryable(error_msg, getattr(e, "code", None)):
                    retries, delay = _handle_transient(error_msg, retries, delay, e)
                else:
                    raise e
    return wrapper
