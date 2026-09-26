"""Queue abstraction for the event-driven pipeline.

Two interchangeable backends implement the same tiny contract:

* ``directory`` - JSON messages as files under `artifacts/queue/`. Lets the whole
  worker loop run (and be tested) with no broker at all.
* ``amqp``      - RabbitMQ via pika, matching the architecture doc: durable
  queue `resumes.generate`, `prefetch_count = 1`, manual ack, a dead-letter
  exchange for poison messages and TTL retry queues for delayed re-delivery
  (used when the Gemini quota is exhausted).

A handler returns a `HandlerResult` and the backend translates it into broker
semantics, so the pipeline never touches AMQP details.
"""

import json
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from enum import StrEnum

import config
from utils.logging_setup import get_logger

log = get_logger(__name__)

# Delayed-retry ladder: the smallest rung >= the requested delay is used.
RETRY_LADDER_SECONDS = (60, 300, 900, 1800, 3600)

try:  # pika is optional outside of AMQP mode
    import pika

    PIKA_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only without the dep
    pika = None
    PIKA_AVAILABLE = False


class Outcome(StrEnum):
    """What the broker should do with the message after the handler ran."""

    ACK = "ack"
    RETRY = "retry"  # immediate redelivery (transient failure)
    RETRY_LATER = "retry_later"  # delayed redelivery (quota / backoff)
    DEAD_LETTER = "dead_letter"  # park it, never retry


@dataclass
class HandlerResult:
    outcome: Outcome = Outcome.ACK
    delay_seconds: float | None = None
    reason: str = ""

    @classmethod
    def ack(cls, reason: str = ""):
        return cls(Outcome.ACK, reason=reason)

    @classmethod
    def retry(cls, reason: str = ""):
        return cls(Outcome.RETRY, reason=reason)

    @classmethod
    def retry_later(cls, delay_seconds=None, reason: str = ""):
        return cls(Outcome.RETRY_LATER, delay_seconds=delay_seconds, reason=reason)

    @classmethod
    def dead_letter(cls, reason: str = ""):
        return cls(Outcome.DEAD_LETTER, reason=reason)


@dataclass
class Delivery:
    payload: dict
    delivery_tag: object = None
    redelivered: bool = False
    backend: str = ""
    source: str = ""
    meta: dict = field(default_factory=dict)


class BaseQueue:
    backend = "base"

    def publish(self, payload, **kwargs):
        raise NotImplementedError

    def consume(self, handler, max_messages=None, stop_event=None):
        raise NotImplementedError

    def depth(self):
        """Best-effort queue depth (used by the local worker loop)."""
        return None

    def close(self):
        pass


class DirectoryQueue(BaseQueue):
    """JSON-file queue: `incoming/` -> `inflight/` -> `processed|failed|retry/`."""

    backend = "directory"

    def __init__(self, base_dir=None, poll_interval=None):
        self.base_dir = base_dir or config.QUEUE_DIR
        self.poll_interval = poll_interval or config.CONSUMER_POLL_INTERVAL
        self._stop = False

    def _dir(self, name):
        path = os.path.join(self.base_dir, name)
        os.makedirs(path, exist_ok=True)
        return path

    def publish(self, payload, **kwargs):
        target = os.path.join(self._dir("incoming"), f"{uuid.uuid4().hex}.json")
        tmp_path = f"{target}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(tmp_path, target)
        return target

    def depth(self):
        return len(os.listdir(self._dir("incoming")))

    def pending_count(self):
        """Everything that still needs a pass (fresh + deferred retries)."""
        return len(self._pending())

    def _load(self, path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    def _pending(self):
        incoming = sorted(os.listdir(self._dir("incoming")))
        retry = sorted(os.listdir(self._dir("retry")))
        return [("incoming", name) for name in incoming] + [
            ("retry", name) for name in retry
        ]

    def consume(self, handler, max_messages=None, stop_event=None):
        processed = 0
        while not self._stop:
            if stop_event is not None and stop_event.is_set():
                break

            pending = self._pending()
            if not pending:
                if max_messages is not None:
                    break
                time.sleep(self.poll_interval)
                continue

            bucket, name = pending[0]
            source_path = os.path.join(self.base_dir, bucket, name)
            inflight_path = os.path.join(self._dir("inflight"), name)
            try:
                os.replace(source_path, inflight_path)
            except OSError:  # another worker grabbed it
                continue

            try:
                payload = self._load(inflight_path)
            except Exception as exc:  # noqa: BLE001
                log.error("unreadable queue message", file=name, error=str(exc))
                shutil.move(inflight_path, os.path.join(self._dir("failed"), name))
                continue

            delivery = Delivery(
                payload=payload, backend=self.backend, source=f"{bucket}/{name}"
            )
            try:
                result = handler(delivery) or HandlerResult.ack()
            except Exception as exc:  # noqa: BLE001 - keep the loop alive
                log.exception("handler crashed - requeueing", error=str(exc))
                result = HandlerResult.retry(reason=f"handler crash: {exc}")
            self._settle(name, inflight_path, result, payload)
            processed += 1

            if max_messages is not None and processed >= max_messages:
                break
        return processed

    def _settle(self, name, inflight_path, result, payload):
        if result.outcome == Outcome.ACK:
            shutil.move(inflight_path, os.path.join(self._dir("processed"), name))
        elif result.outcome == Outcome.DEAD_LETTER:
            shutil.move(inflight_path, os.path.join(self._dir("failed"), name))
        else:  # RETRY / RETRY_LATER -> back for another pass
            updated = dict(payload)
            updated["attempt"] = int(payload.get("attempt") or 0) + 1
            updated["last_retry_reason"] = result.reason
            with open(inflight_path, "w", encoding="utf-8") as handle:
                json.dump(updated, handle, ensure_ascii=False, indent=2)
            shutil.move(inflight_path, os.path.join(self._dir("retry"), name))

    def stop(self):
        self._stop = True


class AmqpQueue(BaseQueue):
    """RabbitMQ consumer/publisher (pika, manual ack, DLX + retry ladder)."""

    backend = "amqp"

    def __init__(self, url=None, queue_name=None, dlx=None, dlq=None, prefetch=None):
        if not PIKA_AVAILABLE:
            raise RuntimeError(
                "pika is not installed - add it to requirements.txt or use "
                "QUEUE_BACKEND=directory"
            )
        self.url = url or config.RABBITMQ_URL
        self.queue_name = queue_name or config.QUEUE_NAME
        self.dlx = dlx or config.QUEUE_DLX
        self.dlq = dlq or config.QUEUE_DLQ
        self.prefetch = int(prefetch or config.PREFETCH_COUNT)
        self._connection = None
        self._channel = None
        self._stop = False
        self._received = 0
        self._max_messages = None

    # -- topology ---------------------------------------------------------- #
    def _retry_queue_name(self, seconds):
        return f"{self.queue_name}.retry.{int(seconds)}s"

    def _retry_queue_for(self, delay_seconds):
        requested = float(delay_seconds or 0)
        for rung in RETRY_LADDER_SECONDS:
            if requested <= rung:
                return self._retry_queue_name(rung)
        return self._retry_queue_name(RETRY_LADDER_SECONDS[-1])

    def _declare_topology(self):
        channel = self._channel
        channel.exchange_declare(exchange=self.dlx, exchange_type="direct", durable=True)
        channel.queue_declare(queue=self.dlq, durable=True)
        channel.queue_bind(queue=self.dlq, exchange=self.dlx, routing_key=self.dlq)

        for seconds in RETRY_LADDER_SECONDS:
            channel.queue_declare(
                queue=self._retry_queue_name(seconds),
                durable=True,
                arguments={
                    "x-message-ttl": int(seconds) * 1000,
                    # Default exchange routes straight back to the main queue.
                    "x-dead-letter-exchange": "",
                    "x-dead-letter-routing-key": self.queue_name,
                },
            )

        channel.queue_declare(
            queue=self.queue_name,
            durable=True,
            arguments={
                "x-dead-letter-exchange": self.dlx,
                "x-dead-letter-routing-key": self.dlq,
            },
        )
        channel.basic_qos(prefetch_count=self.prefetch)

    def connect(self):
        parameters = pika.URLParameters(self.url)
        # See config.AMQP_HEARTBEAT_SECONDS: a long task blocks this connection's
        # I/O loop, so a 60s heartbeat makes the broker drop it mid-task and requeue
        # the message.
        parameters.heartbeat = config.AMQP_HEARTBEAT_SECONDS
        parameters.blocked_connection_timeout = 300
        parameters.connection_attempts = 3
        parameters.retry_delay = 5
        self._connection = pika.BlockingConnection(parameters)
        self._channel = self._connection.channel()
        self._declare_topology()
        return self._connection

    # -- publishing -------------------------------------------------------- #
    def _publish(self, payload, routing_key):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._channel.basic_publish(
            exchange="",
            routing_key=routing_key,
            body=body,
            properties=pika.BasicProperties(
                content_type="application/json", delivery_mode=2
            ),
        )

    def publish(self, payload, **kwargs):
        if self._connection is None or self._connection.is_closed:
            self.connect()
        self._publish(payload, self.queue_name)
        return True

    def depth(self):
        try:
            if self._connection is None or self._connection.is_closed:
                self.connect()
            result = self._channel.queue_declare(
                queue=self.queue_name, durable=True, passive=True
            )
            return result.method.message_count
        except Exception as exc:  # noqa: BLE001
            log.warning("could not read queue depth", error=str(exc))
            return None

    # -- consuming --------------------------------------------------------- #
    def consume(self, handler, max_messages=None, stop_event=None):
        self._max_messages = max_messages
        processed = 0
        while not self._stop:
            if stop_event is not None and stop_event.is_set():
                break
            try:
                self.connect()
                self._received = 0
                self._channel.basic_consume(
                    queue=self.queue_name,
                    on_message_callback=self._make_callback(handler),
                    auto_ack=False,
                )
                log.info(
                    "consuming queue",
                    queue=self.queue_name,
                    prefetch=self.prefetch,
                    broker=self._sanitized_url(),
                )
                self._channel.start_consuming()
                processed += self._received
                if max_messages is not None and processed >= max_messages:
                    break
                if self._stop:
                    break
                log.warning("consumer loop ended - reconnecting")
            except Exception as exc:  # noqa: BLE001
                log.error("amqp consumer error - reconnecting", error=str(exc))
                self._close_connection()
                if self._stop:
                    break
                time.sleep(min(config.CONSUMER_POLL_INTERVAL * 2, 30))
        return processed

    def _make_callback(self, handler):
        def _callback(channel, method, properties, body):
            try:
                payload = json.loads(body.decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                log.error("undecodable message - dead-lettering", error=str(exc))
                channel.basic_publish(
                    exchange=self.dlx,
                    routing_key=self.dlq,
                    body=body,
                    properties=pika.BasicProperties(delivery_mode=2),
                )
                channel.basic_ack(delivery_tag=method.delivery_tag)
                return

            delivery = Delivery(
                payload=payload,
                delivery_tag=method.delivery_tag,
                redelivered=bool(method.redelivered),
                backend=self.backend,
                source=self.queue_name,
            )
            try:
                result = handler(delivery) or HandlerResult.ack()
            except Exception as exc:  # noqa: BLE001
                log.error("handler crashed - requeueing", error=str(exc))
                channel.basic_nack(delivery_tag=method.delivery_tag, requeue=True)
                return

            self._acknowledge(channel, method.delivery_tag, payload, result)

        return _callback

    def _acknowledge(self, channel, delivery_tag, payload, result):
        if result.outcome == Outcome.ACK:
            channel.basic_ack(delivery_tag=delivery_tag)
        elif result.outcome == Outcome.RETRY:
            channel.basic_nack(delivery_tag=delivery_tag, requeue=True)
        elif result.outcome == Outcome.DEAD_LETTER:
            self._publish(payload, self.dlq)
            channel.basic_ack(delivery_tag=delivery_tag)
        else:  # RETRY_LATER -> TTL queue, then back to the main queue
            retry_queue = self._retry_queue_for(result.delay_seconds)
            self._publish(payload, retry_queue)
            channel.basic_ack(delivery_tag=delivery_tag)

        self._received += 1
        if self._max_messages is not None and self._received >= self._max_messages:
            log.info("reached max_messages - stopping consumer", max=self._max_messages)
            self.stop()

    # -- lifecycle --------------------------------------------------------- #
    def _sanitized_url(self):
        try:
            parameters = pika.URLParameters(self.url)
            return f"amqp://{parameters.host}:{parameters.port}"
        except Exception:  # noqa: BLE001
            return "amqp://<unparsed>"

    def stop(self):
        """Thread-safe stop (called from a SIGTERM handler)."""
        self._stop = True
        try:
            if self._connection is not None and not self._connection.is_closed:
                self._connection.add_callback_threadsafe(self._stop_consuming)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not signal consumer stop", error=str(exc))

    def _stop_consuming(self):
        try:
            if self._channel is not None and self._channel.is_open:
                self._channel.stop_consuming()
        except Exception:  # noqa: BLE001
            pass

    def _close_connection(self):
        try:
            if self._connection is not None and not self._connection.is_closed:
                self._connection.close()
        except Exception:  # noqa: BLE001
            pass
        self._connection = None
        self._channel = None

    def close(self):
        self._close_connection()


_QUEUE_CACHE = {}


def get_queue(backend=None, **kwargs):
    """Return a queue for the configured backend."""
    backend = (backend or config.QUEUE_BACKEND or "directory").strip().lower()
    if backend not in _QUEUE_CACHE:
        _QUEUE_CACHE[backend] = (
            AmqpQueue(**kwargs) if backend == "amqp" else DirectoryQueue(**kwargs)
        )
    return _QUEUE_CACHE[backend]


def reset_queue_cache():
    """Test helper: forget cached queues."""
    _QUEUE_CACHE.clear()
