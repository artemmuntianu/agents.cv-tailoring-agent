"""Structured logging for a long-running worker container.

`LOG_FORMAT=text` keeps the human-friendly console output the local CLI always
had; `LOG_FORMAT=json` emits one JSON object per line for container log
pipelines (Loki, journald, a log shipper). Both carry the same context keys
(`job_id`, `attempt`, `node`, ...) so a task can be traced across pods.
"""

import json
import logging
import os
import sys
import time

import config

_CONFIGURED = False

# LogRecord attributes that are part of the standard record; anything else that
# was passed via `extra=` is treated as a structured field.
_RESERVED = set(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys()
) | {"asctime", "message", "taskName"}


class _ContextFilter(logging.Filter):
    """Attach `service` and the fields passed through `extra=` to the record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.service = config.SERVICE_NAME
        fields = {}
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                fields[key] = value
        record.fields = fields
        return True


class _TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base = f"{self.formatTime(record, '%Y-%m-%dT%H:%M:%S')} {record.levelname:<7} [{record.name}]"
        fields = getattr(record, "fields", {})
        if fields:
            base += " " + " ".join(f"{k}={v}" for k, v in fields.items())
        message = record.getMessage()
        if record.exc_info:
            message = f"{message}\n{self.formatException(record.exc_info)}"
        return f"{base} {message}"


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "service": getattr(record, "service", config.SERVICE_NAME),
            "msg": record.getMessage(),
        }
        payload.update(getattr(record, "fields", {}))
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def setup_logging(level: str | None = None, fmt: str | None = None) -> None:
    """Configure the root logger once per process."""
    global _CONFIGURED
    if _CONFIGURED:
        return

    level = (level or config.LOG_LEVEL or "INFO").upper()
    fmt = (fmt or config.LOG_FORMAT or "text").lower()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter() if fmt == "json" else _TextFormatter())
    handler.addFilter(_ContextFilter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    for noisy in ("pika", "httpx", "httpcore", "urllib3", "google_genai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _CONFIGURED = True


class ContextLogger:
    """Thin logger wrapper that injects persistent key=value context.

    Usage::

        log = get_logger(__name__).bind(job_id="abc", attempt=1)
        log.info("node started")
    """

    def __init__(self, logger: logging.Logger, context: dict | None = None):
        self._logger = logger
        self._context = dict(context or {})

    def bind(self, **context) -> "ContextLogger":
        merged = dict(self._context)
        merged.update(context)
        return ContextLogger(self._logger, merged)

    def unbind(self, *keys) -> "ContextLogger":
        merged = {k: v for k, v in self._context.items() if k not in keys}
        return ContextLogger(self._logger, merged)

    # Keys that control `logging` itself rather than the structured payload.
    _LOGGING_CONTROL = ("exc_info", "stack_info", "stacklevel")

    def _log(self, level: int, message: str, **extra) -> None:
        control = {}
        for key in self._LOGGING_CONTROL:
            if key in extra:
                control[key] = extra.pop(key)

        fields = dict(self._context)
        for key, value in extra.items():
            # A field named like a LogRecord attribute (e.g. `name`, `module`)
            # would raise KeyError inside logging; keep the value but rename it.
            fields[f"{key}_value" if key in _RESERVED else key] = value

        self._logger.log(level, message, extra=dict(fields), **control)

    def debug(self, message: str, **extra) -> None:
        self._log(logging.DEBUG, message, **extra)

    def info(self, message: str, **extra) -> None:
        self._log(logging.INFO, message, **extra)

    def warning(self, message: str, **extra) -> None:
        self._log(logging.WARNING, message, **extra)

    warn = warning

    def error(self, message: str, **extra) -> None:
        self._log(logging.ERROR, message, **extra)

    def exception(self, message: str, **extra) -> None:
        self._log(logging.ERROR, message, exc_info=True, **extra)


def get_logger(name: str, **context) -> ContextLogger:
    setup_logging()
    return ContextLogger(logging.getLogger(name), context)


def utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def write_heartbeat(path: str | None = None) -> str:
    """Touch the liveness heartbeat file consumed by `healthcheck.py`."""
    target = path or config.HEARTBEAT_FILE
    directory = os.path.dirname(target)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(utc_now_iso())
    return target


def heartbeat_age_seconds(path: str | None = None):
    """Age of the heartbeat file in seconds, or None when it does not exist."""
    target = path or config.HEARTBEAT_FILE
    if not os.path.exists(target):
        return None
    return max(0.0, time.time() - os.path.getmtime(target))
