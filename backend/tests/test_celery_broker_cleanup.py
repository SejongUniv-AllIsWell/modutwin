from types import SimpleNamespace

from app.services import celery_broker_cleanup as cleanup


class DummyMessage:
    def __init__(self, delivery_tag: int, task_id: str | None) -> None:
        self.body = f"body-{delivery_tag}"
        self.headers = {"id": task_id} if task_id else {}
        self.properties = {
            "content_type": "application/json",
            "content_encoding": "utf-8",
            "application_headers": {"id": task_id} if task_id else {},
            "delivery_mode": 2,
            "correlation_id": task_id or f"corr-{delivery_tag}",
        }
        self.delivery_info = {
            "delivery_tag": delivery_tag,
            "exchange": "",
            "routing_key": "training",
        }


class DummyChannel:
    def __init__(self, messages: list[DummyMessage]) -> None:
        self.messages = list(messages)
        self.initial_count = len(messages)
        self.acked: list[int] = []
        self.rejected: list[tuple[int, bool]] = []
        self.published: list[dict] = []

    def queue_declare(self, queue: str, passive: bool):
        return SimpleNamespace(message_count=self.initial_count)

    def basic_get(self, queue: str, no_ack: bool):
        if not self.messages:
            return None
        return self.messages.pop(0)

    def basic_ack(self, delivery_tag: int) -> None:
        self.acked.append(delivery_tag)

    def basic_reject(self, delivery_tag: int, requeue: bool) -> None:
        self.rejected.append((delivery_tag, requeue))


class DummyProducer:
    def __init__(self, channel: DummyChannel) -> None:
        self.channel = channel

    def publish(self, body, **kwargs) -> None:
        self.channel.published.append({"body": body, **kwargs})


def test_message_task_id_prefers_header_id() -> None:
    message = DummyMessage(1, "header-id")
    message.properties["correlation_id"] = "correlation-id"

    assert cleanup._message_task_id(message) == "header-id"


def test_message_task_id_falls_back_to_correlation_id() -> None:
    message = DummyMessage(1, None)
    message.headers = {}
    message.properties["correlation_id"] = "correlation-id"

    assert cleanup._message_task_id(message) == "correlation-id"


def test_drop_ready_messages_acks_target_and_republishes_others(monkeypatch) -> None:
    monkeypatch.setattr(cleanup, "Producer", DummyProducer)
    channel = DummyChannel([
        DummyMessage(1, "keep-task"),
        DummyMessage(2, "drop-task"),
    ])

    dropped = cleanup._drop_ready_messages_from_queue(channel, "training", {"drop-task"})

    assert dropped == 1
    assert channel.acked == [1, 2]
    assert channel.rejected == []
    assert [item["body"] for item in channel.published] == ["body-1"]
    assert "application_headers" not in channel.published[0]
