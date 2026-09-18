"""Directory queue semantics (the backend used by tests and local POCs)."""

import os
import tempfile

from tests.helpers import isolated_config, list_dir, sample_task
from utils.messaging import HandlerResult, get_queue


def _files(queue, bucket):
    # Buckets are created lazily on first write, so a missing dir means "empty".
    return list_dir(os.path.join(queue.base_dir, bucket))


def test_publish_then_consume_acks_and_moves_to_processed():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            queue = get_queue("directory")
            queue.publish(sample_task())
            assert queue.depth() == 1

            seen = []
            processed = queue.consume(
                lambda delivery: seen.append(delivery.payload["external_id"])
                or HandlerResult.ack(),
                max_messages=1,
            )

            assert processed == 1
            assert seen == ["848944"]
            assert len(_files(queue, "processed")) == 1
            assert _files(queue, "failed") == []


def test_retry_moves_message_back_for_another_pass_with_attempt_bump():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            queue = get_queue("directory")
            queue.publish(sample_task())
            queue.consume(lambda delivery: HandlerResult.retry("transient"), max_messages=1)

            assert len(_files(queue, "retry")) == 1

            # Second pass observes the incremented attempt counter.
            attempts = []
            queue.consume(
                lambda delivery: attempts.append(delivery.payload["attempt"])
                or HandlerResult.ack(),
                max_messages=1,
            )
            assert attempts == [1]
            assert len(_files(queue, "processed")) == 1


def test_dead_letter_moves_message_to_failed():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            queue = get_queue("directory")
            queue.publish(sample_task())
            queue.consume(
                lambda delivery: HandlerResult.dead_letter("poison"), max_messages=1
            )
            assert len(_files(queue, "failed")) == 1
            assert _files(queue, "processed") == []


def test_drain_returns_when_queue_is_empty():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            queue = get_queue("directory")
            assert queue.pending_count() == 0
            assert queue.consume(lambda delivery: HandlerResult.ack(), max_messages=0) == 0


def test_handler_exception_requeues_and_the_loop_keeps_going():
    """A crashing handler must not kill the consumer (matches AMQP nack)."""
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            queue = get_queue("directory")
            queue.publish(sample_task(external_id="1"))
            queue.publish(sample_task(external_id="2"))

            calls = {"count": 0}

            def handler(delivery):
                calls["count"] += 1
                if calls["count"] == 1:
                    raise RuntimeError("boom")
                return HandlerResult.ack()

            processed = queue.consume(handler, max_messages=2)

            assert processed == 2
            assert len(_files(queue, "retry")) == 1
            assert len(_files(queue, "processed")) == 1
