import time
import functools
from datetime import datetime, timezone, timedelta
from google.genai.errors import APIError
import config

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
                if status_code == 429 or "resourceexhausted" in error_msg or "toomanyrequests" in error_msg:
                    if "daily" in error_msg or "per_day" in error_msg or "rpd" in error_msg:
                        wait_until_midnight_utc()
                        continue
                    retries += 1
                    if retries > config.BACKOFF_MAX_RETRIES:
                        print(f"❌ Max retries ({config.BACKOFF_MAX_RETRIES}) reached for 429 Rate Limit error.")
                        raise e
                    print(f"⚠️  Rate limit 429 encountered. Backing off for {delay:.1f}s (Retry {retries}/{config.BACKOFF_MAX_RETRIES})...")
                    time.sleep(delay)
                    delay = min(delay * config.BACKOFF_FACTOR, config.BACKOFF_MAX_DELAY)
                else:
                    raise e
            except Exception as e:
                error_msg = str(e).lower()
                if "429" in error_msg or "resourceexhausted" in error_msg or "rate limit" in error_msg:
                    retries += 1
                    if retries > config.BACKOFF_MAX_RETRIES:
                        raise e
                    print(f"⚠️  Rate limit encountered. Backing off for {delay:.1f}s (Retry {retries}/{config.BACKOFF_MAX_RETRIES})...")
                    time.sleep(delay)
                    delay = min(delay * config.BACKOFF_FACTOR, config.BACKOFF_MAX_DELAY)
                else:
                    raise e
    return wrapper
