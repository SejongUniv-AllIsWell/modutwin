import logging
from collections.abc import Iterable, Sequence
from typing import Any

from kombu import Connection, Producer

from app.core.config import get_settings

logger = logging.getLogger(__name__)

DEFAULT_CELERY_QUEUES = ("training", "alignment", "sog")


def _message_task_id(message: Any) -> str | None:
    properties = getattr(message, "properties", None) or {}
    headers = getattr(message, "headers", None) or properties.get("application_headers") or {}
    task_id = headers.get("id") or properties.get("correlation_id")
    return str(task_id) if task_id else None


def _message_count(channel: Any, queue_name: str) -> int:
    declare_ok = channel.queue_declare(queue=queue_name, passive=True)
    return int(getattr(declare_ok, "message_count", 0) or 0)


def _delivery_tag(message: Any) -> int:
    delivery_info = getattr(message, "delivery_info", None) or {}
    return int(delivery_info["delivery_tag"])


def _republish_message(channel: Any, queue_name: str, message: Any) -> None:
    properties = dict(getattr(message, "properties", None) or {})
    application_headers = properties.pop("application_headers", None)
    headers = dict(getattr(message, "headers", None) or application_headers or {})
    content_type = properties.pop("content_type", None)
    content_encoding = properties.pop("content_encoding", None)
    delivery_mode = properties.pop("delivery_mode", None)
    priority = properties.pop("priority", 0) or 0

    delivery_info = getattr(message, "delivery_info", None) or {}
    exchange = delivery_info.get("exchange") or ""
    routing_key = delivery_info.get("routing_key") or queue_name

    Producer(channel).publish(
        message.body,
        exchange=exchange,
        routing_key=routing_key,
        serializer=None,
        content_type=content_type,
        content_encoding=content_encoding,
        headers=headers,
        delivery_mode=delivery_mode,
        priority=priority,
        **properties,
    )


def _drop_ready_messages_from_queue(channel: Any, queue_name: str, task_ids: set[str]) -> int:
    initial_count = _message_count(channel, queue_name)
    dropped = 0

    for _ in range(initial_count):
        message = channel.basic_get(queue=queue_name, no_ack=False)
        if message is None:
            break

        tag = _delivery_tag(message)
        task_id = _message_task_id(message)
        if task_id in task_ids:
            channel.basic_ack(tag)
            dropped += 1
            continue

        try:
            _republish_message(channel, queue_name, message)
        except Exception:
            channel.basic_reject(tag, requeue=True)
            raise
        else:
            channel.basic_ack(tag)

    return dropped


def drop_ready_celery_messages(
    celery_task_ids: Iterable[str],
    queue_names: Sequence[str] = DEFAULT_CELERY_QUEUES,
) -> int:
    """Best-effort removal of ready Celery messages for revoked tasks.

    Celery revoke does not remove messages already sitting in RabbitMQ when the
    target worker is offline. This scans ready messages only; active/unacked
    tasks are left to Celery revoke/terminate.
    """
    task_ids = {str(task_id) for task_id in celery_task_ids if task_id}
    if not task_ids:
        return 0

    settings = get_settings()
    dropped = 0
    try:
        with Connection(settings.RABBITMQ_URL, connect_timeout=3) as connection:
            connection.connect()
            for queue_name in queue_names:
                channel = connection.channel()
                try:
                    dropped += _drop_ready_messages_from_queue(channel, queue_name, task_ids)
                except Exception:
                    logger.exception("[celery_broker_cleanup] queue scan failed: queue=%s", queue_name)
                finally:
                    try:
                        channel.close()
                    except Exception:
                        logger.debug("[celery_broker_cleanup] channel close failed", exc_info=True)
    except Exception:
        logger.exception("[celery_broker_cleanup] broker cleanup failed")

    if dropped:
        logger.info("[celery_broker_cleanup] dropped %s ready revoked task message(s)", dropped)
    return dropped
