"""Telegram notification for the scheduled intake.

Only the scout notifies. A vacancy the operator scraped by hand is already in front of them (the
extension answers in the page), while a feed nobody browses by hand has to reach a phone - which
is the whole point of the bot. One message per new vacancy, plain text, no preview.

The token and the chat id are configuration (`SCOUT_TELEGRAM_TOKEN`/`_CHAT_ID`, the token from
the Secret): nothing here reads a file or hardcodes a chat. A failed notification is logged and
never fails the run - the card is already created, and that is the durable part.
"""

import json
import urllib.error
import urllib.request

import config
from utils.logging_setup import get_logger

log = get_logger(__name__)

API_URL = "https://api.telegram.org/bot{token}/sendMessage"


def build_message(vacancy: dict, source: str) -> str:
    """One vacancy as the few lines an operator reads on a lock screen."""
    lines = [f"🆕 {vacancy.get('title') or 'Vacancy'}"]
    if vacancy.get("company"):
        lines.append(f"🏢 {vacancy['company']}")
    where = " · ".join(part for part in (vacancy.get("location"), vacancy.get("salary")) if part)
    if where:
        lines.append(f"📍 {where}")
    lines.append(f"🔎 source: {source}")
    if vacancy.get("source_url"):
        lines.append(f"🔗 {vacancy['source_url']}")
    lines.append("Drag it into Prepare on the board to get a tailored CV.")
    return "\n".join(lines)


def _redact(text: str, token: str) -> str:
    """The token must never reach a log line, and urllib errors quote the URL."""
    return text.replace(token, "<token>") if token else text


def send(text: str, token: str | None = None, chat_id: str | None = None, timeout: int = 15) -> bool:
    """True when Telegram accepted the message."""
    token = (token if token is not None else config.SCOUT_TELEGRAM_TOKEN) or ""
    chat_id = (chat_id if chat_id is not None else config.SCOUT_TELEGRAM_CHAT_ID) or ""
    if not token or not chat_id:
        log.warning("telegram is not configured - skipping the notification")
        return False

    payload = json.dumps(
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
    ).encode("utf-8")
    request = urllib.request.Request(
        API_URL.format(token=token),
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return 200 <= int(response.status) < 300
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as exc:
        log.warning("telegram notification failed", error=_redact(str(exc), token))
        return False
