import time
import functools
from datetime import datetime, timezone, timedelta
from google.genai.errors import APIError
import config
from utils import model_state

def wait_until_midnight_utc():
    now_utc = datetime.now(timezone.utc)
    tomorrow_utc = (now_utc + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    seconds_remaining = int((tomorrow_utc - now_utc).total_seconds())
    
    print(f"\n⚠️  Daily Quota (RPD) Exhausted! Reset at 00:00 UTC ({seconds_remaining} seconds remaining).")
    
    user_choice = input("👉 Enter 'w' to wait until 00:00 UTC, or any other key to abort: ").strip().lower()
    if user_choice != 'w':
        print("❌ Operation cancelled by user.")
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
    next_model = model_state.advance_after_failure(config.MODEL_NAME, "retry ceiling reached")
    if next_model is None:
        print("⚠️  All preferred models exhausted; re-raising the rate-limit error.")
        return False
    config.MODEL_NAME = next_model
    print(f"\n🔁 Rate limit on previous model — switching MODEL_NAME to '{config.MODEL_NAME}'.")
    return True


def _is_retryable(error_msg, status_code=None):
    """Return True for transient 429 / 503 style errors that warrant a retry."""
    if status_code is not None and str(status_code) in ("429", "503"):
        return True
    retryable_tokens = (
        "429", "503", "resourceexhausted", "toomanyrequests",
        "unavailable", "high demand", "try again later", "rate limit",
    )
    return any(t in error_msg for t in retryable_tokens)


def _is_daily_quota(error_msg):
    return any(t in error_msg for t in ("daily", "per_day", "rpd"))


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
            print(f"❌ Max retries ({config.BACKOFF_MAX_RETRIES}) reached for 503 UNAVAILABLE error.")
        else:
            print(f"❌ Max retries ({config.BACKOFF_MAX_RETRIES}) reached for 429 Rate Limit error.")
        raise exc

    print(f"⚠️  Transient API error encountered. Backing off for {delay:.1f}s (Retry {retries}/{config.BACKOFF_MAX_RETRIES})...")
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
